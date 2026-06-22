import {
  ChartSession,
  HistoryQuery,
  MarketUpdatePreset,
  FormingBarManager,
  wrapChartSession,
} from "../../../../index.js";
import { bootstrapRithmicAccuracy } from "../../../../lib/forming/rithmic-accuracy.js";
import { calendarMarkerToUnix, unixToCalendarMarker } from "../../../../lib/marketViews.js";
import { loadRithmicEnv } from "./env.mjs";
import { toRithmicResolution } from "./resolutions.mjs";
import { CHART_RESOLUTIONS, resolutionSec, tickToMinmovPricescale } from "../resolutions.mjs";
import { normalizeRithmicSymbol, RITHMIC_SYMBOLS } from "./symbols.mjs";

function roundToTick(price, tick) {
  const p = Number(price);
  const t = Number(tick);
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return p;
  const n = Math.round(p / t);
  return Number((n * t).toFixed(12));
}

const HISTORY_CACHE_MS = 12_000;
const WS_OPEN = 1;

export class RithmicHub {
  #chart = null;
  #connectPromise = null;
  #liveInflight = null;
  #liveResolution = null;
  #liveActive = false;
  /** @type {Map<string, Set<(bar: object) => void>>} */
  #listeners = new Map();
  /** @type {Map<string, { at: number, bars: object[] }>} */
  #historyCache = new Map();
  /** @type {Map<string, Promise<object[]>>} */
  #historyInflight = new Map();
  /** @type {Map<string, number>} */
  #lastLiveMarker = new Map();
  /** @type {Map<string, object>} last closed bar sent to chart clients (symbol:resolution) */
  #lastChartBar = new Map();
  /** @type {Map<string, number>} last chart-time sec included in history payload */
  #lastHistoryChartTime = new Map();
  /** @type {Map<string, number>} last chart-time sent to stream clients */
  #lastSentChartTime = new Map();
  #onClosedBar = null;
  /** @type {FormingBarManager | null} */
  #formingManager = null;
  /** @type {{ res: string, promise: Promise<unknown> } | null} */
  #formingBootstrap = null;
  #formingLiveAttached = false;

