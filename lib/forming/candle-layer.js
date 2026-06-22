import {
  bucketOpen,
  splitHistoryForForming,
  aggregateReplayOHLC,
  applyTradeToFormingBar,
  applyBucketOpen,
  mergeBarIntoSeries,
  isUsablePrice,
} from "./forming-bar.js";
import { parseResolution } from "./history-query.js";
import { tickBarTime } from "./market-views.js";

export const ONE_MINUTE_PERIOD = 60;
export const ONE_HOUR_PERIOD = 3600;
export const TWO_HOUR_PERIOD = 7200;

/** Stable key for maps (`15`, `1D`, `100T`). */
export function resolutionKey(resolution) {
  return String(resolution).trim().toUpperCase();
}

/** Seconds chart (`5S` ΓÇª `45S`) or tick chart (`100T`) ΓÇö isolated from the 1m canonical layer. */
export function isIsolatedResolution(resolution) {
  const raw = resolutionKey(resolution);
  if (/^\d+T$/.test(raw)) return true;
  const m = /^(\d+)S$/.exec(raw);
  if (m) return Number(m[1]) < ONE_MINUTE_PERIOD;
  return false;
}

/** Minute+ timeframes (includes `1`, `1D`, `1W`, `1M`). */
export function isCanonicalResolution(resolution) {
  return !isIsolatedResolution(resolution);
}

/** HTF period in seconds, or null for tick/seconds. */
export function periodSecondsFor(resolution) {
  if (!isCanonicalResolution(resolution)) return null;
  return parseResolution(resolution).periodSeconds;
}

/**
 * 1m bars needed to cover the open HTF bucket(s) only.
 * @param {(number|string)[]} alsoFor
 * @param {number} [nowSec]
 */
export function countback1mTail(alsoFor, nowSec = Math.floor(Date.now() / 1000)) {
  let need = 5;
  for (const r of alsoFor) {
    const ps = periodSecondsFor(r);
    if (ps == null || ps <= ONE_MINUTE_PERIOD) continue;
    const bucket = bucketOpen(nowSec, ps);
    need = Math.max(need, Math.ceil((nowSec - bucket) / ONE_MINUTE_PERIOD) + 3);
  }
  return need;
}

/** Full 1m countback when not using native HTF + tail mode. */
export function countback1mForResolutions(resolutions, { min = 300 } = {}) {
  let need = min;
  for (const r of resolutions) {
    const ps = periodSecondsFor(r);
    if (ps != null && ps >= ONE_MINUTE_PERIOD) {
      need = Math.max(need, Math.ceil(ps / ONE_MINUTE_PERIOD) + 10);
    }
  }
  return need;
}

/** 1m rows with `marker` in `[bucket, bucket + periodSeconds)`. */
export function oneMinuteInBucket(closed1m, forming1m, bucket, periodSeconds) {
  const end = bucket + periodSeconds;
  const rows = (closed1m ?? []).filter((b) => {
    const m = Number(b.marker);
    return m >= bucket && m < end;
  });
  if (
    forming1m &&
    Number(forming1m.marker) >= bucket &&
    Number(forming1m.marker) < end
  ) {
    rows.push(forming1m);
  }
  return rows.sort((a, b) => Number(a.marker) - Number(b.marker));
}

export function aggregateFrom1m(
  oneMinuteBars,
  { marker, periodSeconds, symbol, exchange } = {},
) {
  return aggregateReplayOHLC(oneMinuteBars, {
    marker,
    periodSeconds,
    symbol,
    exchange,
  });
}

export function patch1mBarOpen(closed1m, marker, open) {
  const m = Number(marker);
  const i = closed1m.findIndex((b) => Number(b.marker) === m);
  if (i < 0) return false;
  closed1m[i] = applyBucketOpen({ ...closed1m[i] }, open);
  return true;
}

/** Replace closed 1m rows when tick replay has a better OHLC for that minute. */
export function mergeRefined1m(closed1m, refinedBars) {
  const byMarker = new Map(refinedBars.map((b) => [Number(b.marker), b]));
  return closed1m.map((b) => byMarker.get(Number(b.marker)) ?? b);
}

export function deriveFormingFrom1m(
  closed1m,
  forming1m,
  periodSeconds,
  { nowSec, symbol, exchange, htfBucketOpen } = {},
) {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const bucket = bucketOpen(now, periodSeconds);
  const rows = oneMinuteInBucket(closed1m, forming1m, bucket, periodSeconds);
  let bar = aggregateFrom1m(rows, {
    marker: bucket,
    periodSeconds,
    symbol: symbol ?? forming1m?.symbol ?? rows[0]?.symbol,
    exchange: exchange ?? forming1m?.exchange ?? rows[0]?.exchange,
  });
  if (!bar) return null;

  const open =
    htfBucketOpen != null && periodSeconds > ONE_MINUTE_PERIOD
      ? htfBucketOpen
      : null;
  if (isUsablePrice(open)) {
    bar = { ...bar, open: Number(open) };
  }

  const src = isUsablePrice(open) ? "1m-derived+tick-bucket-open" : "1m-derived";
  return { ...bar, forming: true, replaySource: src };
}

