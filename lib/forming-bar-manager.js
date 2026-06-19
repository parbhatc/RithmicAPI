import { EventEmitter } from "node:events";
import {
  bucketOpen,
  chartBucketOpen,
  isCalendarResolution,
  splitHistoryForForming,
  aggregateReplayOHLC,
  applyTradeToFormingBar,
  calendarBarUnix,
  chartBucketRithmicMarker,
  isUsablePrice,
  chicagoGlobexSessionOpen,
} from "./forming-bar.js";
import { parseResolution } from "./history-query.js";
import { MarketUpdatePreset } from "./market-enums.js";
import { ONE_MINUTE_PERIOD, resolutionKey, patch1mBarOpen } from "./candle-layer.js";
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
 * Universal forming-candle manager — one plan, minimal history requests.
 *
 * | Type | Examples | Bootstrap (per chart) | Live |
 * |------|----------|----------------------|------|
 * | Minutes | 1, 5, 15, 45, 60, 240 | **1 shared** 1m fetch → rollup all | LastTrade |
 * | Daily+ | 1D, 1W, 1M | **1 native partial each** (countback 2) | LastTrade |
 * | Seconds | 5S, 15S, 45S | **1 tick window per period** (bucket→now) | LastTrade |
 * | Tick | 100T, 500T | **1 tick replay per size** | LastTrade (count ticks) |
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
  /** @type {{ daily: object[]|null, nativeWeeklyClose: number|null }} */
  #scratch = { daily: null, nativeWeeklyClose: null };
  /** @type {FormingBootstrapCache} */
  #cache = FormingBootstrapCache.global();
  #useCache = true;
  #fast = false;
  #accuracyMode = false;

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
   * @param {boolean} [options.tickFallback=true] Refine open 1m minute from ticks if history lags
   * @param {number} [options.weeklyPriceAdjust] TradeSea weekly offset (auto-fetched when token set)
   * @param {string} [options.tradeSeaAccessToken] TradeSea cookie token for weekly offset
   * @param {boolean} [options.awaitSession=false] Wait for templates 152/153 before returning
   * @param {boolean} [options.fast=false] Skip tick refine + session wait; overlap live attach with replay
   * @param {boolean} [options.useCache=true] Reuse recent replay results (same symbol/minute)
   * @param {FormingBootstrapCache} [options.cache] Cache instance (default: global)
   * @param {boolean} [options.prefetchLive] Start live feed during bootstrap (default: fast || awaitSession)
   * @param {'default'|'tradesea'} [options.accuracy='default'] `tradesea` = max Rithmic parity (no runtime TS MDS)
   */
  async bootstrap({
    resolutions = [15],
    nowSec = Math.floor(Date.now() / 1000),
    timeoutMs = 45_000,
    tickFallback = true,
    weeklyPriceAdjust = null,
    tradeSeaAccessToken = process.env.TRADESEA_ACCESS_TOKEN,
    awaitSession = false,
    fast = false,
    useCache = true,
    cache = FormingBootstrapCache.global(),
    prefetchLive,
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
    this.#weeklyPriceAdjust = weeklyPriceAdjust;
    this.#tradeSeaAccessToken = tradeSeaAccessToken ?? null;
    this.#cache = cache;
    this.#useCache = useCache;
    this.#fast = fast;
    this.#scratch = { daily: null, nativeWeeklyClose: null };
    this.#accuracyMode = accuracy === "tradesea";

    if (accuracy === "tradesea") {
      fast = false;
      tickFallback = true;
      awaitSession = true;
      if (weeklyPriceAdjust == null && process.env.TRADESEA_WEEKLY_ADJUST != null) {
        weeklyPriceAdjust = Number(process.env.TRADESEA_WEEKLY_ADJUST);
      }
    }

    const tickFallbackEffective = fast ? false : tickFallback;
    const awaitSessionEffective = fast ? false : awaitSession;
    const shouldPrefetchLive =
      prefetchLive ?? (fast || awaitSessionEffective || this.#needsSessionForResolutions(resolutions));

    const planOpts =
      accuracy === "tradesea" ? { nativePartialFromSec: 86_400 } : {};
    this.plan = planFormingBootstrap(resolutions, nowSec, planOpts);

    if (accuracy === "tradesea") {
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

    if (shouldPrefetchLive && !this.#live) {
      await this.attachLive({ updateBits: MarketUpdatePreset.CHART }).catch(() => {});
    }
    await this.#overlaySessionRangeForHourly();

    if (awaitSessionEffective && this.#needsSessionSnapshots()) {
      await this.awaitSessionSnapshots(Math.min(8000, Math.floor(timeoutMs / 3)));
      await this.#overlaySessionRangeForHourly();
    }

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

  #needsSessionForResolutions(resolutions) {
    return resolutions.some((r) => {
      const { periodSeconds } = parseResolution(r);
      return periodSeconds >= 3600 && periodSeconds < 86_400;
    });
  }

  #sortBootstrapRequests(requests) {
    const typeOrder = { "1m-shared": 0, "native-partial": 1, "tick-window": 2, "tick-bar-partial": 3 };
    const nativeOrder = { "1D": 0, "1W": 1, "1M": 2 };

    return [...requests].sort((a, b) => {
      const ta = typeOrder[a.type] ?? 9;
      const tb = typeOrder[b.type] ?? 9;
      if (ta !== tb) return ta - tb;
      if (a.type === "native-partial" && b.type === "native-partial") {
        const ra = nativeOrder[String(a.resolution).toUpperCase()] ?? 9;
        const rb = nativeOrder[String(b.resolution).toUpperCase()] ?? 9;
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

  async attachLive({ updateBits = MarketUpdatePreset.QUOTE } = {}) {
    if (this.#live) return;
    const handler = (trade) => this.onTrade(trade);
    this.#session.on("trade", handler);
    this.#unbind = () => this.#session.off("trade", handler);
    await this.#session.startLive({ updateBits, exactFormingBar: false });
    this.#live = true;
  }

  async detachLive() {
    if (this.#unbind) {
      this.#unbind();
      this.#unbind = null;
    }
    if (this.#live) {
      await this.#session.stopLive();
      this.#live = false;
    }
  }

  async #run1mShared(req, nowSec, timeoutMs, tickFallback) {
    let history1m = null;
    if (this.#useCache) {
      const hit = this.#cache.get1m(
        this.#session,
        req.from,
        req.countback,
        nowSec,
      );
      if (hit) history1m = hit.raw;
    }

    if (!history1m) {
      history1m = await this.#session.loadHistory({
        resolution: 1,
        from: req.from,
        to: nowSec + 120,
        countback: req.countback,
        include_forming: true,
        compat: false,
        timeoutMs,
      });
    }

    const split = splitHistoryForForming(history1m, ONE_MINUTE_PERIOD, nowSec);
    this.#closed1m = split.closed;
    this.#partial1m = split.partial;

    if (this.#useCache) {
      this.#cache.set1m(
        this.#session,
        req.from,
        req.countback,
        nowSec,
        history1m,
        split.closed,
        split.partial,
      );
    }

    const current1mOpen = bucketOpen(nowSec, ONE_MINUTE_PERIOD);
    if (
      tickFallback &&
      (!this.#partial1m || Number(this.#partial1m.marker) !== current1mOpen)
    ) {
      const fromTicks = await this.#session.replay1mFromTicks(
        current1mOpen,
        nowSec + ONE_MINUTE_PERIOD,
        { timeoutMs },
      );
      if (fromTicks) {
        this.#partial1m = { ...fromTicks, forming: true, replaySource: "1m-tick-fallback" };
      }
    }

    if (!this.#fast) {
      await this.#refinePartial1m(nowSec, timeoutMs);
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
      const bar = this.#seedFromOneMinute(periodSeconds, htfOpen, resolution);
      this.#forming.set(key, bar);
      if (bar) this.emit("formingBar", { resolution: key, bar });
    }
  }

  async #refineBucketStartMinute(bucketStartSec, timeoutMs) {
    const marker = bucketOpen(bucketStartSec, ONE_MINUTE_PERIOD);
    const tickOpen = await this.#session.firstTickPriceInRange(
      marker,
      marker + ONE_MINUTE_PERIOD,
      { timeoutMs },
    );
    if (!isUsablePrice(tickOpen)) return;

    if (patch1mBarOpen(this.#closed1m, marker, tickOpen)) return;

    const fromTicks = await this.#session.replay1mFromTicks(
      marker,
      marker + ONE_MINUTE_PERIOD,
      { timeoutMs },
    );
    if (fromTicks) {
      this.#closed1m = [...this.#closed1m, fromTicks].sort(
        (a, b) => Number(a.marker) - Number(b.marker),
      );
    }
  }

  async #refinePartial1m(nowSec, timeoutMs) {
    if (!this.#partial1m) return;
    const marker = Number(this.#partial1m.marker);
    const current1mOpen = bucketOpen(nowSec, ONE_MINUTE_PERIOD);
    if (marker !== current1mOpen) return;

    const fromTicks = await this.#session.replay1mFromTicks(
      marker,
      marker + ONE_MINUTE_PERIOD,
      { timeoutMs },
    );
    if (fromTicks) {
      this.#partial1m = {
        ...fromTicks,
        forming: true,
        replaySource: "1m-tick-partial",
      };
    }
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
        await this.#bootstrapWeekFromDaily(
          req.serves,
          htfOpen,
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

  async #bootstrapWeekFromDaily(keys, htfOpen, nowSec, timeoutMs, tradeSeaAccessToken) {
    const expectedYmd = chartBucketRithmicMarker(nowSec, "1W");
    let daily = this.#scratch.daily;
    if (!daily?.length) {
      daily = await this.#session.loadHistory({
        resolution: "1D",
        countback: 6,
        to: nowSec + 120,
        include_forming: true,
        compat: false,
        timeoutMs,
      });
      this.#scratch.daily = daily;
    }
    const rows = daily
      .filter((b) => Number(b.marker) >= expectedYmd)
      .sort((a, b) => Number(a.marker) - Number(b.marker));
    const rollup = aggregateReplayOHLC(rows, {
      marker: htfOpen,
      periodSeconds: 604_800,
      symbol: this.#session.symbol,
      exchange: this.#session.exchange,
    });
    if (!rollup) {
      await this.#bootstrapFrom1mForKeys(
        keys,
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

    for (const key of keys) {
      const seeded = {
        ...bar,
        marker: htfOpen,
        forming: true,
        replaySource: adjust ? "1D-week-rollup+ts-adjust" : "1D-week-rollup",
      };
      this.#forming.set(key, seeded);
      this.emit("formingBar", { resolution: key, bar: seeded });
    }
  }

  /** When native daily/weekly/monthly replay is empty on this gateway — rollup 1m tail only. */
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
      compat: false,
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
    const rows = this.#oneMinuteInHtfBucket(htfOpen, periodSeconds);
    if (!rows.length) return null;

    const bar = aggregateReplayOHLC(rows, {
      marker: htfOpen,
      periodSeconds,
      symbol: this.#session.symbol,
      exchange: this.#session.exchange,
    });
    if (!bar) return null;

    return { ...bar, forming: true, replaySource: "1m-blind-spot" };
  }

  #bucketOpenFor(nowSec, resolution, periodSeconds) {
    if (resolution != null && isCalendarResolution(resolution)) {
      return chartBucketOpen(nowSec, resolution);
    }
    return bucketOpen(nowSec, periodSeconds);
  }

  /** Apply session 152/153 to hourly forming bars when live snapshots are present. */
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
  }

  /** Push explicit TradeSea LTP into forming closes (from MDS f:2 / f:6). */
  syncFromTradeSeaLast(lastPrice) {
    const last = Number(lastPrice);
    if (!isUsablePrice(last)) return;
    this.#applyLastToFormingCloses(last);
  }

  #applyLastToFormingCloses(last) {
    for (const [key, bar] of this.#forming) {
      const resolution = this.#resolutionByKey.get(key);
      if (resolution === "1M") continue;

      const ps = this.#targets.get(key);
      if (ps == null) continue;

      const next = {
        ...bar,
        close: last,
        high: Math.max(Number(bar.high), last),
        low: Math.min(Number(bar.low), last),
        forming: true,
      };
      this.#forming.set(key, next);
    }
  }

  /** Re-fetch 1m tail and re-seed all minute/hour rollups (live high/low sync). */
  async refreshSharedFrom1m(nowSec = Math.floor(Date.now() / 1000), timeoutMs = 30_000) {
    const req = this.plan?.requests.find((r) => r.type === "1m-shared");
    if (!req) return;
    await this.#run1mShared(req, nowSec, timeoutMs, true);
    await this.#overlaySessionRangeForHourly();
    this.syncFromLastTrade();
  }

  /** Tick-refine the open 1m partial and publish to forming key `1`. */
  async refreshCurrent1m(nowSec = Math.floor(Date.now() / 1000), timeoutMs = 15_000) {
    const current1mOpen = bucketOpen(nowSec, ONE_MINUTE_PERIOD);

    if (!this.#partial1m || Number(this.#partial1m.marker) !== current1mOpen) {
      const history1m = await this.#session.loadHistory({
        resolution: 1,
        countback: 3,
        to: nowSec + 120,
        include_forming: true,
        compat: false,
        timeoutMs,
      });
      const split = splitHistoryForForming(history1m, ONE_MINUTE_PERIOD, nowSec);
      if (split.partial) this.#partial1m = split.partial;
    }

    await this.#refinePartial1m(nowSec, timeoutMs);
    this.#publishPartial1mToForming(nowSec);
    this.syncFromLastTrade();
  }

  #publishPartial1mToForming(nowSec) {
    if (!this.#partial1m) return;
    const current1mOpen = bucketOpen(nowSec, ONE_MINUTE_PERIOD);
    if (Number(this.#partial1m.marker) !== current1mOpen) return;

    const key = resolutionKey(1);
    const bar = {
      ...this.#partial1m,
      marker: current1mOpen,
      period: String(ONE_MINUTE_PERIOD),
      forming: true,
      replaySource: this.#partial1m.replaySource ?? "1m-tick-partial",
    };
    this.#forming.set(key, bar);
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
    const status = this.#session.status;

    let open = Number(status?.latest_open);
    let high = Number(status?.latest_high);
    let low = Number(status?.latest_low);

    if (from1m) {
      if (!isUsablePrice(open)) open = from1m.open;
      if (!isUsablePrice(high)) high = from1m.high;
      if (!isUsablePrice(low)) low = from1m.low;
    }

    const last = Number(status?.last);
    const close = isUsablePrice(last) ? last : from1m?.close;

    if (!isUsablePrice(open) && !isUsablePrice(high) && !isUsablePrice(low)) {
      return null;
    }
    return { open, high, low, close, sessionOpenSec };
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

      const bucketStart = Number(bar.marker);
      if (!Number.isFinite(bucketStart)) continue;

      jobs.push(
        this.#session
          .replay1mFromTicks(bucketStart, Math.min(bucketStart + ps, nowSec + 120), {
            timeoutMs: perBucketMs,
          })
          .then((tickBar) => {
            if (!tickBar) return;
            const next = { ...bar, forming: true };
            if (isUsablePrice(tickBar.high)) {
              next.high = Math.max(Number(next.high), Number(tickBar.high));
            }
            if (isUsablePrice(tickBar.low)) {
              next.low = Math.min(Number(next.low), Number(tickBar.low));
            }
            const src = String(bar.replaySource ?? "rollup");
            next.replaySource = src.includes("tick-refine") ? src : `${src}+tick-refine`;
            this.#forming.set(key, next);
          }),
      );
    }

    await Promise.all(jobs);
  }

  /**
   * TradeSea 4h forming high tracks the prior completed native 1h bar in the bucket
   * (not the whole-bucket 1m rollup max).
   */
  async #applyTradeSea4hHighFromNativeHourly(nowSec, timeoutMs) {
    const currentHourOpen = bucketOpen(nowSec, 3600);

    for (const [key, bar] of this.#forming) {
      const ps = this.#targets.get(key);
      if (ps !== 14_400 || !bar) continue;

      const htfOpen = Number(bar.marker);
      if (!Number.isFinite(htfOpen)) continue;

      let targetHour = currentHourOpen - 3600;
      if (targetHour < htfOpen) targetHour = currentHourOpen;

      let bars1h = null;
      if (this.#useCache) {
        bars1h = this.#cache.getNative(
          this.#session,
          60,
          targetHour,
          nowSec,
        );
      }
      if (!bars1h) {
        bars1h = await this.#session.loadHistory({
          resolution: 60,
          countback: 6,
          to: nowSec + 120,
          include_forming: true,
          compat: false,
          timeoutMs: Math.min(timeoutMs, 12_000),
        });
        if (this.#useCache && bars1h?.length) {
          this.#cache.setNative(this.#session, 60, targetHour, nowSec, bars1h);
        }
      }

      const hourBar =
        bars1h?.find((b) => Number(b.marker) === targetHour) ?? bars1h?.at(-1);
      if (!hourBar || Number(hourBar.marker) < htfOpen) continue;

      const nativeHigh = Number(hourBar.high);
      if (!isUsablePrice(nativeHigh)) continue;

      const next = {
        ...bar,
        high: nativeHigh,
        replaySource: String(bar.replaySource ?? "rollup").includes("4h-native-1h-high")
          ? bar.replaySource
          : `${bar.replaySource ?? "rollup"}+4h-native-1h-high`,
      };
      this.#forming.set(key, next);
      this.emit("formingBar", { resolution: key, bar: next });
    }
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

  /** Subscribe briefly for templates 152/153 (hourly TradeSea-style caps). */
  async awaitSessionSnapshots(timeoutMs = 8000) {
    if (!this.#needsSessionSnapshots()) return;
    if (!this.#live) {
      await this.attachLive({ updateBits: MarketUpdatePreset.CHART });
    }

    if (isUsablePrice(this.#session.status?.latest_high)) return;

    await new Promise((resolve) => {
      const done = () => {
        this.#session.off("latest_high_low", onHl);
        this.#session.off("latest_open", onOpen);
        clearTimeout(timer);
        resolve();
      };
      const onHl = () => {
        if (isUsablePrice(this.#session.status?.latest_high)) done();
      };
      const onOpen = () => {
        if (isUsablePrice(this.#session.status?.latest_open)) onHl();
      };
      this.#session.on("latest_high_low", onHl);
      this.#session.on("latest_open", onOpen);
      const timer = setTimeout(done, timeoutMs);
      if (isUsablePrice(this.#session.status?.latest_high)) done();
    });
  }

  #needsSessionSnapshots() {
    if (this.#accuracyMode) {
      return [...this.#targets.values()].some(
        (ps) => ps != null && ps >= 3600,
      );
    }
    return [...this.#targets.values()].some(
      (ps) => ps != null && ps >= 3600 && ps < 86_400,
    );
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
