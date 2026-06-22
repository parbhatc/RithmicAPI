import { bucketOpen, aggregateReplayOHLC, isUsablePrice } from "./forming-bar.js";
import { ONE_MINUTE_PERIOD } from "./candle-layer.js";
import { HistoryQuery } from "../HistoryQuery.js";

/**
 * Wrap {@link ChartSession} for {@link FormingBarManager} (experiment API surface).
 * @param {import("../sessions/chart/ChartSession.js").ChartSession} chart
 */
export function wrapChartSession(chart) {
  /** Pause live history pump so replay can read the history socket. */
  async function withHistoryReplay(fn) {
    const live = chart.planets?.live;
    const feed = chart.liveFeed;
    const paused = Boolean(live?.active);
    if (paused) live.pauseHistoryPump();
    feed?.beginHistoryReplay?.();
    try {
      return await fn();
    } finally {
      feed?.endHistoryReplay?.();
      if (paused) live.resumeHistoryPump();
    }
  }

  return {
    symbol: chart.symbol,
    exchange: chart.exchange,

    get status() {
      return chart.status;
    },

    on(event, fn) {
      chart.on(event, fn);
      return chart;
    },

    off(event, fn) {
      chart.off(event, fn);
    },

    async loadHistory(options = {}) {
      const {
        resolution = 1,
        from,
        to,
        countback,
        compat,
        timeoutMs,
        include_forming: _includeForming,
        ...rest
      } = options;
      return withHistoryReplay(async () => {
        const bars = await chart.planets.history.load({
          ...rest,
          resolution,
          from,
          to,
          countback,
          compat,
          timeoutMs,
          symbol: options.symbol ?? chart.symbol,
          exchange: options.exchange ?? chart.exchange,
        });
        if (
          compat &&
          bars?.length &&
          !HistoryQuery.isCalendarResolution(resolution)
        ) {
          const { periodSeconds } = HistoryQuery.parseResolution(resolution);
          return HistoryQuery.compatBars(bars, periodSeconds);
        }
        return bars;
      });
    },

    async loadTickHistory(options = {}) {
      return withHistoryReplay(() =>
        chart.planets.history.loadTick({
          ...options,
          symbol: options.symbol ?? chart.symbol,
          exchange: options.exchange ?? chart.exchange,
        }),
      );
    },

    async startLive(options = {}) {
      const { exactFormingBar: _e, exactBucketOpen: _b, ...liveOpts } = options;
      return chart.planets.live.start(liveOpts);
    },

    async stopLive() {
      return chart.planets.live.stop();
    },

    async replay1sInMinute(fromSec, toSec, { timeoutMs = 45_000 } = {}) {
      const marker = bucketOpen(Math.floor(fromSec), ONE_MINUTE_PERIOD);
      const to = Math.ceil(toSec);
      const span = Math.max(5, Math.min(to - marker + 5, ONE_MINUTE_PERIOD + 30));
      const bars1s = await withHistoryReplay(() =>
        chart.planets.history.load({
          resolution: "1S",
          from: marker,
          to: Math.min(to, marker + ONE_MINUTE_PERIOD),
          countback: Math.min(120, span + 5),
          timeoutMs,
        }),
      );
      return [...bars1s]
        .filter((b) => {
          const t = Number(b.marker);
          return Number.isFinite(t) && t >= marker && t < marker + ONE_MINUTE_PERIOD;
        })
        .sort((a, b) => Number(a.marker) - Number(b.marker));
    },

    async first1sBarInRange(fromSec, toSec, opts = {}) {
      const from = Math.floor(fromSec);
      const to = Math.floor(toSec);
      const span = Math.max(10, Math.min(opts.windowSeconds ?? 75, to - from + 5));
      const bars1s = await withHistoryReplay(() =>
        chart.planets.history.load({
          resolution: "1S",
          from,
          to: Math.min(to, from + span),
          countback: Math.min(120, span + 5),
          timeoutMs: opts.timeoutMs ?? 45_000,
        }),
      );
      return [...bars1s]
        .filter((b) => Number(b.marker) >= from)
        .sort((a, b) => Number(a.marker) - Number(b.marker))[0] ?? null;
    },

    async replay1mBarsFrom1s(fromSec, toSec, { timeoutMs = 45_000 } = {}) {
      const from = Math.floor(fromSec);
      const to = Math.ceil(toSec);
      const minuteFrom = bucketOpen(from, ONE_MINUTE_PERIOD);
      const span = Math.max(60, to - minuteFrom + 1);
      const countback = Math.min(900, span + 10);

      const bars1s = await withHistoryReplay(() =>
        chart.planets.history.load({
          resolution: "1S",
          from: minuteFrom,
          to,
          countback,
          timeoutMs,
        }),
      );

      const buckets = new Map();
      for (const b of bars1s) {
        const t = Number(b.marker);
        if (!Number.isFinite(t) || t < minuteFrom || t >= to) continue;
        const marker = bucketOpen(t, ONE_MINUTE_PERIOD);
        if (!buckets.has(marker)) buckets.set(marker, []);
        buckets.get(marker).push(b);
      }

      const out = [];
      for (const marker of [...buckets.keys()].sort((a, b) => a - b)) {
        const bar = aggregateReplayOHLC(buckets.get(marker), {
          marker,
          periodSeconds: ONE_MINUTE_PERIOD,
          symbol: chart.symbol,
          exchange: chart.exchange,
        });
        if (bar) out.push(bar);
      }
      return out;
    },

    async replay1mFrom1s(fromSec, toSec, opts = {}) {
      const bars = await this.replay1mBarsFrom1s(fromSec, toSec, opts);
      const target = bucketOpen(Math.floor(fromSec), ONE_MINUTE_PERIOD);
      return bars.find((b) => Number(b.marker) === target) ?? null;
    },

    async first1sOpenInRange(fromSec, toSec, { timeoutMs = 45_000, windowSeconds } = {}) {
      const first = await this.first1sBarInRange(fromSec, toSec, { timeoutMs, windowSeconds });
      const price = Number(first?.open ?? first?.close);
      return isUsablePrice(price) ? price : null;
    },
  };
}