export function deriveClosedFrom1m(
  closed1m,
  periodSeconds,
  { nowSec, symbol, exchange } = {},
) {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const currentBucket = bucketOpen(now, periodSeconds);
  const buckets = new Map();

  for (const bar of closed1m ?? []) {
    const b = bucketOpen(Number(bar.marker), periodSeconds);
    if (b >= currentBucket) continue;
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(bar);
  }

  const out = [];
  for (const marker of [...buckets.keys()].sort((a, b) => a - b)) {
    const agg = aggregateFrom1m(buckets.get(marker), {
      marker,
      periodSeconds,
      symbol,
      exchange,
    });
    if (agg) out.push({ ...agg, forming: false, replaySource: "1m-derived" });
  }
  return out;
}

/**
 * Canonical store:
 * - Completed HTF bars ΓåÆ native Rithmic replay (`loadHistory` at that resolution)
 * - Open HTF bucket ΓåÆ 1m replay from bucket open ΓåÆ now only, then rollup
 * - Live ΓåÆ ticks update forming 1m only
 */
export class CandleLayer {
  #session;
  #closed1m = [];
  #forming1m = null;
  #seedOpen1m = null;
  /** @type {Map<string, object[]>} Native completed bars per resolution key */
  #closedNative = new Map();
  /** @type {Map<number, number>} HTF periodSeconds ΓåÆ tick open at bucket start minute */
  #htfBucketOpen = new Map();
  #includeForming = false;
  #useNativeHtf = false;
  #tail1mFrom = null;

  constructor(session) {
    this.#session = session;
  }

  get session() {
    return this.#session;
  }

  get closed1m() {
    return this.#closed1m;
  }

  get forming1m() {
    return this.#forming1m;
  }

  /** Latest completed native bar for a resolution (e.g. 15m @ 4:15 when now is 4:37). */
  getLatestCompletedNative(resolution) {
    const bars = this.#closedNative.get(resolutionKey(resolution));
    return bars?.length ? bars.at(-1) : null;
  }

  /**
   * @param {object} [options]
   * @param {number} [options.countback] Native HTF countback (default 50)
   * @param {(number|string)[]} [options.alsoFor] e.g. `[15]` ΓåÆ native 15m completed + 1m tail for 4:30+
   * @param {boolean} [options.include_forming=false]
   * @param {boolean} [options.tickOpen=true]
   * @param {boolean} [options.profile=false]
   */
  async load1m({
    countback = 50,
    alsoFor = [],
    include_forming = false,
    tickOpen = true,
    profile = false,
    timeoutMs = 45_000,
  } = {}) {
    const t0 = performance.now();
    const timings = {};
    const lap = (key) => {
      timings[key] = Math.round(performance.now() - t0);
    };

    this.#includeForming = include_forming;
    this.#closedNative.clear();
    this.#htfBucketOpen.clear();
    this.#useNativeHtf = false;
    this.#tail1mFrom = null;

    const nowSec = Math.floor(Date.now() / 1000);
    let partial1m = null;
    const htfTargets = alsoFor.filter((r) => {
      const ps = periodSecondsFor(r);
      return ps != null && ps > ONE_MINUTE_PERIOD;
    });

    if (htfTargets.length > 0) {
      this.#useNativeHtf = true;
      let tailStart = nowSec;

      for (const res of htfTargets) {
        const key = resolutionKey(res);
        const native = await this.#session.loadHistory({
          resolution: res,
          countback,
          include_forming: false,
          compat: false,
        });
        this.#closedNative.set(
          key,
          native.map((b) => ({ ...b, forming: false, replaySource: "rithmic-native" })),
        );

