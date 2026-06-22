import { EventEmitter } from "node:events";
import {
  bucketOpen,
  chartBucketOpen,
  isCalendarResolution,
  splitHistoryForForming,
  aggregateReplayOHLC,
  applyBucketOpen,
  applyTradeToFormingBar,
  calendarBarUnix,
  chartBucketRithmicMarker,
  isUsablePrice,
  chicagoGlobexSessionOpen,
  tradeseaMinuteOpenFrom1s,
  tradeseaMinuteFormingFrom1s,
  tradeseaActive1sBars,
} from "./forming-bar.js";
import { parseResolution } from "./history-query.js";
import { MarketUpdatePreset } from "./market-enums.js";
import { ONE_MINUTE_PERIOD, ONE_HOUR_PERIOD, TWO_HOUR_PERIOD, resolutionKey, patch1mBarOpen } from "./candle-layer.js";
import { fmt1mBar, log1m, log1mBars, log1mBuild, fmtSec, fmtSubBar } from "./forming-1m-debug.js";
import {
  planFormingBootstrap,
  classifyFormingResolution,
  NATIVE_PARTIAL_FROM_SEC,
} from "./forming-strategy.js";
import { aggregatePartialTickForming } from "./forming-reconstruct.js";
import { tickBarTime } from "./market-views.js";
import { ReplayDirection, ReplayTimeOrder } from "./market-enums.js";
import {
  resolveTradeSeaWeeklyAdjust,
  shiftBarOHLC,
} from "./tradesea-week-adjust.js";
import { FormingBootstrapCache } from "./forming-cache.js";

/**
 * Universal forming-candle manager ΓÇö one plan, minimal history requests.
 *
 * | Type | Examples | Bootstrap (per chart) | Live |
 * |------|----------|----------------------|------|
 * | 1m | 1 | **1s** ΓåÆ 1m + shared 1m fetch | LastTrade |
 * | Minutes+ | 2, 5, 15, 60, 240, 1D | **1 shared** 1m fetch ΓåÆ rollup | LastTrade |
 * | Week/Month | 1W, 1M | **1 shared** 1D fetch ΓåÆ rollup | LastTrade |
 * | Year | 1Y | **1 shared** 1M fetch ΓåÆ rollup | LastTrade |
 * | Seconds | 5S, 15S, 45S | **1 tick window per period** | LastTrade |
 * | Tick | 100T, 500T | **1 tick replay per size** | LastTrade |
 *
 * ```javascript
 * await mgr.bootstrap({ resolutions: [1, 15, 60, "1D", "5S", "100T"] });
 * console.log(mgr.plan.requestCount); // e.g. 5 requests, not hundreds
 * ```
 */
export class FormingBarManager extends EventEmitter {
  #session;
  /** @type {Map<string, ReturnType<classifyFormingResolution>>} */
  #classes = new Map();
  /** @type {Map<string, number|null>} periodSeconds per key (null = tick bar) */
  #targets = new Map();
  /** @type {Map<string, number|null>} tickSize for tick-bar-partial */
  #tickSizes = new Map();
  #closed1m = [];
  #partial1m = null;
  #closed1h = [];
  #partial1h = null;
  /** @type {Map<string, object|null>} */
  #forming = new Map();
  /** @type {Map<string, number>} tick trade count in open bucket */
  #tickCounts = new Map();
  /** @type {Map<string, number|string>} raw resolution per key */
  #resolutionByKey = new Map();
  #unbind = null;
  #live = false;
  #weeklyPriceAdjust = null;
  #tradeSeaAccessToken = null;
  /** @type {ReturnType<planFormingBootstrap>|null} */
  plan = null;
  /** @type {{ daily: object[]|null, monthly: object[]|null, nativeWeeklyClose: number|null }} */
  #scratch = { daily: null, monthly: null, nativeWeeklyClose: null };
  /** @type {FormingBootstrapCache} */
  #cache = FormingBootstrapCache.global();
  #useCache = true;
  #fast = false;
  #accuracyMode = false;
  #skipStopLive = false;
  #refine1mOpenInflight = false;
  #lastRefine1mOpenAt = 0;
  /** @type {Map<number, object[]>} trades buffered per 1m bucket while live */
  #buffered1mTrades = new Map();

  constructor(session) {
    super();
    this.#session = session;
  }

  get session() {
    return this.#session;
  }

  get closed1m() {
    return this.#closed1m;
  }

  get resolutions() {
    return [...this.#targets.keys()];
  }

  /**
   * @param {object} [options]
   * @param {(number|string)[]} [options.resolutions]
   * @param {number} [options.nowSec]
   * @param {number} [options.timeoutMs=45000]
   * @param {boolean} [options.tickFallback=true] Refine open 1m minute from 1s bars if history lags
   * @param {number} [options.weeklyPriceAdjust] TradeSea weekly offset (auto-fetched when token set)
   * @param {string} [options.tradeSeaAccessToken] TradeSea cookie token for weekly offset
   * @param {boolean} [options.fast=false] Skip tick refine; overlap live attach with replay
   * @param {boolean} [options.useCache=true] Reuse recent replay results (same symbol/minute)
   * @param {FormingBootstrapCache} [options.cache] Cache instance (default: global)
   * @param {boolean} [options.prefetchLive=false] Start live feed during bootstrap
   * @param {'default'|'tradesea'} [options.accuracy='default'] `tradesea` = max Rithmic parity (no runtime TS MDS)
   */
  async bootstrap({
    resolutions = [15],
    nowSec = Math.floor(Date.now() / 1000),
    timeoutMs = 45_000,
    tickFallback = true,
    weeklyPriceAdjust = null,
    tradeSeaAccessToken = process.env.TRADESEA_ACCESS_TOKEN,
    fast = false,
    useCache = true,
    cache = FormingBootstrapCache.global(),
    prefetchLive = false,
    accuracy = "default",
  } = {}) {
    this.#targets.clear();
    this.#classes.clear();
    this.#tickSizes.clear();
    this.#resolutionByKey.clear();
    this.#forming.clear();
    this.#tickCounts.clear();
    this.#closed1m = [];
    this.#partial1m = null;
    this.#closed1h = [];
    this.#partial1h = null;
    this.#weeklyPriceAdjust = weeklyPriceAdjust;
    this.#tradeSeaAccessToken = tradeSeaAccessToken ?? null;
    this.#cache = cache;
    this.#useCache = useCache;
    this.#fast = fast;
    this.#scratch = { daily: null, monthly: null, nativeWeeklyClose: null };
    this.#accuracyMode = accuracy === "tradesea";

    if (accuracy === "tradesea") {
      fast = false;
      tickFallback = true;
      if (weeklyPriceAdjust == null && process.env.TRADESEA_WEEKLY_ADJUST != null) {
        weeklyPriceAdjust = Number(process.env.TRADESEA_WEEKLY_ADJUST);
      }
    }

    const tickFallbackEffective = fast ? false : tickFallback;

    this.plan = planFormingBootstrap(resolutions, nowSec);

    if (accuracy === "tradesea" && this.#needsSession1mTickRefine(resolutions)) {
      const sessionFrom = chicagoGlobexSessionOpen(nowSec);
      for (const req of this.plan.requests) {
        if (req.type !== "1m-shared") continue;
        req.from = Math.min(req.from, sessionFrom);
        req.countback = Math.max(
          req.countback,
          Math.ceil((nowSec - req.from) / ONE_MINUTE_PERIOD) + 3,
        );
      }
    }
    const bucketOpens = {};

    for (const c of this.plan.classes) {
      this.#classes.set(c.key, c);
      this.#targets.set(c.key, c.periodSeconds);
      this.#resolutionByKey.set(c.key, c.resolution);
      if (c.tickSize != null && c.mode === "tick-bar-partial") {
        this.#tickSizes.set(c.key, c.tickSize);
      }
      if (c.periodSeconds != null) {
        bucketOpens[c.key] = isCalendarResolution(c.resolution)
          ? chartBucketOpen(nowSec, c.resolution)
          : bucketOpen(nowSec, c.periodSeconds);
      }
    }

    const requests = this.#sortBootstrapRequests(this.plan.requests);

    for (const req of requests) {
      switch (req.type) {
        case "1m-shared":
          await this.#run1mShared(req, nowSec, timeoutMs, tickFallbackEffective);
          break;
        case "1h-shared":
          await this.#run1hShared(req, nowSec, timeoutMs, tradeSeaAccessToken);
          break;
        case "1D-shared":
          await this.#runDailyShared(req, nowSec, timeoutMs, tradeSeaAccessToken);
          break;
        case "1M-shared":
          await this.#runMonthlyShared(req, nowSec, timeoutMs);
          break;
        case "native-partial":
          await this.#runNativePartial(req, nowSec, timeoutMs, tradeSeaAccessToken);
          break;
        case "tick-window":
          await this.#runTickWindow(req, nowSec, timeoutMs);
          break;
        case "tick-bar-partial":
          await this.#runTickBarPartial(req, nowSec, timeoutMs);
          break;
        default:
          break;
      }
    }

    if (prefetchLive && !this.#live) {
      await this.attachLive({ updateBits: MarketUpdatePreset.QUOTE }).catch(() => {});
    }
    await this.#overlaySessionRangeForHourly();

    if (this.#accuracyMode) {
      await this.#applyTradeSeaSessionCalendar(nowSec, timeoutMs);
      await this.#refineFormingExtremesFromTicks(nowSec, timeoutMs);
      await this.#applyTradeSea4hHighFromNativeHourly(nowSec, timeoutMs);
    }

    return {
      plan: this.plan,
      closed1m: this.#closed1m,
      partial1m: this.#partial1m,
      forming: new Map(this.#forming),
      bucketOpens,
    };
  }

  #sortBootstrapRequests(requests) {
    const typeOrder = {
      "1m-shared": 0,
      "1h-shared": 1,
      "1D-shared": 2,
      "1M-shared": 3,
      "native-partial": 4,
      "tick-window": 5,
      "tick-bar-partial": 6,
    };
    const dailyOrder = { "1W": 0, "1M": 1 };

    return [...requests].sort((a, b) => {
      const ta = typeOrder[a.type] ?? 9;
      const tb = typeOrder[b.type] ?? 9;
      if (ta !== tb) return ta - tb;
      if (a.type === "1D-shared" && b.type === "1D-shared") {
        const ra = dailyOrder[String(a.serves?.[0]).toUpperCase()] ?? 9;
        const rb = dailyOrder[String(b.serves?.[0]).toUpperCase()] ?? 9;
        return ra - rb;
      }
      return 0;
    });
  }

  getForming(resolution) {
    const bar = this.#forming.get(resolutionKey(resolution));
    return bar ? { ...bar } : null;
  }

  /**
   * Overwrite forming OHLC from TradeSea (UDF or MDS f:5). Source of truth for TradeSea match.
   * @returns {object|null} applied bar copy
   */
  applyTradeSeaForming(
    resolution,
    { marker, open, high, low, close, volume, replaySource = "tradesea-mds" },
  ) {
    const key = resolutionKey(resolution);
    const { periodSeconds } = parseResolution(resolution);

    const bar = {
      marker: Number(marker),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: volume != null ? Number(volume) : undefined,
      period: periodSeconds != null ? String(periodSeconds) : undefined,
      forming: true,
      replaySource,
      symbol: this.#session.symbol,
      exchange: this.#session.exchange,
    };

    this.#forming.set(key, bar);
    if (!this.#resolutionByKey.has(key)) {
      this.#resolutionByKey.set(key, resolution);
      this.#targets.set(key, periodSeconds);
    }
    this.emit("formingBar", { resolution: key, bar });
    return { ...bar };
  }

  getAllForming() {
    const out = {};
    for (const [key, bar] of this.#forming) {
      if (bar) out[key] = { ...bar };
    }
    return out;
  }

  onTrade(trade) {
    const changed = new Map();
    for (const [key, periodSeconds] of this.#targets) {
      const cls = this.#classes.get(key);
      const tickSize = this.#tickSizes.get(key);

      if (cls?.mode === "tick-bar-partial" && tickSize) {
        const next = this.#applyTradeToTickBar(key, trade, tickSize);
        if (next) {
          this.#forming.set(key, next);
          changed.set(key, next);
          this.emit("formingBar", { resolution: key, bar: next });
        }
        continue;
      }

      if (periodSeconds == null) continue;

      const resolution = this.#resolutionByKey.get(key);
      const is1m =
        resolution === 1 ||
        resolution === "1" ||
        periodSeconds === ONE_MINUTE_PERIOD ||
        key === "1";
      if (this.#accuracyMode && is1m) {
        if (this.#live) {
          this.#record1mTrade(trade);
          const ssboe = Number(trade?.ssboe);
          const now =
            Number.isFinite(ssboe) && ssboe > 0
              ? ssboe
              : Math.floor(Date.now() / 1000);
          const marker = bucketOpen(now, ONE_MINUTE_PERIOD);
          const prev = this.#forming.get(key);
          let seedOpen;
          if (prev && Number(prev.marker) === marker && isUsablePrice(prev.open)) {
            seedOpen = prev.open;
          } else {
            if (prev && Number(prev.marker) < marker) {
              this.#commitClosed1m(prev);
            }
            // First trade in the minute sets open (not prior close).
            seedOpen = undefined;
          }
          const next = applyTradeToFormingBar(prev, trade, {
            periodSeconds: ONE_MINUTE_PERIOD,
            symbol: this.#session.symbol,
            exchange: this.#session.exchange,
            seedOpen,
            chartResolution: resolution,
          });
          if (next && next !== prev) {
            this.#forming.set(key, next);
            this.#partial1m = { ...next };
            changed.set(key, next);
            this.emit("formingBar", { resolution: key, bar: next });
          }
        }
        continue;
      }

      if (isCalendarResolution(resolution) && resolution !== "1M" && resolution !== "1m") {
        continue;
      }

      const prev = this.#forming.get(key);
      const next = applyTradeToFormingBar(prev, trade, {
        periodSeconds,
        symbol: this.#session.symbol,
        exchange: this.#session.exchange,
        seedOpen: prev?.open,
        chartResolution: this.#resolutionByKey.get(key),
      });
      if (next && next !== prev) {
        this.#forming.set(key, next);
        changed.set(key, next);
        this.emit("formingBar", { resolution: key, bar: next });
      }
    }
    return changed;
  }

  async attachLive({ updateBits = MarketUpdatePreset.QUOTE, skipStartLive = false } = {}) {
    if (this.#live) return;
    const handler = (trade) => {
      this.onTrade(trade);
      this.syncFromLastTrade();
    };
    this.#session.on("trade", handler);
    this.#unbind = () => this.#session.off("trade", handler);
    this.#skipStopLive = skipStartLive;
    if (!skipStartLive) {
      await this.#session.startLive({ updateBits, exactFormingBar: false });
    }
    this.#live = true;
  }

  async detachLive() {
    if (this.#unbind) {
      this.#unbind();
      this.#unbind = null;
    }
    if (this.#live && !this.#skipStopLive) {
      await this.#session.stopLive();
    }
    this.#live = false;
    this.#skipStopLive = false;
  }

  /** TradeSea 1m uses TV-style compat alignment on Rithmic TimeBar replay. */
  #compat1m() {
    return this.#accuracyMode;
  }

  async #run1mShared(req, nowSec, timeoutMs, tickFallback) {
    let history1m = null;
    if (this.#useCache) {
      const hit = this.#cache.get1m(
        this.#session,
        req.from,
        req.countback,
        nowSec,
        undefined,
        this.#compat1m(),
      );
      if (hit) history1m = hit.raw;
    }