const INSTRUMENT_EVENTS = new Set(["trade", "bar", "quote"]);

/**
 * Per-instrument view of a shared {@link ChartSession} (filters trade/bar/quote by symbol).
 * @param {import("../sessions/chart/ChartSession.js").ChartSession} chart
 * @param {{ symbol: string, exchange: string }} instrument
 */
export function wrapChartSessionForInstrument(chart, { symbol, exchange }) {
  const base = wrapChartSession(chart);
  /** @type {Map<string, Function>} */
  const wrapped = new Map();

  const matches = (data) => data?.symbol === symbol && data?.exchange === exchange;

  const withInstrument = (opts = {}) => ({ ...opts, symbol, exchange });

  return {
    symbol,
    exchange,

    get status() {
      const baseStatus = base.status;
      const trade = chart.liveFeed?.tradeFor(symbol, exchange);
      const last = Number(trade?.price);
      if (Number.isFinite(last)) {
        return { ...baseStatus, symbol, exchange, last, trade };
      }
      return { ...baseStatus, symbol, exchange };
    },

    on(event, fn) {
      if (!INSTRUMENT_EVENTS.has(event)) {
        return base.on(event, fn);
      }
      const wrapper = (data) => {
        if (matches(data)) fn(data);
      };
      wrapped.set(`${event}\0${fn}`, wrapper);
      chart.on(event, wrapper);
      return chart;
    },

    off(event, fn) {
      if (!INSTRUMENT_EVENTS.has(event)) {
        return base.off(event, fn);
      }
      const key = `${event}\0${fn}`;
      const wrapper = wrapped.get(key);
      if (wrapper) {
        chart.off(event, wrapper);
        wrapped.delete(key);
      }
    },

    loadHistory: (opts = {}) => base.loadHistory(withInstrument(opts)),
    loadTickHistory: (opts = {}) => base.loadTickHistory(withInstrument(opts)),
    startLive: (opts = {}) => base.startLive(opts),
    stopLive: () => base.stopLive(),
    replay1sInMinute: (fromSec, toSec, opts = {}) =>
      base.replay1sInMinute(fromSec, toSec, opts),
    first1sBarInRange: (fromSec, toSec, opts = {}) =>
      base.first1sBarInRange(fromSec, toSec, opts),
    replay1mBarsFrom1s: (fromSec, toSec, opts = {}) =>
      base.replay1mBarsFrom1s(fromSec, toSec, opts),
    replay1mFrom1s: (fromSec, toSec, opts = {}) => base.replay1mFrom1s(fromSec, toSec, opts),
    first1sOpenInRange: (fromSec, toSec, opts = {}) =>
      base.first1sOpenInRange(fromSec, toSec, opts),
  };
}