        const ps = periodSecondsFor(res);
        const openBucket = bucketOpen(nowSec, ps);
        tailStart = Math.min(tailStart, openBucket);
      }
      lap("loadHistoryHtfCompleted_ms");

      this.#tail1mFrom = tailStart;
      const tailCount = countback1mTail(htfTargets, nowSec);
      const history1m = await this.#session.loadHistory({
        resolution: 1,
        from: tailStart,
        to: nowSec + 120,
        countback: tailCount,
        compat: false,
      });
      lap("loadHistory1mTail_ms");
      timings.countback1mTail = tailCount;

      const split = splitHistoryForForming(history1m, ONE_MINUTE_PERIOD, nowSec);
      this.#closed1m = split.closed;
      partial1m = split.partial;
    } else {
      const n = countback ?? countback1mForResolutions([1, ...alsoFor]);
      const history = await this.#session.loadHistory({
        resolution: 1,
        countback: n,
        compat: false,
      });
      lap("loadHistory1m_ms");
      timings.countback1mFull = n;

      const split = splitHistoryForForming(history, ONE_MINUTE_PERIOD, nowSec);
      this.#closed1m = split.closed;
      partial1m = split.partial;

      if (tickOpen) {
        const first = split.closed[0];
        this.#tail1mFrom = first
          ? Number(first.marker)
          : bucketOpen(nowSec - n * ONE_MINUTE_PERIOD);
      }
    }

    this.#forming1m = null;
    this.#seedOpen1m = null;

    const current1mOpen = bucketOpen(nowSec, ONE_MINUTE_PERIOD);
    let refinedTail = [];

    if (tickOpen && this.#tail1mFrom != null) {
      const tRefine = performance.now();
      refinedTail = await this.#session.replay1mBarsFrom1s(
        this.#tail1mFrom,
        nowSec + 120,
        { timeoutMs },
      );
      timings.refine1mTailFrom1s_ms = Math.round(performance.now() - tRefine);

      const closedRefined = refinedTail.filter(
        (b) => Number(b.marker) < current1mOpen,
      );
      if (closedRefined.length) {
        this.#closed1m = mergeRefined1m(this.#closed1m, closedRefined);
      }

      for (const res of htfTargets) {
        const ps = periodSecondsFor(res);
        const htfBucket = bucketOpen(nowSec, ps);
        const first = refinedTail.find((b) => Number(b.marker) === htfBucket);
        if (first && isUsablePrice(first.open)) {
          this.#htfBucketOpen.set(ps, Number(first.open));
        }
      }

      const partialRefined = refinedTail.find(
        (b) => Number(b.marker) === current1mOpen,
      );
      if (partialRefined) partial1m = partialRefined;
    }

    if (include_forming) {
      const tSeed = performance.now();
      const curRefined = refinedTail.find(
        (b) => Number(b.marker) === current1mOpen,
      );
      if (tickOpen && curRefined) {
        this.#forming1m = { ...curRefined, forming: true };
      } else {
        this.#forming1m = await this.#session.seedForming1m({
          partial1m,
          priorClose: this.#closed1m.at(-1)?.close,
          tickOpen,
          timeoutMs,
        });
      }
      timings.seedForming1m_ms = Math.round(performance.now() - tSeed);
      this.#seedOpen1m = this.#forming1m?.open ?? null;
    }

    timings.load1m_total_ms = Math.round(performance.now() - t0);

    return {
      closed1m: this.#closed1m,
      forming1m: this.#forming1m,
      partial1m,
      include_forming,
      useNativeHtf: this.#useNativeHtf,
      tail1mFrom: this.#tail1mFrom,
      countback1m: this.#useNativeHtf
        ? timings.countback1mTail ?? this.#closed1m.length
        : timings.countback1mFull ?? this.#closed1m.length,
      closedNative: Object.fromEntries(this.#closedNative),
      ...(profile ? { timings } : {}),
    };
  }

  getClosed(resolution) {
    const key = resolutionKey(resolution);
    if (key === "1" || resolution === 1) {
      return [...this.#closed1m];
    }
    if (this.#closedNative.has(key)) {
      return [...this.#closedNative.get(key)];
    }
    const ps = periodSecondsFor(resolution);
    if (ps == null) return [];
    return deriveClosedFrom1m(this.#closed1m, ps, {
      symbol: this.#session.symbol,
      exchange: this.#session.exchange,
    });
  }

  getForming(resolution) {
    if (!this.#includeForming) return null;
    const key = resolutionKey(resolution);
    if (key === "1" || resolution === 1) {
      return this.#forming1m ? { ...this.#forming1m } : null;
    }
    const ps = periodSecondsFor(resolution);
    if (ps == null) return null;
    return deriveFormingFrom1m(this.#closed1m, this.#forming1m, ps, {
      symbol: this.#session.symbol,
      exchange: this.#session.exchange,
      htfBucketOpen: this.#htfBucketOpen.get(ps),
    });
  }

  getSeries(resolution) {
    const closed = this.getClosed(resolution);
    const forming = this.getForming(resolution);
    if (!forming) return closed;
    return mergeBarIntoSeries(closed, forming);
  }

  onTrade(trade) {
    const next = applyTradeToFormingBar(this.#forming1m, trade, {
      periodSeconds: ONE_MINUTE_PERIOD,
      symbol: this.#session.symbol,
      exchange: this.#session.exchange,
      seedOpen: this.#seedOpen1m,
    });
    if (next) {
      this.#forming1m = next;
      if (isUsablePrice(next.open)) this.#seedOpen1m = next.open;
    }
  }

  on1mBarClose(closedBar) {
    const m = Number(closedBar.marker);
    this.#closed1m = mergeBarIntoSeries(
      this.#closed1m.filter((b) => Number(b.marker) !== m),
      { ...closedBar, forming: false },
    );
    const now = Math.floor(Date.now() / 1000);
    const open = bucketOpen(now, ONE_MINUTE_PERIOD);
    if (m === open) {
      this.#forming1m = null;
      this.#seedOpen1m = null;
    }
  }

  bindTrades(chart = this.#session) {
    const handler = (trade) => this.onTrade(trade);
    chart.on("trade", handler);
    return () => chart.off("trade", handler);
  }
}