  #usesForming(resolution) {
    return this.#udfResolution(String(resolution)) === "1";
  }

  #isSessionHealthy() {
    const history = this.#chart?.historyClient;
    const ticker = this.#chart?.tickerClient;
    return (
      history?.ws?.readyState === WS_OPEN &&
      ticker?.ws?.readyState === WS_OPEN
    );
  }

  #resetSession() {
    if (this.#liveActive) {
      void this.#chart?.planets?.live?.stop?.().catch(() => {});
    }
    this.#liveActive = false;
    this.#liveInflight = null;
    this.#liveResolution = null;
    this.#onClosedBar = null;
    void this.#formingManager?.detachLive().catch(() => {});
    this.#formingManager = null;
    this.#formingBootstrap = null;
    this.#formingLiveAttached = false;
    try {
      this.#chart?.close();
    } catch {
      /* closing */
    }
    this.#chart = null;
    this.#historyInflight.clear();
    this.#lastLiveMarker.clear();
    this.#lastChartBar.clear();
    this.#lastHistoryChartTime.clear();
    this.#lastSentChartTime.clear();
  }

  async #openSession() {
    loadRithmicEnv();
    const user = process.env.RITHMIC_USER;
    const password = process.env.RITHMIC_PASSWORD;
    if (!user || !password) {
      throw new Error("Set RITHMIC_USER and RITHMIC_PASSWORD in .env");
    }

    const symbol = normalizeRithmicSymbol(process.env.RITHMIC_SYMBOL ?? "NQ");
    const meta = RITHMIC_SYMBOLS[symbol] ?? {
      exchange: process.env.RITHMIC_EXCHANGE ?? "CME",
      tick: 0.25,
    };

    const t0 = performance.now();
    console.log(`[rithmic] connecting ${symbol}@${meta.exchange}…`);
    this.#chart = await ChartSession.open({
      user,
      password,
      systemName: process.env.RITHMIC_SYSTEM ?? "LucidTrading",
      symbol,
      exchange: meta.exchange,
      gatewayName: process.env.RITHMIC_GATEWAY,
      plants: { ticker: true, history: true, order: false, pnl: false },
    });
    console.log(`[rithmic] connected ${((performance.now() - t0) / 1000).toFixed(1)}s → ${this.#chart.uri}`);
  }

  async ensureSession() {
    if (this.#isSessionHealthy()) return;

    if (this.#connectPromise) {
      await this.#connectPromise;
      return;
    }

    this.#resetSession();
    this.#connectPromise = this.#openSession().finally(() => {
      this.#connectPromise = null;
    });

    try {
      await this.#connectPromise;
    } catch (err) {
      this.#resetSession();
      throw err;
    }
  }

  /** Closed TimeBar (250) + 1m forming via FormingBarManager (experiment port). */
  async ensureLive(resolution = "1") {
    await this.ensureSession();

    const udfRes = this.#udfResolution(String(resolution));
    if (this.#liveActive && this.#liveResolution === udfRes) {
      return;
    }

    if (this.#liveInflight) {
      await this.#liveInflight;
      if (this.#liveActive && this.#liveResolution === udfRes) {
        return;
      }
    }

    const job = this.#startLive(udfRes);
    this.#liveInflight = job;
    try {
      await job;
    } finally {
      if (this.#liveInflight === job) {
        this.#liveInflight = null;
      }
    }
  }

  async #startLive(udfRes) {
    const rithmicRes = toRithmicResolution(udfRes);
    const { barType, barTypePeriod } = HistoryQuery.parseResolution(rithmicRes);

    if (this.#liveActive) {
      await this.#chart.planets.live.stop();
      this.#liveActive = false;
      this.#liveResolution = null;
    }

    this.#wireLiveHandlers();

    if (this.#usesForming(udfRes)) {
      try {
        await this.#bootstrapForming(udfRes);
      } catch (err) {
        console.error("[rithmic] forming bootstrap failed:", err?.message ?? err);
      }
    }

    await this.#chart.planets.live.start({
      updateBits: MarketUpdatePreset.CHART,
      barType,
      barPeriod: barTypePeriod,
    });

    this.#liveActive = true;
    this.#liveResolution = udfRes;

    if (this.#usesForming(udfRes)) {
      try {
        await this.#attachFormingLive();
      } catch (err) {
        console.error("[rithmic] forming live attach failed:", err?.message ?? err);
      }
    }

    console.log(
      `[rithmic] subscribed ${this.symbol} ${udfRes} live` +
        (this.#usesForming(udfRes) && this.#formingLiveAttached
          ? " (closed + forming)"
          : " (closed only)"),
    );
  }

  async #bootstrapForming(udfRes) {
    if (!this.#chart) return;

    if (!this.#formingManager) {
      this.#formingManager = new FormingBarManager(wrapChartSession(this.#chart));
      this.#formingManager.on("formingBar", ({ resolution, bar }) => {
        if (resolution !== "1") return;
        this.#emitForming("1", bar);
      });
    }

    const stale =
      !this.#formingBootstrap ||
      this.#formingBootstrap.res !== udfRes;
    if (stale) {
      const useTradeSeaAccuracy = Boolean(process.env.TRADESEA_ACCESS_TOKEN);
      this.#formingBootstrap = {
        res: udfRes,
        promise: useTradeSeaAccuracy
          ? bootstrapRithmicAccuracy(this.#formingManager, {
              resolutions: [1],
              skipAttachLive: true,
              skipAttachTrades: true,
              timeoutMs: 120_000,
            })
          : this.#formingManager.bootstrap({
              resolutions: [1],
              fast: process.env.RITHMIC_FORMING_FAST !== "0",
              useCache: true,
            }),
      };
    }

    try {
      await this.#formingBootstrap.promise;
    } catch (err) {
      this.#formingBootstrap = null;
      throw err;
    }

    this.#publishCurrentForming("1");
  }

  async #attachFormingLive() {
    if (!this.#formingManager || this.#formingLiveAttached) return;
    await this.#formingManager.attachLive({ skipStartLive: true });
    this.#formingLiveAttached = true;
    this.#publishCurrentForming("1");
  }

  #publishCurrentForming(resolution) {
    const forming = this.#formingManager?.getForming(1);
    if (forming) this.#emitForming(resolution, forming);
  }

  #refreshFormingAfterClose() {
    if (!this.#formingManager || !this.#liveResolution) return;
    if (!this.#usesForming(this.#liveResolution)) return;
    const res = this.#liveResolution;
    const useTradeSeaAccuracy = Boolean(process.env.TRADESEA_ACCESS_TOKEN);
    this.#formingBootstrap = {
      res,
      promise: (async () => {
        if (useTradeSeaAccuracy) {
          await this.#formingManager.refreshCurrent1m(Math.floor(Date.now() / 1000));
        } else {
          await this.#formingManager.bootstrap({
            resolutions: [1],
            fast: true,
            useCache: true,
          });
        }
        this.#formingManager.syncFromLastTrade();
      })(),
    };
    void this.#formingBootstrap.promise
      .then(() => this.#publishCurrentForming(res))
      .catch((err) => {
        console.warn("[rithmic] forming refresh failed:", err?.message ?? err);
        this.#formingBootstrap = null;
      });
  }

  warmup() {
    void (async () => {
      try {
        await this.ensureSession();
      } catch (err) {
        console.error("[rithmic] warmup failed:", err?.message ?? err);
      }
    })();
  }

  isReady() {
    return this.#isSessionHealthy();
  }

  #wireLiveHandlers() {
    if (this.#onClosedBar) return;

    this.#onClosedBar = (bar) => {
      const res = this.#liveResolution ?? "1";
      const marker = Number(bar.marker ?? 0);
      if (marker) {
        const prev = this.#lastLiveMarker.get(res);
        if (marker !== prev) {
          this.#lastLiveMarker.set(res, marker);
          const out = this.#closedBarToChart(bar, res);
          console.log(
            `[rithmic] live ${res} new bar ${this.#fmtBarTime(out.time)} ET` +
              ` (marker ${this.#fmtBarTime(marker)})` +
              ` O=${out.open} H=${out.high} L=${out.low} C=${out.close}` +
              (out.volume != null ? ` V=${out.volume}` : ""),
          );
        }
      }
      if (!this.#liveResolution) return;
      this.#emitClosed(res, bar);
      if (this.#usesForming(res)) {
        this.#refreshFormingAfterClose();
      }
    };

    this.#chart.on("bar", this.#onClosedBar);
  }

  #udfResolution(rithmicRes) {
    const s = String(rithmicRes);
    if (s === "1D") return "D";
    if (s === "1W") return "W";
    if (s === "1M") return "M";
    return s;
  }

  #sendChartBar(key, resolution, out, fn, kind = "live") {
    const lastSent = this.#lastSentChartTime.get(key);
    if (lastSent != null && out.time < lastSent) return false;
    const cached = this.#lastChartBar.get(key);
    if (
      lastSent != null &&
      out.time === lastSent &&
      cached &&
      cached.open === out.open &&
      cached.high === out.high &&
      cached.low === out.low &&
      cached.close === out.close &&
      cached.volume === out.volume
    ) {
      return false;
    }
    this.#lastSentChartTime.set(key, out.time);
    fn(out);
    if (kind === "forming") {
      console.log(
        `[rithmic] live ${resolution} → chart forming ${this.#fmtBarTime(out.time)} ET` +
          ` O=${out.open} H=${out.high} L=${out.low} C=${out.close}`,
      );
    } else {
      console.log(
        `[rithmic] live ${resolution} → chart ${kind} ${this.#fmtBarTime(out.time)} ET` +
          ` O=${out.open} H=${out.high} L=${out.low} C=${out.close}`,
      );
    }
    return true;
  }

  #publishChartBar(key, resolution, out, kind = "live") {
    const set = this.#listeners.get(key);
    this.#lastChartBar.set(key, out);
    if (!set?.size) return;
    for (const fn of set) {
      this.#sendChartBar(key, resolution, out, fn, kind);
    }
  }

  #emitClosed(resolution, bar) {
    if (!bar) return;
    const key = `${this.symbol}:${resolution}`;
    const out = this.#closedBarToChart(bar, resolution);
    this.#publishChartBar(key, resolution, out, "closed");

    if (this.#usesForming(resolution)) {
      const marker = Number(bar.marker);
      if (marker) {
        const px = out.close;
        this.#emitForming(resolution, {
          marker,
          open: px,
          high: px,
          low: px,
          close: px,
          volume: 0,
          forming: true,
        });
      }
    }
  }

  #emitForming(resolution, formingBar) {
    if (!formingBar) return;
    const key = `${this.symbol}:${resolution}`;
    const out = this.#formingBarToChart(formingBar, resolution);
    this.#publishChartBar(key, resolution, out, "forming");
  }

  get symbol() {
    return normalizeRithmicSymbol(process.env.RITHMIC_SYMBOL ?? "NQ");
  }

  listSymbols() {
    return Object.entries(RITHMIC_SYMBOLS).map(([symbol, m]) => ({
      symbol,
      name: m.name,
      exchange: m.exchange,
      type: "futures",
      tick: m.tick,
    }));
  }

  resolveSymbol(sym) {
    const s = normalizeRithmicSymbol(sym);
    const meta = RITHMIC_SYMBOLS[s];
    if (!meta) return null;
    const tick = meta.tick ?? 0.25;
    const { minmov, pricescale } = tickToMinmovPricescale(tick);
    return {
      name: s,
      ticker: s,
      description: meta.name,
      type: "futures",
      exchange: meta.exchange,
      listed_exchange: meta.exchange,
      session: "1700-1600",
      timezone: "America/Chicago",
      minmov,
      pricescale,
      tick,
      minTick: tick,
      has_intraday: true,
      has_daily: true,
      has_weekly_and_monthly: true,
      supported_resolutions: CHART_RESOLUTIONS.map((r) => r.id),
      volume_precision: 0,
      data_status: "streaming",
      currency_code: "USD",
    };
  }

  #minTick(sym) {
    const s = normalizeRithmicSymbol(sym ?? this.symbol);
    return RITHMIC_SYMBOLS[s]?.tick ?? 0.25;
  }

  #normalizeOhlc(bar, tick) {
    return {
      ...bar,
      open: roundToTick(bar.open, tick),
      high: roundToTick(bar.high, tick),
      low: roundToTick(bar.low, tick),
      close: roundToTick(bar.close, tick),
    };
  }

  #fmtBarTime(sec) {
    return new Date(Number(sec) * 1000).toLocaleString("en-US", { timeZone: "America/New_York" });
  }

  #fmtCalendarMarker(marker) {
    const m = Number(marker);
    if (!Number.isFinite(m) || m < 19_000_000 || m > 30_000_000) return String(marker);
    const y = Math.floor(m / 10_000);
    const mo = Math.floor((m % 10_000) / 100);
    const d = m % 100;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  #alignCalendarToSec(unixSec) {
    const marker = unixToCalendarMarker(unixSec);
    return calendarMarkerToUnix(marker) ?? unixSec;
  }

  #logHistoryResult({
    resolution,
    bars,
    fromSec,
    toSec,
    countback,
    nowSec,
    elapsedMs,
    cachedAt,
  }) {
    const fetchedAt = cachedAt ?? Date.now();
    const src = cachedAt != null ? "cache" : "replay";
    const last = bars.at(-1);
    const lastT = last ? this.#chartTimeFromBar(last, resolution) : null;
    const lastMarker = last ? Number(last.marker) : null;
    const cal = HistoryQuery.isCalendarResolution(resolution);
    const toAgeMin = ((nowSec - toSec) / 60).toFixed(1);
    const lastLagMin = lastT != null ? ((nowSec - lastT) / 60).toFixed(1) : "—";

    console.log(
      `[rithmic] history ${resolution} ${bars.length} closed bars (${src}, ${(elapsedMs / 1000).toFixed(2)}s)\n` +
        `  fetched ${this.#fmtBarTime(Math.floor(fetchedAt / 1000))} ET  now ${this.#fmtBarTime(nowSec)} ET\n` +
        `  req from=${fromSec ?? "—"} to=${toSec} (to is ${toAgeMin}m behind now) countback=${countback ?? "—"}\n` +
        `  last bar ${lastT != null ? this.#fmtBarTime(lastT) : "—"} ET` +
        (lastMarker != null
          ? cal
            ? ` (marker ${this.#fmtCalendarMarker(lastMarker)})`
            : ` (marker ${this.#fmtBarTime(lastMarker)})`
          : "") +
        (last?.close != null ? ` C=${last.close}` : "") +
        ` (${lastLagMin}m before now, closed-only)`,
    );
  }

  /** Chart label — intraday compat: open time (value bar marker − period); calendar: Chicago midnight Unix. */
  #chartTimeFromBar(bar, resolution = "1") {
    if (HistoryQuery.isCalendarResolution(resolution)) {
      return HistoryQuery.chartBarTimeSec(bar);
    }
    return Number(bar.marker) - resolutionSec(resolution);
  }

  /** Forming bar — marker is bucket open (chart compat time). */
  #formingBarToChart(bar, resolution, tick = this.#minTick(this.symbol)) {
    const ohlc = this.#normalizeOhlc(bar, tick);
    return {
      time: Number(bar.marker),
      open: ohlc.open,
      high: ohlc.high,
      low: ohlc.low,
      close: ohlc.close,
      volume: bar.volume != null ? Number(bar.volume) : undefined,
    };
  }

  /** Closed live TimeBar — compat label (open time) with this bar's OHLC. */
  #closedBarToChart(bar, resolution, tick = this.#minTick(this.symbol)) {
    const ohlc = this.#normalizeOhlc(bar, tick);
    return {
      time: Number(bar.marker) - resolutionSec(resolution),
      open: ohlc.open,
      high: ohlc.high,
      low: ohlc.low,
      close: ohlc.close,
      volume: bar.volume != null ? Number(bar.volume) : undefined,
    };
  }

  #historyCacheKey(sym, resolution, from, to, countback) {
    return `${sym}:${resolution}:${from ?? ""}:${to ?? ""}:${countback ?? ""}`;
  }

  async loadHistory({ symbol, resolution, from, to, countback }) {
    await this.ensureSession();

    try {
      return await this.#fetchHistory({ symbol, resolution, from, to, countback });
    } catch (err) {
      if (!/not connected/i.test(String(err?.message ?? err))) throw err;
      console.warn("[rithmic] history plant disconnected — reconnecting…");
      this.#resetSession();
      await this.ensureSession();
      return this.#fetchHistory({ symbol, resolution, from, to, countback });
    }
  }

  async #fetchHistory({ symbol, resolution, from, to, countback }) {
    const sym = normalizeRithmicSymbol(symbol);
    if (!RITHMIC_SYMBOLS[sym]) throw new Error(`Unknown symbol: ${sym}`);

    const rithmicRes = toRithmicResolution(resolution);
    const nowSec = Math.floor(Date.now() / 1000);
    const toRaw = to != null ? Number(to) : null;
    const isCalendar = HistoryQuery.isCalendarResolution(resolution);
    // Scroll-back sends `to` in the past — must not clamp up to now (that repeats the same tail).
    let toSec = toRaw != null ? Math.min(toRaw, nowSec) : nowSec;
    // Live tail: chart `to` is often the forming bar open — anchor replay on now for newest closed bars.
    const isLiveTail =
      countback != null && toRaw != null && toRaw >= nowSec - 120;
    if (isLiveTail) {
      toSec = nowSec;
    }
    if (isCalendar) {
      toSec = this.#alignCalendarToSec(toSec);
    }
    const fromRaw = from != null ? Number(from) : null;
    const cb =
      countback != null
        ? Number(countback)
        : HistoryQuery.effectiveHistoryCountback({
            from: fromRaw ?? undefined,
            to: toSec,
            countback: 300,
            resolutionSec: resolutionSec(resolution),
          });
    // countback + `to` anchors replay on `to`; only use `from` for explicit range (no countback).
    const replayFrom = countback != null ? undefined : fromRaw ?? undefined;
    const reqFrom = fromRaw ?? undefined;

    const cacheKey = this.#historyCacheKey(sym, resolution, replayFrom, toSec, cb);
    const cached = this.#historyCache.get(cacheKey);
    if (cached && Date.now() - cached.at < HISTORY_CACHE_MS) {
      this.#logHistoryResult({
        resolution,
        bars: cached.bars,
        fromSec: reqFrom,
        toSec,
        countback: cb,
        nowSec,
        elapsedMs: 0,
        cachedAt: cached.at,
      });
      return cached.bars;
    }

    const inflight = this.#historyInflight.get(cacheKey);
    if (inflight) return inflight;

    const job = (async () => {
      const t0 = performance.now();
      const live = this.#chart?.planets?.live;
      const pausedLive = Boolean(live?.active);
      if (pausedLive) live.pauseHistoryPump();
      let bars;
      try {
        bars = await this.#chart.planets.history.load({
          resolution: rithmicRes,
          from: replayFrom,
          to: toSec,
          countback: cb,
          compat: !HistoryQuery.isCalendarResolution(resolution),
          timeoutMs: 45_000,
        });
      } finally {
        if (pausedLive) live.resumeHistoryPump();
      }

      const tick = this.#minTick(sym);
      bars = bars.map((b) => this.#normalizeOhlc(b, tick));

      this.#historyCache.set(cacheKey, { at: Date.now(), bars });
      this.#logHistoryResult({
        resolution,
        bars,
        fromSec: reqFrom,
        toSec,
        countback: cb,
        nowSec,
        elapsedMs: performance.now() - t0,
      });
      return bars;
    })();

    this.#historyInflight.set(cacheKey, job);
    try {
      return await job;
    } finally {
      this.#historyInflight.delete(cacheKey);
    }
  }

  async ensureFormingReady(resolution = "1") {
    if (!this.#usesForming(resolution)) return;
    if (this.#formingBootstrap?.promise) {
      try {
        await this.#formingBootstrap.promise;
      } catch {
        /* bootstrap failed — history tail falls back to closed only */
      }
    }
  }

  historyPayload({ bars, resolution = "1", mergeLive = true }) {
    const cal = HistoryQuery.isCalendarResolution(resolution);
    const udfRes = this.#udfResolution(resolution);
    const key = `${this.symbol}:${udfRes}`;
    const payload = HistoryQuery.barsToHistoryPayload(bars, {
      timeOffset: 0,
      compat: !cal,
      periodSeconds: resolutionSec(resolution),
    });

    if (mergeLive && !cal) {
      let live = this.#lastChartBar.get(key);
      if (this.#usesForming(udfRes) && this.#formingManager) {
        const forming = this.#formingManager.getForming(1);
        if (forming) {
          live = this.#formingBarToChart(forming, udfRes);
        }
      }
      const lastT = payload.t.at(-1);
      if (live?.time && lastT != null && live.time > lastT) {
        payload.t.push(live.time);
        payload.o.push(live.open);
        payload.h.push(live.high);
        payload.l.push(live.low);
        payload.c.push(live.close);
        payload.v.push(live.volume ?? 0);
      } else if (live?.time && lastT != null && live.time === lastT) {
        const i = payload.t.length - 1;
        payload.o[i] = live.open;
        payload.h[i] = live.high;
        payload.l[i] = live.low;
        payload.c[i] = live.close;
        payload.v[i] = live.volume ?? 0;
      }
    }

    const tail = payload.t.at(-1);
    if (tail != null) {
      this.#lastHistoryChartTime.set(key, tail);
    }

    return payload;
  }

  subscribe(symbol, resolution, fn) {
    const sym = normalizeRithmicSymbol(symbol);
    const udfRes = this.#udfResolution(resolution);
    const key = `${sym}:${udfRes}`;
    if (!this.#listeners.has(key)) this.#listeners.set(key, new Set());
    this.#listeners.get(key).add(fn);

    queueMicrotask(() => {
      try {
        let out = null;
        if (this.#usesForming(udfRes) && this.#formingManager) {
          const forming = this.#formingManager.getForming(1);
          if (forming) out = this.#formingBarToChart(forming, udfRes);
        }
        if (!out) {
          const cached = this.#lastChartBar.get(key);
          const lastHist = this.#lastHistoryChartTime.get(key);
          if (cached?.time && (lastHist == null || cached.time > lastHist)) {
            out = cached;
          }
        }
        if (out) this.#sendChartBar(key, udfRes, out, fn, out === this.#lastChartBar.get(key) ? "live" : "forming");
      } catch {
        /* client disconnected */
      }
    });

    void this.ensureLive(udfRes).catch((err) => {
      console.error(`[rithmic] live ${udfRes} failed:`, err?.message ?? err);
    });

    return () => {
      this.#listeners.get(key)?.delete(fn);
    };
  }
}

export const rithmicHub = new RithmicHub();