    if (!history1m) {
      log1m("run1mShared.loadHistory", `from=${req.from} countback=${req.countback} compat=${this.#compat1m()}`);
      const compat = this.#compat1m();
      history1m = await this.#session.loadHistory({
        resolution: 1,
        from: req.from,
        to: compat ? nowSec + ONE_MINUTE_PERIOD + 120 : nowSec + 120,
        countback: compat ? Math.max(req.countback, 8) : req.countback,
        include_forming: true,
        compat,
        timeoutMs,
      });
      log1mBars("run1mShared.afterLoad", history1m, { nowSec });
    } else {
      log1m("run1mShared.cacheHit", `bars=${history1m.length}`);
    }

    const split = splitHistoryForForming(history1m, ONE_MINUTE_PERIOD, nowSec);
    this.#closed1m = split.closed;
    this.#partial1m = split.partial;
    const current1mOpen = bucketOpen(nowSec, ONE_MINUTE_PERIOD);
    log1m(
      "run1mShared.split",
      `bucket=${fmtSec(current1mOpen)} closed=${split.closed.length} partial=${split.partial ? "yes" : "null"}`,
    );
    if (this.#partial1m && Number(this.#partial1m.marker) === current1mOpen) {
      log1mBuild("run1mShared.splitPartial", this.#partial1m, {
        openFrom: `history split partial @ ${fmtSec(this.#partial1m.marker)} O=${this.#partial1m.open}`,
        histPartial: this.#partial1m,
      });
    }
    if (!this.#partial1m && history1m.length) {
      const last = history1m.at(-1);
      if (Number(last.marker) === current1mOpen) {
        this.#partial1m = last;
        log1mBuild("run1mShared.partialFallback", this.#partial1m, {
          openFrom: `compat-history last bar @ ${fmtSec(last.marker)} O=${last.open}`,
          histPartial: last,
        });
      }
    }
    if (this.#partial1m && this.#compat1m()) {
      const prev = this.#partial1m;
      this.#partial1m = {
        ...this.#partial1m,
        replaySource: "1m-partial+compat",
      };
      log1mBuild("run1mShared.compatTag", this.#partial1m, {
        openFrom: `compat-transformed history O=${prev.open}`,
        histPartial: prev,
      });
    }

    if (this.#useCache) {
      this.#cache.set1m(
        this.#session,
        req.from,
        req.countback,
        nowSec,
        history1m,
        split.closed,
        split.partial,
        this.#compat1m(),
      );
    }

    if (
      tickFallback &&
      !this.#accuracyMode &&
      (!this.#partial1m || Number(this.#partial1m.marker) !== current1mOpen)
    ) {
      const from1s = await this.#session.replay1mFrom1s(
        current1mOpen,
        nowSec + ONE_MINUTE_PERIOD,
        { timeoutMs },
      );
      if (from1s) {
        this.#partial1m = { ...from1s, forming: true, replaySource: "1m-1s-fallback" };
      }
    }

    if (!this.#fast && !this.#accuracyMode) {
      await this.#buildPartial1mFrom1s(nowSec, timeoutMs);
      await this.#refinePartial1m(nowSec, timeoutMs);
    } else if (!this.#fast && this.#accuracyMode) {
      const current1mOpen = bucketOpen(nowSec, ONE_MINUTE_PERIOD);
      if (!this.#partial1m || Number(this.#partial1m.marker) !== current1mOpen) {
        await this.#ensure1mPartial(nowSec, timeoutMs);
      }
      if (!this.#partial1m || Number(this.#partial1m.marker) !== current1mOpen) {
        const compatValue = await this.#tryCompatValuePartial(nowSec, timeoutMs);
        if (compatValue) {
          this.#partial1m = compatValue;
          log1mBuild("tryCompatValuePartial", compatValue, {
            openFrom: `raw compat value-bar O=${compatValue.open}`,
          });
        } else {
          await this.#buildPartial1mFrom1s(nowSec, timeoutMs);
        }
      }
    }

    if (this.#accuracyMode && this.#needsSession1mTickRefine()) {
      await this.#refineClosed1mExtremesFrom1s(req.from, nowSec + 120, timeoutMs);
    }

    const refinedMinutes = new Set();
    for (const key of req.serves) {
      const periodSeconds = this.#targets.get(key);
      if (periodSeconds == null) continue;
      const resolution = this.#resolutionByKey.get(key);
      const htfOpen = this.#bucketOpenFor(nowSec, resolution, periodSeconds);
      if (!this.#fast) {
        const firstMin = bucketOpen(htfOpen, ONE_MINUTE_PERIOD);
        if (!refinedMinutes.has(firstMin)) {
          refinedMinutes.add(firstMin);
          await this.#refineBucketStartMinute(htfOpen, timeoutMs);
        }
      }
      if (this.#accuracyMode && periodSeconds === ONE_MINUTE_PERIOD) continue;
      if (periodSeconds >= TWO_HOUR_PERIOD) continue;
      const bar = this.#seedFromOneMinute(periodSeconds, htfOpen, resolution);
      this.#forming.set(key, bar);
      if (bar) this.emit("formingBar", { resolution: key, bar });
    }

    if (this.#accuracyMode) {
      log1m("run1mShared.publish", this.#partial1m ? fmt1mBar(this.#partial1m) : "partial=null SKIP");
      this.#publishPartial1mToForming(nowSec);
      this.#sync1mCloseFromLast();
      log1m("run1mShared.final", fmt1mBar(this.#forming.get(resolutionKey(1))));
    }
  }

  /** 2h+ forming from shared 1h bar history (+ current hour from 1m when missing). */
  async #run1hShared(req, nowSec, timeoutMs, tradeSeaAccessToken) {
    const history1h = await this.#session.loadHistory({
      resolution: 60,
      from: req.from,
      to: nowSec + ONE_HOUR_PERIOD + 120,
      countback: Math.max(req.countback, 5),
      include_forming: true,
      compat: false,
      timeoutMs,
    });

    const split = splitHistoryForForming(history1h, ONE_HOUR_PERIOD, nowSec);
    this.#closed1h = split.closed;
    this.#partial1h = split.partial;

    const currentHourOpen = bucketOpen(nowSec, ONE_HOUR_PERIOD);
    if (!this.#partial1h || Number(this.#partial1h.marker) !== currentHourOpen) {
      const from1m = this.#seedFromOneMinute(ONE_HOUR_PERIOD, currentHourOpen, 60);
      if (from1m) {
        this.#partial1h = {
          ...from1m,
          marker: currentHourOpen,
          period: String(ONE_HOUR_PERIOD),
          forming: true,
          replaySource: "1h-1m-partial",
        };
      } else if (history1h.length) {
        const last = history1h.at(-1);
        if (Number(last.marker) === currentHourOpen) {
          this.#partial1h = { ...last, forming: true, replaySource: "1h-partial" };
        }
      }
    }

    for (const key of req.serves) {
      const periodSeconds = this.#targets.get(key);
      if (periodSeconds == null) continue;
      const resolution = this.#resolutionByKey.get(key);
      const htfOpen = this.#bucketOpenFor(nowSec, resolution, periodSeconds);
      let bar = this.#seedFromOneHour(periodSeconds, htfOpen, resolution);
      if (!bar) continue;

      const raw = String(resolution).trim().toUpperCase();
      if (raw === "1W" || raw === "W" || raw === "WEEKLY") {
        const adjust = await this.#resolveWeeklyAdjust(nowSec, timeoutMs, tradeSeaAccessToken);
        bar = {
          ...shiftBarOHLC(bar, adjust),
          marker: htfOpen,
          forming: true,
          replaySource: adjust ? "1h-week-rollup+ts-adjust" : "1h-week-rollup",
        };
      }

      this.#forming.set(key, bar);
      this.emit("formingBar", { resolution: key, bar });
    }
  }

  /** Compat forming partial from raw value TimeBar (label@marker, value@marker+60). */
  async #tryCompatValuePartial(nowSec, timeoutMs) {
    const marker = bucketOpen(nowSec, ONE_MINUTE_PERIOD);
    try {
      const raw = await this.#session.loadHistory({
        resolution: 1,
        countback: 6,
        to: nowSec + ONE_MINUTE_PERIOD + 120,
        compat: false,
        timeoutMs: Math.min(8000, timeoutMs),
      });
      const step = ONE_MINUTE_PERIOD;
      for (let i = 0; i + 1 < raw.length; i++) {
        const labelT = Number(raw[i].marker);
        const valueT = Number(raw[i + 1].marker);
        const gap = valueT - labelT;
        const compatT = gap > step ? valueT - step : labelT;
        if (compatT !== marker) continue;
        const v = raw[i + 1];
        return {
          marker,
          open: Number(v.open),
          high: Number(v.high),
          low: Number(v.low),
          close: Number(v.close),
          volume: Number(v.volume ?? 0),
          forming: true,
          replaySource: "1m-compat-value",
        };
      }
    } catch {
      /* fall through to 1s path */
    }
    return null;
  }

  /** Primary 1m forming bar from 1s TimeBar rollup (overrides history partial when present). */
  async #buildPartial1mFrom1s(
    nowSec,
    timeoutMs,
    marker = bucketOpen(nowSec, ONE_MINUTE_PERIOD),
  ) {
    const prevOpen = this.#partial1m?.open;
    try {
      const perMs = Math.min(8000, timeoutMs);
      const bars1s = await this.#session.replay1sInMinute(
        marker,
        nowSec + ONE_MINUTE_PERIOD,
        { timeoutMs: perMs },
      );
      const from1s = await this.#session.replay1mFrom1s(
        marker,
        nowSec + ONE_MINUTE_PERIOD,
        { timeoutMs: perMs },
      );
      if (!from1s) {
        log1mBuild("buildPartial1mFrom1s.miss", null, {
          note: `no 1s rollup for bucket ${fmtSec(marker)} (${bars1s.length} sub-bars loaded)`,
        });
        return;
      }
      if (this.#accuracyMode) {
        const ts = tradeseaMinuteFormingFrom1s(bars1s, marker, ONE_MINUTE_PERIOD);
        if (ts) {
          const prior = this.#partial1m;
          const lockOpen =
            prior &&
            Number(prior.marker) === marker &&
            isUsablePrice(prior.open);
          const sorted = [...bars1s].sort(
            (a, b) => Number(a.marker) - Number(b.marker),
          );
          const onlyBoundary =
            sorted.length > 0 &&
            Number(sorted[0].marker) === marker &&
            sorted.length < 2;
          if (onlyBoundary && !lockOpen) {
            log1mBuild("buildPartial1mFrom1s.wait", null, {
              note: `only :00 1s for ${fmtSec(marker)} — skip until :01 lands`,
            });
            return;
          }
          const open = lockOpen ? Number(prior.open) : ts.open;
          const openBar =
            tradeseaActive1sBars(bars1s, marker, ONE_MINUTE_PERIOD)[0] ?? null;
          this.#partial1m = {
            ...from1s,
            marker,
            open,
            high: Math.max(
              ts.high,
              open,
              lockOpen ? Number(prior.high) : open,
            ),
            low: Math.min(ts.low, lockOpen ? Number(prior.low) : open),
            close: lockOpen ? Number(prior.close ?? ts.close) : ts.close,
            forming: true,
            replaySource: prior?.replaySource ?? "1m-1s+compat+ts-open",
          };
          log1mBuild("buildPartial1mFrom1s", this.#partial1m, {
            openFrom: lockOpen
              ? `locked O=${open} (H/L from 1s)`
              : openBar
                ? `TradeSea ${fmtSubBar(openBar)} (rollup O=${from1s.open})`
                : `TradeSea open=${ts.open}`,
            openWas: prevOpen,
            openNow: open,
            bars1s,
            open1sUnix: openBar ? Number(openBar.marker) : null,
            first1s: openBar,
            note: `H/L from ${tradeseaActive1sBars(bars1s, marker, ONE_MINUTE_PERIOD).length} active 1s bars (skip :00)`,
          });
          return;
        }
      }
      let open = Number(from1s.open);
      let openBar = bars1s[0] ?? null;
      if (this.#accuracyMode) {
        const tsOpen = tradeseaMinuteOpenFrom1s(bars1s, marker);
        if (isUsablePrice(tsOpen)) {
          open = tsOpen;
          openBar =
            bars1s.length > 1 && Number(bars1s[0]?.marker) === marker
              ? bars1s[1]
              : bars1s[0];
        }
      }
      const high = Math.max(Number(from1s.high), open);
      const low = Math.min(Number(from1s.low), open);
      this.#partial1m = {
        ...from1s,
        open,
        high,
        low,
        forming: true,
        replaySource: this.#accuracyMode ? "1m-1s+compat+ts-open" : "1m-1s",
      };
      log1mBuild("buildPartial1mFrom1s", this.#partial1m, {
        openFrom: openBar
          ? `TradeSea open ${fmtSubBar(openBar)} (rollup O=${from1s.open} → ${open})`
          : `rollup O=${from1s.open}`,
        openWas: prevOpen,
        openNow: open,
        bars1s,
        open1sUnix: openBar ? Number(openBar.marker) : null,
        first1s: openBar,
      });
    } catch (err) {
      log1m("buildPartial1mFrom1s.error", err?.message ?? String(err));
    }
  }

  #record1mTrade(trade) {
    const price = Number(trade?.price);
    if (!Number.isFinite(price)) return;
    const ssboe = Number(trade?.ssboe);
    const now =
      Number.isFinite(ssboe) && ssboe > 0 ? ssboe : Math.floor(Date.now() / 1000);
    const marker = bucketOpen(now, ONE_MINUTE_PERIOD);
    if (!this.#buffered1mTrades.has(marker)) {
      this.#buffered1mTrades.set(marker, []);
    }
    this.#buffered1mTrades.get(marker).push(trade);
    for (const m of this.#buffered1mTrades.keys()) {
      if (m < marker - ONE_MINUTE_PERIOD) this.#buffered1mTrades.delete(m);
    }
  }

  /** Live rollover: seed from buffered first tick — no 1s replay, no prev-close open. */
  #seedLiveRollover1m(marker) {
    const buffered = this.#buffered1mTrades.get(marker) ?? [];
    if (!buffered.length) {
      log1m("seedLiveRollover1m.wait", `defer ${fmtSec(marker)} to first trade`);
      return;
    }

    const firstPrice = Number(buffered[0]?.price);
    if (!isUsablePrice(firstPrice)) return;

    let bar = {
      marker,
      open: firstPrice,
      high: firstPrice,
      low: firstPrice,
      close: firstPrice,
      volume: 0,
      forming: true,
      replaySource: "1m-rollover-tick",
    };

    for (const t of buffered) {
      const next = applyTradeToFormingBar(bar, t, {
        periodSeconds: ONE_MINUTE_PERIOD,
        symbol: this.#session.symbol,
        exchange: this.#session.exchange,
        seedOpen: bar.open,
        chartResolution: 1,
      });
      if (next) bar = next;
    }

    this.#partial1m = bar;
    log1mBuild("seedLiveRollover1m", this.#partial1m, {
      openFrom: `first tick=${firstPrice} (${buffered.length} buffered)`,
      bufferedTrades: buffered.length,
    });
  }

  /** Fast minute rollover seed — no blocking history load. */
  async #seedRollover1mPartial(nowSec, timeoutMs, marker) {
    if (this.#live) {
      this.#seedLiveRollover1m(marker);
      return;
    }
    try {
      const bars1s = await this.#session.replay1sInMinute(
        marker,
        nowSec + ONE_MINUTE_PERIOD,
        { timeoutMs: Math.min(2500, timeoutMs) },
      );
      const ts = tradeseaMinuteFormingFrom1s(bars1s, marker, ONE_MINUTE_PERIOD);
      if (ts) {
        const sorted = [...bars1s].sort(
          (a, b) => Number(a.marker) - Number(b.marker),
        );
        const onlyBoundary =
          sorted.length > 0 &&
          Number(sorted[0].marker) === marker &&
          sorted.length < 2;
        if (!onlyBoundary) {
          this.#partial1m = {
            marker,
            ...ts,
            volume: 0,
            forming: true,
            replaySource: "1m-rollover-seed",
          };
          log1mBuild("seedRollover1mPartial", this.#partial1m, {
            openFrom: `TradeSea 1s (${bars1s.length} bars, ${tradeseaActive1sBars(bars1s, marker, ONE_MINUTE_PERIOD).length} active)`,
            bars1s,
          });
          return;
        }
        log1m("seedRollover1mPartial.wait", "only :00 1s — defer to last trade");
      }
    } catch (err) {
      log1m("seedRollover1mPartial.error", err?.message ?? String(err));
    }

    const last = Number(this.#session.status?.last);
    const prev = this.#closed1m.at(-1);
    const prevClose = prev ? Number(prev.close) : NaN;
    if (
      isUsablePrice(last) &&
      (!isUsablePrice(prevClose) || Math.abs(last - prevClose) >= 0.01)
    ) {
      this.#partial1m = {
        marker,
        open: last,
        high: last,
        low: last,
        close: last,
        volume: 0,
        forming: true,
        replaySource: "1m-rollover-last",
      };
      log1mBuild("seedRollover1mPartial.last", this.#partial1m, {
        openFrom: `status.last=${last}`,
      });
    }
  }

  async #refineRollover1m(nowSec, timeoutMs, targetOpen) {
    try {
      const key = resolutionKey(1);
      const bar = this.#forming.get(key);
      if (!bar || Number(bar.marker) !== targetOpen) return;

      const bars1s = await this.#session.replay1sInMinute(
        targetOpen,
        nowSec + ONE_MINUTE_PERIOD,
        { timeoutMs: Math.min(4000, timeoutMs) },
      );
      const sorted = [...bars1s].sort(
        (a, b) => Number(a.marker) - Number(b.marker),
      );
      if (
        sorted.length > 0 &&
        Number(sorted[0].marker) === targetOpen &&
        sorted.length < 2
      ) {
        return;
      }
      const ts = tradeseaMinuteFormingFrom1s(bars1s, targetOpen, ONE_MINUTE_PERIOD);
      if (!ts) return;

      const open = Number(bar.open);
      const next = {
        ...bar,
        open,
        high: Math.max(Number(bar.high), ts.high, open),
        low: Math.min(Number(bar.low), ts.low),
        forming: true,
      };
      if (next.high === bar.high && next.low === bar.low) return;

      this.#partial1m = { ...this.#partial1m, ...next, marker: targetOpen };
      this.#forming.set(key, next);
      log1m(
        "refineRollover1m.done",
        `O=${open} H=${bar.high}→${next.high} L=${bar.low}→${next.low}`,
      );
      this.emit("formingBar", { resolution: key, bar: next });
    } catch (err) {
      log1m("refineRollover1m.error", err?.message ?? String(err));
    }
  }

  /** Load latest open-minute partial from Rithmic TimeBar history (TradeSea uses same feed). */
  async #ensure1mPartial(
    nowSec,
    timeoutMs,
    marker = bucketOpen(nowSec, ONE_MINUTE_PERIOD),
  ) {
    const compat = this.#compat1m();
    log1m("ensure1mPartial.start", `bucket=${new Date(marker * 1000).toLocaleString()} compat=${compat}`);

    try {
      const history1m = await this.#session.loadHistory({
        resolution: 1,
        countback: compat ? 8 : 4,
        to: compat ? nowSec + ONE_MINUTE_PERIOD + 120 : nowSec + 60,
        include_forming: true,
        compat,
        timeoutMs: Math.min(8000, timeoutMs),
      });
      log1mBars("ensure1mPartial.history", history1m, { nowSec, tail: 5 });
      const split = splitHistoryForForming(history1m, ONE_MINUTE_PERIOD, nowSec);
      log1m(
        "ensure1mPartial.split",
        `partial=${split.partial ? fmt1mBar(split.partial) : "null"} markerMatch=${split.partial ? Number(split.partial.marker) === marker : false}`,
      );
      if (split.partial && Number(split.partial.marker) === marker) {
        this.#partial1m = {
          ...split.partial,
          forming: true,
          replaySource: this.#compat1m() ? "1m-partial+compat" : "1m-partial",
        };
        log1mBuild("ensure1mPartial.splitPartial", this.#partial1m, {
          openFrom: `compat history partial @ ${fmtSec(split.partial.marker)} O=${split.partial.open}`,
          histPartial: split.partial,
        });
        return;
      }
      const last = history1m.at(-1);
      if (last && Number(last.marker) === marker) {
        this.#partial1m = {
          ...last,
          forming: true,
          replaySource: this.#compat1m() ? "1m-partial+compat" : "1m-partial",
        };
        log1mBuild("ensure1mPartial.lastBar", this.#partial1m, {
          openFrom: `compat history tail @ ${fmtSec(last.marker)} O=${last.open}`,
          histPartial: last,
        });
        return;
      }
      log1m("ensure1mPartial.miss", "history loaded but no bar for current bucket");
    } catch (err) {
      log1m("ensure1mPartial.error", err?.message ?? String(err));
    }

    if (this.#partial1m && Number(this.#partial1m.marker) === marker) {
      log1m("ensure1mPartial.keepExisting", fmt1mBar(this.#partial1m));
      return;
    }

    if (!this.#accuracyMode) {
      try {
        const from1s = await this.#session.replay1mFrom1s(
          marker,
          nowSec + ONE_MINUTE_PERIOD,
          { timeoutMs: Math.min(8000, timeoutMs) },
        );
        if (from1s) {
          this.#partial1m = {
            ...from1s,
            forming: true,
            replaySource: "1m-1s-seed",
          };
          log1m("ensure1mPartial.1sSeedDone", fmt1mBar(this.#partial1m));
          return;
        }
      } catch (err) {
        log1m("ensure1mPartial.1sSeedError", err?.message ?? String(err));
      }
    }

    const last = Number(this.#session.status?.last);
    if (!isUsablePrice(last)) {
      log1m("ensure1mPartial.liveSeedSkip", "no status.last");
      return;
    }

    if (this.#accuracyMode) {
      log1m("ensure1mPartial.liveSeedSkip", "accuracy mode — open from 1s replay only");
      return;
    }

    log1m("ensure1mPartial.liveSeed", `last=${last}`);
    let secOpen = null;
    let first1s = null;
    try {
      const bars1s = await this.#session.replay1sInMinute(
        marker,
        nowSec + ONE_MINUTE_PERIOD,
        { timeoutMs: Math.min(4000, timeoutMs) },
      );
      const tsOpen = tradeseaMinuteOpenFrom1s(bars1s, marker);
      if (isUsablePrice(tsOpen)) {
        secOpen = tsOpen;
        first1s =
          bars1s.length > 1 && Number(bars1s[0]?.marker) === marker
            ? bars1s[1]
            : bars1s[0];
      } else {
        first1s = await this.#session.first1sBarInRange(
          marker,
          marker + ONE_MINUTE_PERIOD,
          { timeoutMs: Math.min(4000, timeoutMs), windowSeconds: 75 },
        );
        secOpen = first1s ? Number(first1s.open ?? first1s.close) : null;
      }
    } catch (err) {
      log1m("ensure1mPartial.1sOpenError", err?.message ?? String(err));
    }
    const open = isUsablePrice(secOpen) ? secOpen : last;
    this.#partial1m = {
      marker,
      open,
      high: Math.max(open, last),
      low: Math.min(open, last),
      close: last,
      volume: 0,
      forming: true,
      replaySource: "1m-live-seed",
    };
    log1mBuild("ensure1mPartial.liveSeed", this.#partial1m, {
      openFrom: isUsablePrice(secOpen)
        ? `first1s ${fmtSubBar(first1s)}`
        : `status.last=${last} (no 1s bar)`,
      first1s,
    });
  }

  /** HTF session lows need full-session 1m 1s refine; pure 1m forming does not. */
  #needsSession1mTickRefine(resolutions = null) {
    if (resolutions) {
      for (const r of resolutions) {
        const { periodSeconds } = parseResolution(r);
        if (periodSeconds != null && periodSeconds >= 900) return true;
      }
      return false;
    }
    for (const ps of this.#targets.values()) {
      if (ps != null && ps >= 900) return true;
    }
    return false;
  }

  async #refineBucketStartMinute(bucketStartSec, timeoutMs) {
    const marker = bucketOpen(bucketStartSec, ONE_MINUTE_PERIOD);
    if (this.#partial1m && Number(this.#partial1m.marker) === marker) return;
    const secOpen = await this.#session.first1sOpenInRange(
      marker,
      marker + ONE_MINUTE_PERIOD,
      { timeoutMs },
    );
    if (!isUsablePrice(secOpen)) return;

    if (patch1mBarOpen(this.#closed1m, marker, secOpen)) return;

    const i = this.#closed1m.findIndex((b) => Number(b.marker) === marker);
    if (i >= 0) {
      this.#closed1m[i] = applyBucketOpen(this.#closed1m[i], secOpen);
      return;
    }

    if (this.#accuracyMode) {
      const last = Number(this.#session.status?.last);
      const close = isUsablePrice(last) ? last : secOpen;
      this.#closed1m.push({
        marker,
        open: secOpen,
        high: Math.max(secOpen, close),
        low: Math.min(secOpen, close),
        close,
        volume: 0,
        replaySource: "1m-1s-open-only",
      });
      this.#closed1m.sort((a, b) => Number(a.marker) - Number(b.marker));
      return;
    }

    const from1s = await this.#session.replay1mFrom1s(
      marker,
      marker + ONE_MINUTE_PERIOD,
      { timeoutMs },
    );
    if (from1s) {
      this.#closed1m = [...this.#closed1m, from1s].sort(
        (a, b) => Number(a.marker) - Number(b.marker),
      );
    }
  }

  /** Pull 1m highs/lows toward 1s rollup (history wicks often spike; 1s highs/lows are tighter). */
  async #refineClosed1mExtremesFrom1s(fromSec, toSec, timeoutMs) {
    const from = Math.floor(fromSec);
    const to = Math.floor(toSec);
    const refined = await this.#session.replay1mBarsFrom1s(from, to, { timeoutMs });
    const byMarker = new Map(refined.map((b) => [Number(b.marker), b]));

    for (let i = 0; i < this.#closed1m.length; i++) {
      const bar = this.#closed1m[i];
      const m = Number(bar.marker);
      if (!Number.isFinite(m) || m < from || m >= to) continue;

      const secBar = byMarker.get(m);
      if (!secBar) continue;

      let next = bar;
      if (isUsablePrice(secBar.low)) {
        const secLow = Number(secBar.low);
        if (secLow < Number(bar.low)) next = { ...next, low: secLow };
      }
      if (isUsablePrice(secBar.high)) {
        const secHigh = Number(secBar.high);
        if (secHigh < Number(bar.high)) next = { ...next, high: secHigh };
      }
      if (next !== bar) this.#closed1m[i] = next;
    }
  }

  async #refinePartial1m(nowSec, timeoutMs) {
    if (this.#accuracyMode) return;
    if (!this.#partial1m) return;
    const marker = Number(this.#partial1m.marker);
    const current1mOpen = bucketOpen(nowSec, ONE_MINUTE_PERIOD);
    if (marker !== current1mOpen) return;

    const from1s = await this.#session.replay1mFrom1s(
      marker,
      marker + ONE_MINUTE_PERIOD,
      { timeoutMs },
    );
    if (from1s) {
      this.#partial1m = {
        ...from1s,
        forming: true,
        replaySource: "1m-1s-partial",
      };
    }
  }

  /** 1W / 1M forming from shared daily bar history (+ today's day from 1m when missing). */
  async #runDailyShared(req, nowSec, timeoutMs, tradeSeaAccessToken) {
    let daily = this.#scratch.daily;
    if (!daily?.length) {
      daily = await this.#session.loadHistory({
        resolution: "1D",
        countback: req.countback,
        to: nowSec + 120,
        include_forming: true,
        compat: false,
        timeoutMs,
      });
      this.#scratch.daily = daily;
    }

    const dailyRows = this.#dailyRowsWithForming1m(daily, nowSec);

    for (const key of req.serves) {
      const resolution = this.#resolutionByKey.get(key);
      const { periodSeconds } = parseResolution(resolution);
      const htfOpen = this.#bucketOpenFor(nowSec, resolution, periodSeconds);
      const raw = String(resolution).trim().toUpperCase();

      if (raw === "1W" || raw === "W" || raw === "WEEKLY") {
        await this.#seedWeekFromDaily(
          key,
          htfOpen,
          dailyRows,
          nowSec,
          timeoutMs,
          tradeSeaAccessToken,
        );
        continue;
      }
      if (raw === "1M" || raw === "M" || raw === "MONTHLY") {
        this.#seedMonthFromDaily(key, htfOpen, dailyRows, periodSeconds);
      }
    }
  }

  /** 1Y forming from shared monthly bar history. */
  async #runMonthlyShared(req, nowSec, timeoutMs) {
    let monthly = this.#scratch.monthly;
    if (!monthly?.length) {
      monthly = await this.#session.loadHistory({
        resolution: "1M",
        countback: req.countback,
        to: nowSec + 120,
        include_forming: true,
        compat: false,
        timeoutMs,
      });
      this.#scratch.monthly = monthly;
    }

    for (const key of req.serves) {
      const resolution = this.#resolutionByKey.get(key);
      const { periodSeconds } = parseResolution(resolution);
      const htfOpen = this.#bucketOpenFor(nowSec, resolution, periodSeconds);
      const rows = monthly
        .filter((b) => calendarBarUnix(b.marker, "1M") >= htfOpen)
        .sort(
          (a, b) =>
            calendarBarUnix(a.marker, "1M") - calendarBarUnix(b.marker, "1M"),
        );
      const rollup = aggregateReplayOHLC(rows, {
        marker: htfOpen,
        periodSeconds,
        symbol: this.#session.symbol,
        exchange: this.#session.exchange,
      });
      if (!rollup) continue;

      const bar = {
        ...rollup,
        marker: htfOpen,
        period: String(periodSeconds),
        forming: true,
        replaySource: "1M-year-rollup",
      };
      this.#forming.set(key, bar);
      this.emit("formingBar", { resolution: key, bar });
    }
  }

  #dailyRowsWithForming1m(daily, nowSec) {
    const todayOpen = chartBucketOpen(nowSec, "1D");
    const todayYmd = chartBucketRithmicMarker(nowSec, "1D");
    const rows = [...(daily ?? [])];
    const hasToday = rows.some((b) => {
      const m = Number(b.marker);
      return m === todayYmd || calendarBarUnix(m, "1D") === todayOpen;
    });
    if (!hasToday) {
      const derived = this.#deriveFormingDailyFrom1m(todayOpen, nowSec);
      if (derived) rows.push(derived);
    }
    return rows.sort(
      (a, b) => calendarBarUnix(a.marker, "1D") - calendarBarUnix(b.marker, "1D"),
    );
  }

  #deriveFormingDailyFrom1m(dayOpen, nowSec) {
    const rows = [];
    for (const b of this.#closed1m) {
      if (Number(b.marker) >= dayOpen) rows.push(b);
    }
    if (this.#partial1m && Number(this.#partial1m.marker) >= dayOpen) {
      rows.push(this.#partial1m);
    }
    if (!rows.length) return null;

    const bar = aggregateReplayOHLC(rows, {
      marker: chartBucketRithmicMarker(nowSec, "1D"),
      periodSeconds: 86_400,
      symbol: this.#session.symbol,
      exchange: this.#session.exchange,
    });
    if (!bar) return null;
    return { ...bar, forming: true, replaySource: "1m-daily-rollup" };
  }

  async #seedWeekFromDaily(key, htfOpen, dailyRows, nowSec, timeoutMs, tradeSeaAccessToken) {
    const weekYmd = chartBucketRithmicMarker(nowSec, "1W");
    const rows = dailyRows
      .filter((b) => Number(b.marker) >= weekYmd)
      .sort((a, b) => Number(a.marker) - Number(b.marker));
    const rollup = aggregateReplayOHLC(rows, {
      marker: htfOpen,
      periodSeconds: 604_800,
      symbol: this.#session.symbol,
      exchange: this.#session.exchange,
    });
    if (!rollup) {
      await this.#bootstrapFrom1mForKeys(
        [key],
        "1W",
        604_800,
        htfOpen,
        nowSec,
        timeoutMs,
      );
      return;
    }

    const adjust = await this.#resolveWeeklyAdjust(nowSec, timeoutMs, tradeSeaAccessToken);
    const bar = shiftBarOHLC(rollup, adjust);
    const seeded = {
      ...bar,
      marker: htfOpen,
      forming: true,
      replaySource: adjust ? "1D-week-rollup+ts-adjust" : "1D-week-rollup",
    };
    this.#forming.set(key, seeded);
    this.emit("formingBar", { resolution: key, bar: seeded });
  }

  #seedMonthFromDaily(key, htfOpen, dailyRows, periodSeconds) {
    const rows = dailyRows.filter(
      (b) => calendarBarUnix(b.marker, "1D") >= htfOpen,
    );
    const rollup = aggregateReplayOHLC(rows, {
      marker: htfOpen,
      periodSeconds,
      symbol: this.#session.symbol,
      exchange: this.#session.exchange,
    });
    if (!rollup) return;

    const bar = {
      ...rollup,
      marker: htfOpen,
      period: String(periodSeconds),
      forming: true,
      replaySource: "1D-month-rollup",
    };
    this.#forming.set(key, bar);
    this.emit("formingBar", { resolution: key, bar });
  }

  async #runNativePartial(req, nowSec, timeoutMs, tradeSeaAccessToken) {
    const { periodSeconds } = parseResolution(req.resolution);
    const htfOpen = this.#bucketOpenFor(nowSec, req.resolution, periodSeconds);
    const cal = isCalendarResolution(req.resolution);
    const expectedYmd = cal ? chartBucketRithmicMarker(nowSec, req.resolution) : null;
    const cacheMarker = cal ? expectedYmd : htfOpen;

    let bars = null;
    if (this.#useCache) {
      bars = this.#cache.getNative(
        this.#session,
        req.resolution,
        cacheMarker,
        nowSec,
      );
    }

    if (!bars) {
      bars = await this.#session.loadHistory({
        resolution: req.resolution,
        countback: req.countback,
        to: nowSec + 120,
        include_forming: true,
        compat: false,
        timeoutMs,
      });
      if (this.#useCache && bars?.length) {
        this.#cache.setNative(
          this.#session,
          req.resolution,
          cacheMarker,
          nowSec,
          bars,
        );
      }
    }

    if (String(req.resolution).toUpperCase() === "1D" && bars?.length) {
      this.#scratch.daily = bars;
    }
    if (String(req.resolution).toUpperCase() === "1W" && bars?.length) {
      this.#scratch.nativeWeeklyClose = Number(bars.at(-1)?.close);
    }

    let partial = null;
    if (bars.length) {
      if (cal) {
        partial =
          bars.find((b) => Number(b.marker) === expectedYmd) ?? bars.at(-1);
        const partialUnix = calendarBarUnix(partial?.marker, req.resolution);
        if (!partial || !Number.isFinite(partialUnix) || partialUnix < htfOpen) {
          partial = null;
        }
      } else {
        const split = splitHistoryForForming(
          bars,
          periodSeconds,
          nowSec,
          req.resolution,
        );
        partial = split.partial ?? bars.at(-1);
        if (partial && Number(partial.marker) !== htfOpen) partial = null;
      }
    }

    if (!partial) {
      if (String(req.resolution).toUpperCase() === "1W") {
        await this.#seedWeekFromDaily(
          req.serves[0],
          htfOpen,
          this.#dailyRowsWithForming1m(this.#scratch.daily ?? [], nowSec),
          nowSec,
          timeoutMs,
          tradeSeaAccessToken,
        );
        return;
      }
      await this.#bootstrapFrom1mForKeys(
        req.serves,
        req.resolution,
        periodSeconds,
        htfOpen,
        nowSec,
        timeoutMs,
      );
      return;
    }

    const marker = cal ? htfOpen : Number(partial.marker) || htfOpen;
    for (const key of req.serves) {
      const bar = {
        ...partial,
        marker,
        period: String(periodSeconds),
        forming: true,
        replaySource: "native-partial",
      };
      this.#forming.set(key, bar);
      this.emit("formingBar", { resolution: key, bar });
    }
  }

  /** @deprecated Native partial fallback ΓÇö primary path is {@link #runDailyShared}. */
  async #bootstrapWeekFromDaily(keys, htfOpen, nowSec, timeoutMs, tradeSeaAccessToken) {
    const daily = this.#scratch.daily ?? [];
    for (const key of keys) {
      await this.#seedWeekFromDaily(
        key,
        htfOpen,
        this.#dailyRowsWithForming1m(daily, nowSec),
        nowSec,
        timeoutMs,
        tradeSeaAccessToken,
      );
    }
  }

  /** When native daily/weekly/monthly replay is empty on this gateway ΓÇö rollup 1m tail only. */
  async #bootstrapFrom1mForKeys(keys, resolution, periodSeconds, htfOpen, nowSec, timeoutMs) {
    const elapsed = Math.ceil((nowSec - htfOpen) / ONE_MINUTE_PERIOD) + 3;
    const maxCountback = isCalendarResolution(resolution) ? 1500 : 500;
    const countback = Math.min(maxCountback, Math.max(5, elapsed));
    const history1m = await this.#session.loadHistory({
      resolution: 1,
      from: htfOpen,
      to: nowSec + 120,
      countback,
      include_forming: true,
      compat: this.#compat1m(),
      timeoutMs,
    });
    const split = splitHistoryForForming(history1m, ONE_MINUTE_PERIOD, nowSec);
    const savedClosed = this.#closed1m;
    const savedPartial = this.#partial1m;
    this.#closed1m = split.closed;
    this.#partial1m = split.partial;

    for (const key of keys) {
      const bar = this.#seedFromOneMinute(periodSeconds, htfOpen, resolution);
      if (bar) {
        bar.replaySource = "1m-fallback";
        this.#forming.set(key, bar);
        this.emit("formingBar", { resolution: key, bar });
      }
    }

    if (!savedClosed.length) this.#closed1m = split.closed;
    else this.#closed1m = savedClosed;
    if (!savedPartial) this.#partial1m = split.partial;
    else this.#partial1m = savedPartial;
  }

  async #runTickWindow(req, nowSec, timeoutMs) {
    const periodSeconds = req.periodSeconds;
    const ticks = await this.#session.loadTickHistory({
      from: req.from,
      to: req.to,
      barTypeSpecifier: "1",
      timeoutMs,
      windowSeconds: Math.max(60, req.to - req.from + 30),
      direction: ReplayDirection.FIRST,
      time_order: ReplayTimeOrder.FORWARDS,
    });

    const currentOpen = bucketOpen(nowSec, periodSeconds);
    const inBucket = ticks.filter((t) => {
      const ts = tickBarTime(t);
      return ts >= currentOpen && ts < currentOpen + periodSeconds;
    });

    const bar = aggregateReplayOHLC(inBucket, {
      marker: currentOpen,
      periodSeconds,
      symbol: this.#session.symbol,
      exchange: this.#session.exchange,
    });

    if (!bar) return;

    const seeded = { ...bar, forming: true, replaySource: "tick-window" };
    for (const key of req.serves) {
      this.#forming.set(key, { ...seeded, period: String(periodSeconds) });
      this.emit("formingBar", { resolution: key, bar: this.#forming.get(key) });
    }
  }

  async #runTickBarPartial(req, nowSec, timeoutMs) {
    const tickSize = req.tickSize;
    const windowSec = Math.min(900, Math.max(120, tickSize * 2));
    const ticks = await this.#session.loadTickHistory({
      from: nowSec - windowSec,
      to: nowSec + 60,
      barTypeSpecifier: "1",
      timeoutMs,
      countback: tickSize * 3,
      windowSeconds: windowSec,
      direction: ReplayDirection.LAST,
      time_order: ReplayTimeOrder.FORWARDS,
    });

    const { forming } = aggregatePartialTickForming(ticks, tickSize);
    if (!forming) return;

    const seeded = {
      ...forming,
      symbol: this.#session.symbol,
      exchange: this.#session.exchange,
      forming: true,
      replaySource: `${tickSize}T-tick-partial`,
      tickSize,
    };

    for (const key of req.serves) {
      this.#forming.set(key, seeded);
      this.#tickCounts.set(key, ticks.length % tickSize);
      this.emit("formingBar", { resolution: key, bar: seeded });
    }
  }

  #applyTradeToTickBar(key, trade, tickSize) {
    const price = Number(trade?.price);
    if (!Number.isFinite(price)) return null;

    let bar = this.#forming.get(key);
    let count = (this.#tickCounts.get(key) ?? 0) + 1;

    if (!bar) {
      bar = {
        marker: tickBarTime(trade) || Date.now() / 1000,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: Number(trade?.size ?? 0),
        forming: true,
        tickSize,
        symbol: this.#session.symbol,
        exchange: this.#session.exchange,
      };
    } else {
      bar = {
        ...bar,
        high: Math.max(Number(bar.high), price),
        low: Math.min(Number(bar.low), price),
        close: price,
        volume: Number(bar.volume ?? 0) + Number(trade?.size ?? 0),
        forming: true,
      };
    }

    if (count >= tickSize) {
      this.#tickCounts.set(key, 0);
      this.emit("bar", { resolution: key, bar: { ...bar, forming: false } });
      return {
        marker: tickBarTime(trade) || Date.now() / 1000,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: Number(trade?.size ?? 0),
        forming: true,
        tickSize,
        symbol: this.#session.symbol,
        exchange: this.#session.exchange,
      };
    }

    this.#tickCounts.set(key, count);
    return bar;
  }

  #seedFromOneMinute(periodSeconds, htfOpen, resolution) {
    const end = htfOpen + periodSeconds;
    const closedRows = this.#closed1m.filter((b) => {
      const m = Number(b.marker);
      return m >= htfOpen && m < end;
    });
    const allRows = [...closedRows];
    if (this.#partial1m) {
      const m = Number(this.#partial1m.marker);
      if (m >= htfOpen && m < end) allRows.push(this.#partial1m);
    }
    if (!allRows.length) return null;

    const base = { marker: htfOpen, periodSeconds, symbol: this.#session.symbol, exchange: this.#session.exchange };

    if (this.#accuracyMode && periodSeconds < 86_400 && closedRows.length) {
      const trim1PtWick = (b) => {
        const o = Number(b.open);
        const c = Number(b.close);
        const h = Number(b.high);
        const l = Number(b.low);
        if (!isUsablePrice(o) && !isUsablePrice(c)) return b;
        const top = Math.max(o, c);
        const bot = Math.min(o, c);
        let eh = h;
        let el = l;
        const wickUp = isUsablePrice(h) ? h - top : 0;
        const wickDn = isUsablePrice(l) ? bot - l : 0;
        if (wickUp > 0.01 && wickUp <= 1.01) eh = top;
        if (wickDn > 0.01 && wickDn <= 1.01) el = bot;
        return { ...b, high: eh, low: el };
      };
      const full = aggregateReplayOHLC(allRows, base);
      const extremes = aggregateReplayOHLC(closedRows.map(trim1PtWick), base);
      if (!full) return null;
      return {
        ...full,
        high: extremes?.high ?? full.high,
        low: extremes?.low ?? full.low,
        forming: true,
        replaySource: "1m-blind-spot",
      };
    }

    const bar = aggregateReplayOHLC(allRows, base);
    if (!bar) return null;

    return { ...bar, forming: true, replaySource: "1m-blind-spot" };
  }

  #seedFromOneHour(periodSeconds, htfOpen, resolution) {
    const end = htfOpen + periodSeconds;
    const closedRows = this.#closed1h.filter((b) => {
      const m = Number(b.marker);
      return m >= htfOpen && m < end;
    });
    const allRows = [...closedRows];
    if (this.#partial1h) {
      const m = Number(this.#partial1h.marker);
      if (m >= htfOpen && m < end) allRows.push(this.#partial1h);
    }
    if (!allRows.length) return null;

    const base = {
      marker: htfOpen,
      periodSeconds,
      symbol: this.#session.symbol,
      exchange: this.#session.exchange,
    };

    const bar = aggregateReplayOHLC(allRows, base);
    if (!bar) return null;

    return { ...bar, forming: true, replaySource: "1h-blind-spot" };
  }

  #bucketOpenFor(nowSec, resolution, periodSeconds) {
    if (resolution != null && isCalendarResolution(resolution)) {
      return chartBucketOpen(nowSec, resolution);
    }
    return bucketOpen(nowSec, periodSeconds);
  }

  /** Apply session stats from 1m rollup to hourly/daily forming bars. */
  async applySessionOverlay() {
    await this.#overlaySessionRangeForHourly();
    if (this.#accuracyMode) {
      await this.#applyTradeSea4hHighFromNativeHourly(
        Math.floor(Date.now() / 1000),
        8000,
      );
    }
  }

  /** Push latest last-trade price into intraday forming closes (matches TradeSea live close). */
  syncFromLastTrade() {
    const last = Number(this.#session.status?.last);
    if (!isUsablePrice(last)) return;
    this.#applyLastToFormingCloses(last);
    this.#maybeRefine1mOpenFrom1s();
  }

  /** Push explicit TradeSea LTP into forming closes (from MDS f:2 / f:6). */
  syncFromTradeSeaLast(lastPrice) {
    const last = Number(lastPrice);
    if (!isUsablePrice(last)) return;
    this.#applyLastToFormingCloses(last);
  }

  #isStaleBoundaryLast(bar, last, nowSec = Math.floor(Date.now() / 1000)) {
    const marker = Number(bar?.marker);
    if (!Number.isFinite(marker) || !isUsablePrice(last)) return false;
    if (nowSec - marker > 5) return false;

    const prev = this.#closed1m.at(-1);
    if (!prev) return false;
    if (Number(prev.marker) !== marker - ONE_MINUTE_PERIOD) return false;

    const prevClose = Number(prev.close);
    return isUsablePrice(prevClose) && Math.abs(last - prevClose) < 0.01;
  }

  #applyLastToFormingCloses(last) {
    const nowSec = Math.floor(Date.now() / 1000);
    const current1mOpen = bucketOpen(nowSec, ONE_MINUTE_PERIOD);
    for (const [key, bar] of this.#forming) {
      const resolution = this.#resolutionByKey.get(key);
      if (resolution === "1M") continue;

      const ps = this.#targets.get(key);
      if (ps == null) continue;

      if (
        (resolution === 1 || resolution === "1" || ps === ONE_MINUTE_PERIOD) &&
        Number(bar.marker) < current1mOpen
      ) {
        continue;
      }

      const is1m =
        resolution === 1 || resolution === "1" || ps === ONE_MINUTE_PERIOD;
      if (this.#accuracyMode && is1m && this.#isStaleBoundaryLast(bar, last, nowSec)) {
        log1m("applyLastToFormingCloses.skip", `stale boundary last=${last}`);
        continue;
      }

      let next;
      if (this.#accuracyMode && (resolution === 1 || resolution === "1" || ps === ONE_MINUTE_PERIOD)) {
        // Open from 1s/TradeSea bootstrap; close + live H/L from LastTrade.
        next = {
          ...bar,
          close: last,
          high: Math.max(Number(bar.high), last),
          low: Math.min(Number(bar.low), last),
          forming: true,
        };
      } else {
        next = {
          ...bar,
          close: last,
          high: Math.max(Number(bar.high), last),
          low: Math.min(Number(bar.low), last),
          forming: true,
        };
      }

      if (
        next.close === bar.close &&
        next.high === bar.high &&
        next.low === bar.low
      ) {
        continue;
      }

      this.#forming.set(key, next);
      this.emit("formingBar", { resolution: key, bar: next });
    }
  }

  /** Re-fetch 1m tail and re-seed minute rollups (live high/low sync). */
  async refreshSharedFrom1m(nowSec = Math.floor(Date.now() / 1000), timeoutMs = 30_000) {
    const req = this.plan?.requests.find((r) => r.type === "1m-shared");
    if (!req) return;
    await this.#run1mShared(req, nowSec, timeoutMs, true);
    await this.#overlaySessionRangeForHourly();
    this.syncFromLastTrade();
  }

  /** Re-fetch 1h tail and re-seed 2h+ rollups. */
  async refreshSharedFrom1h(nowSec = Math.floor(Date.now() / 1000), timeoutMs = 30_000) {
    const req = this.plan?.requests.find((r) => r.type === "1h-shared");
    if (!req) return;
    await this.#run1hShared(req, nowSec, timeoutMs, this.#tradeSeaAccessToken);
    await this.#overlaySessionRangeForHourly();
    this.syncFromLastTrade();
  }

  #commitClosed1m(bar) {
    if (!bar) return;
    const m = Number(bar.marker);
    if (!Number.isFinite(m)) return;
    const row = { ...bar, forming: false };
    const idx = this.#closed1m.findIndex((b) => Number(b.marker) === m);
    if (idx >= 0) this.#closed1m[idx] = row;
    else this.#closed1m.push(row);
    this.#closed1m.sort((a, b) => Number(a.marker) - Number(b.marker));
  }

  /** Re-fetch 1m tail and publish forming key `1` (accuracy: history + first-1s open). */
  async refreshCurrent1m(
    nowSec = Math.floor(Date.now() / 1000),
    timeoutMs = 8000,
    { closedMarker, closedBucketOpen, rollover = false } = {},
  ) {
    let targetOpen = bucketOpen(nowSec, ONE_MINUTE_PERIOD);
    const closedOpen = Number(closedBucketOpen);
    if (Number.isFinite(closedOpen)) {
      const rollOpen = closedOpen + ONE_MINUTE_PERIOD;
      if (rollOpen > targetOpen) targetOpen = rollOpen;
    } else {
      const closedM = Number(closedMarker);
      if (Number.isFinite(closedM)) {
        const cmBucket = bucketOpen(closedM, ONE_MINUTE_PERIOD);
        let rollOpen;
        if (closedM === cmBucket + ONE_MINUTE_PERIOD) {
          rollOpen = closedM;
        } else if (closedM === cmBucket) {
          const key = resolutionKey(1);
          const existing = this.#forming.get(key);
          const ex = existing ? Number(existing.marker) : NaN;
          rollOpen =
            Number.isFinite(ex) && closedM <= ex
              ? cmBucket + ONE_MINUTE_PERIOD
              : cmBucket;
        } else {
          rollOpen = cmBucket + ONE_MINUTE_PERIOD;
        }
        if (rollOpen > targetOpen) targetOpen = rollOpen;
      }
    }

    const key = resolutionKey(1);
    const existing = this.#forming.get(key);
    if (existing && Number(existing.marker) < targetOpen) {
      log1m(
        "refreshCurrent1m.roll",
        `commit ${fmtSec(Number(existing.marker))} → new bucket ${fmtSec(targetOpen)}`,
      );
      this.#commitClosed1m(existing);
      this.#forming.delete(key);
      this.#partial1m = null;
    }

    log1m(
      "refreshCurrent1m.start",
      `now=${new Date(nowSec * 1000).toLocaleString()} bucket=${new Date(targetOpen * 1000).toLocaleString()}`,
    );

    if (this.#accuracyMode) {
      const current = this.#forming.get(key);
      if (current && Number(current.marker) === targetOpen) {
        log1m("refreshCurrent1m.path", "close-only (forming bar already on bucket)");
        this.#sync1mCloseFromLast();
        log1m("refreshCurrent1m.final", fmt1mBar(this.#forming.get(key)));
        return;
      }
      if (rollover && this.#live) {
        log1m(
          "refreshCurrent1m.path",
          "live rollover — tick/prev-close seed (skip 1s)",
        );
        await this.#seedRollover1mPartial(nowSec, timeoutMs, targetOpen);
        this.#publishPartial1mToForming(nowSec, targetOpen);
        this.#sync1mCloseFromLast();
        log1m("refreshCurrent1m.final", fmt1mBar(this.#forming.get(key)));
        return;
      }
      const havePartial =
        this.#partial1m && Number(this.#partial1m.marker) === targetOpen;
      log1m(
        "refreshCurrent1m.path",
        havePartial
          ? `partial exists — refine from 1s ${fmt1mBar(this.#partial1m)}`
          : "buildPartial1mFrom1s (no partial for bucket)",
      );
      const replayMs = rollover ? Math.min(3000, timeoutMs) : timeoutMs;
      await this.#buildPartial1mFrom1s(nowSec, replayMs, targetOpen);
      if (!this.#partial1m || Number(this.#partial1m.marker) !== targetOpen) {
        if (rollover) {
          await this.#seedRollover1mPartial(nowSec, replayMs, targetOpen);
        } else {
          await this.#ensure1mPartial(nowSec, timeoutMs, targetOpen);
        }
      }
      this.#publishPartial1mToForming(nowSec, targetOpen);
      this.#sync1mCloseFromLast();
      log1m("refreshCurrent1m.final", fmt1mBar(this.#forming.get(key)));
      if (rollover && !this.#live) {
        void this.#refineRollover1m(nowSec, timeoutMs, targetOpen);
      }
      return;
    }

    const havePartial =
      this.#partial1m && Number(this.#partial1m.marker) === targetOpen;

    if (!havePartial) {
      try {
        const history1m = await this.#session.loadHistory({
          resolution: 1,
          countback: 4,
          to: nowSec + 60,
          include_forming: true,
          compat: this.#compat1m(),
          timeoutMs: Math.min(8000, timeoutMs),
        });
        const split = splitHistoryForForming(history1m, ONE_MINUTE_PERIOD, nowSec);
        let partial = split.partial;
        if (!partial && history1m.length) {
          const last = history1m.at(-1);
          if (Number(last.marker) === targetOpen) partial = last;
        }
        if (partial) {
          this.#partial1m = {
            ...partial,
            forming: true,
            replaySource: "1m-partial",
          };
        }
      } catch {
        /* keep existing partial if any */
      }
      if (!this.#partial1m || Number(this.#partial1m.marker) !== targetOpen) {
        await this.#ensure1mPartial(nowSec, timeoutMs, targetOpen);
      }
    }

    await this.#refinePartial1m(nowSec, timeoutMs);
    this.#publishPartial1mToForming(nowSec, targetOpen);
    this.#sync1mCloseFromLast();
  }

  /**
   * Accuracy 1m open: history TimeBar open; first-1s only when history open is missing.
   * H/L from 1s rollup (tighter than history wicks).
   */
  async #refinePartial1mAccuracy(nowSec, timeoutMs) {
    if (!this.#partial1m) return;
    const current1mOpen = bucketOpen(nowSec, ONE_MINUTE_PERIOD);
    if (Number(this.#partial1m.marker) !== current1mOpen) return;

    const perMs = Math.min(4000, timeoutMs);
    const secOpen = await this.#session.first1sOpenInRange(
      current1mOpen,
      current1mOpen + ONE_MINUTE_PERIOD,
      { timeoutMs: perMs, windowSeconds: 75 },
    );

    const histOpen = Number(this.#partial1m.open);
    let open = isUsablePrice(histOpen) ? histOpen : secOpen;
    if (!isUsablePrice(open)) return;

    let h = Number(this.#partial1m.high);
    let l = Number(this.#partial1m.low);
    let from1s = null;
    try {
      const bars1s = await this.#session.replay1sInMinute(
        current1mOpen,
        nowSec + ONE_MINUTE_PERIOD,
        { timeoutMs: Math.min(8000, timeoutMs) },
      );
      const ts = tradeseaMinuteFormingFrom1s(bars1s, current1mOpen, ONE_MINUTE_PERIOD);
      if (ts) {
        if (!isUsablePrice(histOpen)) open = ts.open;
        h = Math.max(Number(h), ts.high, open);
        l = Math.min(Number(l), ts.low);
      } else {
        from1s = await this.#session.replay1mFrom1s(
          current1mOpen,
          nowSec + ONE_MINUTE_PERIOD,
          { timeoutMs: Math.min(8000, timeoutMs) },
        );
        if (from1s) {
          if (isUsablePrice(from1s.high)) h = Number(from1s.high);
          if (isUsablePrice(from1s.low)) l = Number(from1s.low);
        }
      }
    } catch {
      /* keep history extremes */
    }
    if (isUsablePrice(h)) h = Math.max(h, open);
    if (isUsablePrice(l)) l = Math.min(l, open);

    const used1sOpen = !isUsablePrice(histOpen) && isUsablePrice(secOpen);
    const prevOpen = this.#partial1m.open;
    this.#partial1m = {
      ...this.#partial1m,
      open,
      high: h,
      low: l,
      forming: true,
      replaySource: used1sOpen
        ? "1m-partial+1s-open"
        : from1s
          ? "1m-partial+1s-hl"
          : "1m-partial",
    };
    log1mBuild("refinePartial1mAccuracy", this.#partial1m, {
      openFrom: isUsablePrice(histOpen)
        ? `history partial O=${histOpen}${isUsablePrice(secOpen) ? ` (first1s=${secOpen})` : ""}`
        : `first1s O=${secOpen}`,
      openWas: prevOpen,
      openNow: open,
      histPartial: { marker: current1mOpen, open: histOpen },
      note: from1s ? `H/L from 1s rollup H=${from1s.high} L=${from1s.low}` : undefined,
    });
  }

  /** Re-apply TradeSea :01 open when :01 1s bar lands after minute rollover. */
  #maybeRefine1mOpenFrom1s() {
    if (!this.#accuracyMode || this.#refine1mOpenInflight || this.#live) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const marker = bucketOpen(nowSec, ONE_MINUTE_PERIOD);
    if (nowSec - marker > 20) return;
    if (Date.now() - this.#lastRefine1mOpenAt < 750) return;

    const key = resolutionKey(1);
    const bar = this.#forming.get(key);
    if (!bar?.forming || Number(bar.marker) !== marker) return;

    this.#refine1mOpenInflight = true;
    void this.#refine1mOpenFrom1s(marker, nowSec).finally(() => {
      this.#refine1mOpenInflight = false;
      this.#lastRefine1mOpenAt = Date.now();
    });
  }

  async #refine1mOpenFrom1s(marker, nowSec) {
    try {
      const bars1s = await this.#session.replay1sInMinute(
        marker,
        nowSec + ONE_MINUTE_PERIOD,
        { timeoutMs: 4000 },
      );
      const sorted = [...bars1s].sort(
        (a, b) => Number(a.marker) - Number(b.marker),
      );
      if (
        sorted.length > 0 &&
        Number(sorted[0].marker) === marker &&
        sorted.length < 2
      ) {
        return;
      }

      const ts = tradeseaMinuteFormingFrom1s(bars1s, marker, ONE_MINUTE_PERIOD);
      if (!ts) return;

      const key = resolutionKey(1);
      const bar = this.#forming.get(key);
      if (!bar?.forming || Number(bar.marker) !== marker) return;

      const curOpen = Number(bar.open);
      const curHigh = Number(bar.high);
      const curLow = Number(bar.low);
      const next = {
        ...bar,
        open: curOpen,
        high: Math.max(curHigh, ts.high, curOpen),
        low: Math.min(curLow, ts.low),
        forming: true,
      };
      if (next.high === curHigh && next.low === curLow) return;

      if (this.#partial1m && Number(this.#partial1m.marker) === marker) {
        this.#partial1m = { ...this.#partial1m, ...next };
      }
      this.#forming.set(key, next);
      log1m(
        "refine1mOpenFrom1s",
        `O=${curOpen} (locked) H=${curHigh}→${next.high} L=${curLow}→${next.low}`,
      );
      log1mBuild("refine1mOpenFrom1s", next, {
        openFrom: `TradeSea active 1s (${sorted.length} bars), open locked`,
        bars1s: sorted,
      });
      this.emit("formingBar", { resolution: key, bar: next });
    } catch (err) {
      log1m("refine1mOpenFrom1s.error", err?.message ?? String(err));
    }
  }

  /** Accuracy 1m: open from bootstrap; LastTrade updates close and expands H/L. */
  #sync1mCloseFromLast() {
    const key = resolutionKey(1);
    const bar = this.#forming.get(key);
    const last = Number(this.#session.status?.last);
    const nowSec = Math.floor(Date.now() / 1000);
    const current1mOpen = bucketOpen(nowSec, ONE_MINUTE_PERIOD);
    if (bar && Number(bar.marker) < current1mOpen) {
      log1m("sync1mCloseFromLast.skip", `stale bucket ${fmtSec(Number(bar.marker))}`);
      return;
    }
    if (bar && isUsablePrice(last)) {
      if (this.#isStaleBoundaryLast(bar, last, nowSec)) {
        log1m(
          "sync1mCloseFromLast.skip",
          `stale boundary last=${last} (prev minute close)`,
        );
        return;
      }
      const next = {
        ...bar,
        close: last,
        high: Math.max(Number(bar.high), last),
        low: Math.min(Number(bar.low), last),
        forming: true,
      };
      if (
        next.close === bar.close &&
        next.high === bar.high &&
        next.low === bar.low
      ) {
        log1m("sync1mCloseFromLast", `unchanged ${last}`);
        return;
      }
      this.#forming.set(key, next);
      log1m(
        "sync1mCloseFromLast",
        `close ${bar.close} → ${last} H=${bar.high} → ${next.high} L=${bar.low} → ${next.low}`,
      );
      this.emit("formingBar", { resolution: key, bar: next });
    } else {
      log1m("sync1mCloseFromLast.skip", `bar=${bar ? "yes" : "no"} last=${last}`);
    }
  }

  #publishPartial1mToForming(
    nowSec,
    targetOpen = bucketOpen(nowSec, ONE_MINUTE_PERIOD),
  ) {
    if (!this.#partial1m) {
      log1m("publishPartial1m.skip", "partial1m is null");
      return;
    }
    const bucket = Number(targetOpen);
    if (Number(this.#partial1m.marker) !== bucket) {
      log1m(
        "publishPartial1m.skip",
        `marker mismatch partial=${new Date(Number(this.#partial1m.marker) * 1000).toLocaleString()} bucket=${new Date(bucket * 1000).toLocaleString()}`,
      );
      return;
    }

    const key = resolutionKey(1);
    const bar = {
      ...this.#partial1m,
      marker: bucket,
      period: String(ONE_MINUTE_PERIOD),
      forming: true,
      replaySource: this.#partial1m.replaySource ?? "1m-partial",
    };
    this.#forming.set(key, bar);
    log1mBuild("publishPartial1m", bar, {
      openFrom: `${bar.replaySource ?? "1m-partial"} O=${bar.open}`,
    });
    if (!this.#targets.has(key)) {
      this.#targets.set(key, ONE_MINUTE_PERIOD);
      this.#resolutionByKey.set(key, 1);
    }
    this.emit("formingBar", { resolution: key, bar });
  }

  /** TradeSea: calendar daily/weekly use session open; intraday only caps session low. */
  #applySessionOpenToBar(periodSeconds) {
    return periodSeconds != null && periodSeconds >= 86_400;
  }

  #applySessionLowToBar(periodSeconds) {
    if (periodSeconds == null) return false;
    if (periodSeconds >= 86_400) return true;
    return periodSeconds >= 3600;
  }

  #applySessionHighCapToBar(periodSeconds) {
    return periodSeconds != null && periodSeconds >= 86_400;
  }

  #getSessionStatsFrom1m(sessionOpenSec) {
    const rows = [];
    for (const b of this.#closed1m) {
      if (Number(b.marker) >= sessionOpenSec) rows.push(b);
    }
    if (this.#partial1m && Number(this.#partial1m.marker) >= sessionOpenSec) {
      rows.push(this.#partial1m);
    }
    if (!rows.length) return null;
    return aggregateReplayOHLC(rows, {});
  }

  #resolveSessionStats(nowSec) {
    const sessionOpenSec = chicagoGlobexSessionOpen(nowSec);
    const from1m = this.#getSessionStatsFrom1m(sessionOpenSec);
    if (!from1m) return null;

    const last = Number(this.#session.status?.last);
    const close = isUsablePrice(last) ? last : from1m.close;

    if (!isUsablePrice(from1m.open) && !isUsablePrice(from1m.high) && !isUsablePrice(from1m.low)) {
      return null;
    }
    return { open: from1m.open, high: from1m.high, low: from1m.low, close, sessionOpenSec };
  }

  async #applyTradeSeaSessionCalendar(nowSec, timeoutMs) {
    const stats = this.#resolveSessionStats(nowSec);
    if (!stats) return;

    for (const [key, bar] of this.#forming) {
      const resolution = this.#resolutionByKey.get(key);
      if (resolution !== "1D" && resolution !== "1W") continue;

      const { periodSeconds } = parseResolution(resolution);
      const htfOpen = this.#bucketOpenFor(nowSec, resolution, periodSeconds);
      const next = {
        ...bar,
        marker: htfOpen,
        open: isUsablePrice(stats.open) ? stats.open : bar.open,
        high: isUsablePrice(stats.high) ? stats.high : bar.high,
        low: isUsablePrice(stats.low) ? stats.low : bar.low,
        close: isUsablePrice(stats.close) ? stats.close : bar.close,
        forming: true,
        replaySource: "session-forming",
      };
      this.#forming.set(key, next);
      this.emit("formingBar", { resolution: key, bar: next });
    }
  }

  async #refineFormingExtremesFromTicks(nowSec, timeoutMs) {
    const perBucketMs = Math.min(4000, Math.floor(timeoutMs / 6));
    const jobs = [];

    for (const [key, bar] of this.#forming) {
      const ps = this.#targets.get(key);
      if (ps == null || ps >= 86_400 || !bar) continue;
      if (ps === 14_400) continue;
      // TradeSea minute+ HTF extremes come from 1m rollup; tick replay can spike +1 pt off.
      if (this.#accuracyMode) continue;

      const bucketStart = Number(bar.marker);
      if (!Number.isFinite(bucketStart)) continue;

      jobs.push(
        this.#session
          .replay1mFrom1s(bucketStart, Math.min(bucketStart + ps, nowSec + 120), {
            timeoutMs: perBucketMs,
          })
          .then((secBar) => {
            if (!secBar) return;
            const rollupHigh = Number(bar.high);
            const rollupLow = Number(bar.low);
            const next = { ...bar, forming: true };
            if (isUsablePrice(secBar.high)) {
              next.high = Math.min(Math.max(rollupHigh, Number(secBar.high)), rollupHigh);
            }
            if (isUsablePrice(secBar.low)) {
              next.low = Math.max(Math.min(rollupLow, Number(secBar.low)), rollupLow);
            }
            const src = String(bar.replaySource ?? "rollup");
            next.replaySource = src.includes("1s-refine") ? src : `${src}+1s-refine`;
            this.#forming.set(key, next);
          }),
      );
    }

    await Promise.all(jobs);
  }

  /**
   * TradeSea 4h forming high follows 1m rollup (session low cap only on 4h).
   * Native-1h high override removed ΓÇö it diverged from TradeSea on LucidTrading.
   */
  async #applyTradeSea4hHighFromNativeHourly(_nowSec, _timeoutMs) {
    if (this.#accuracyMode) return;
  }

  async #overlaySessionRangeForHourly() {
    const stats = this.#resolveSessionStats(Math.floor(Date.now() / 1000));
    if (!stats) return;

    const sessionOpen = stats.open;
    const sessionHigh = stats.high;
    const sessionLow = stats.low;

    for (const [key, bar] of this.#forming) {
      const ps = this.#targets.get(key);
      if (ps == null || !bar) continue;

      const applyOpen = this.#applySessionOpenToBar(ps);
      const applyLow = this.#applySessionLowToBar(ps);
      const applyHighCap = this.#applySessionHighCapToBar(ps);
      if (!applyOpen && !applyLow && !applyHighCap) continue;

      if (
        applyLow &&
        !isUsablePrice(sessionLow) &&
        !applyOpen &&
        !applyHighCap
      ) {
        continue;
      }
      if (
        applyOpen &&
        !isUsablePrice(sessionOpen) &&
        !isUsablePrice(sessionHigh) &&
        !isUsablePrice(sessionLow)
      ) {
        continue;
      }

      let next = { ...bar };
      if (applyOpen && isUsablePrice(sessionOpen)) {
        next.open = sessionOpen;
        next.high = Math.max(Number(next.high), sessionOpen);
        next.low = Math.min(Number(next.low), sessionOpen);
      }
      if (applyHighCap && isUsablePrice(sessionHigh)) {
        next.high = Math.min(Number(next.high), sessionHigh);
      }
      if (applyLow && isUsablePrice(sessionLow)) {
        next.low = Math.min(Number(next.low), sessionLow);
      }
      if (
        (applyOpen && isUsablePrice(sessionOpen)) ||
        (applyHighCap && isUsablePrice(sessionHigh)) ||
        (applyLow && isUsablePrice(sessionLow))
      ) {
        next.replaySource = String(bar.replaySource ?? "rollup").includes("session")
          ? next.replaySource
          : `${bar.replaySource ?? "rollup"}+session`;
        this.#forming.set(key, next);
        this.emit("formingBar", { resolution: key, bar: next });
      }
    }
  }

  async #resolveWeeklyAdjust(nowSec, timeoutMs, tradeSeaAccessToken) {
    if (this.#weeklyPriceAdjust != null) return this.#weeklyPriceAdjust;

    const weekYmd = chartBucketRithmicMarker(nowSec, "1W");
    if (this.#useCache) {
      const cached = this.#cache.getWeeklyAdjust(this.#session, weekYmd);
      if (cached != null) {
        this.#weeklyPriceAdjust = cached;
        return cached;
      }
    }

    let nativeClose = this.#scratch.nativeWeeklyClose;
    if (!Number.isFinite(nativeClose)) {
      const nativeWeeks = await this.#session.loadHistory({
        resolution: "1W",
        countback: 2,
        include_forming: false,
        timeoutMs,
      });
      nativeClose = Number(nativeWeeks.at(-1)?.close);
      this.#scratch.nativeWeeklyClose = nativeClose;
    }
    if (!Number.isFinite(nativeClose)) return 0;

    const adjust = await resolveTradeSeaWeeklyAdjust(nativeClose, {
      accessToken: tradeSeaAccessToken,
      nowSec,
    });
    this.#weeklyPriceAdjust = adjust ?? 0;
    if (this.#useCache && this.#weeklyPriceAdjust != null) {
      this.#cache.setWeeklyAdjust(this.#session, weekYmd, this.#weeklyPriceAdjust);
    }
    return this.#weeklyPriceAdjust;
  }

  #oneMinuteInHtfBucket(htfOpen, periodSeconds) {
    const end = htfOpen + periodSeconds;
    const rows = this.#closed1m.filter((b) => {
      const m = Number(b.marker);
      return m >= htfOpen && m < end;
    });
    if (this.#partial1m) {
      const m = Number(this.#partial1m.marker);
      if (m >= htfOpen && m < end) rows.push(this.#partial1m);
    }
    return rows.sort((a, b) => Number(a.marker) - Number(b.marker));
  }
}

export {
  planFormingBootstrap,
  classifyFormingResolution,
  NATIVE_PARTIAL_FROM_SEC,
  ONE_MINUTE_PERIOD,
  resolutionKey,
};
export { FormingBootstrapCache } from "./forming-cache.js";
