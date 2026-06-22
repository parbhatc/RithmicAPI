import { EventEmitter } from "node:events";
import {
  bucketOpen,
  chartBucketOpen,
  isCalendarResolution,
  splitHistoryForForming,
  applyTradeToFormingBar,
  isUsablePrice,
  chicagoGlobexSessionOpen,
} from "../forming-bar.js";
import { parseResolution } from "../history-query.js";
import { MarketUpdatePreset } from "../market-enums.js";
import { ONE_MINUTE_PERIOD, resolutionKey } from "../candle-layer.js";
import { fmt1mBar, log1m, fmtSec } from "../forming-1m-debug.js";
import {
  planFormingBootstrap,
  classifyFormingResolution,
  NATIVE_PARTIAL_FROM_SEC,
} from "../forming-strategy.js";
import { FormingBootstrapCache } from "../forming-cache.js";
import { createFormingState } from "./state.js";
import { createOps } from "./ops.js";

/**
 * Universal forming-candle manager — one plan, minimal history requests.
 */
export class FormingBarManager extends EventEmitter {
  /** @type {import("./state.js").FormingState} */
  #s;
  /** @type {ReturnType<typeof createOps>} */
  #ops;

  constructor(session) {
    super();
    this.#s = createFormingState(session);
    this.#ops = createOps(this.#s, (event, payload) => this.emit(event, payload));
  }

  get session() {
    return this.#s.session;
  }

  get closed1m() {
    return this.#s.closed1m;
  }

  get resolutions() {
    return [...this.#s.targets.keys()];
  }

  get plan() {
    return this.#s.plan;
  }

  set plan(value) {
    this.#s.plan = value;
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
    this.#s.targets.clear();
    this.#s.classes.clear();
    this.#s.tickSizes.clear();
    this.#s.resolutionByKey.clear();
    this.#s.forming.clear();
    this.#s.tickCounts.clear();
    this.#s.closed1m = [];
    this.#s.partial1m = null;
    this.#s.closed1h = [];
    this.#s.partial1h = null;
    this.#s.weeklyPriceAdjust = weeklyPriceAdjust;
    this.#s.tradeSeaAccessToken = tradeSeaAccessToken ?? null;
    this.#s.cache = cache;
    this.#s.useCache = useCache;
    this.#s.fast = fast;
    this.#s.scratch = { daily: null, monthly: null, nativeWeeklyClose: null };
    this.#s.accuracyMode = accuracy === "tradesea";

    if (accuracy === "tradesea") {
      fast = false;
      tickFallback = true;
      if (weeklyPriceAdjust == null && process.env.TRADESEA_WEEKLY_ADJUST != null) {
        weeklyPriceAdjust = Number(process.env.TRADESEA_WEEKLY_ADJUST);
      }
    }

    const tickFallbackEffective = fast ? false : tickFallback;

    this.#s.plan = planFormingBootstrap(resolutions, nowSec);

    if (accuracy === "tradesea" && this.#ops.needsSession1mTickRefine(resolutions)) {
      const sessionFrom = chicagoGlobexSessionOpen(nowSec);
      for (const req of this.#s.plan.requests) {
        if (req.type !== "1m-shared") continue;
        req.from = Math.min(req.from, sessionFrom);
        req.countback = Math.max(
          req.countback,
          Math.ceil((nowSec - req.from) / ONE_MINUTE_PERIOD) + 3,
        );
      }
    }
    const bucketOpens = {};

    for (const c of this.#s.plan.classes) {
      this.#s.classes.set(c.key, c);
      this.#s.targets.set(c.key, c.periodSeconds);
      this.#s.resolutionByKey.set(c.key, c.resolution);
      if (c.tickSize != null && c.mode === "tick-bar-partial") {
        this.#s.tickSizes.set(c.key, c.tickSize);
      }
      if (c.periodSeconds != null) {
        bucketOpens[c.key] = isCalendarResolution(c.resolution)
          ? chartBucketOpen(nowSec, c.resolution)
          : bucketOpen(nowSec, c.periodSeconds);
      }
    }

    const requests = this.#sortBootstrapRequests(this.#s.plan.requests);

    for (const req of requests) {
      switch (req.type) {
        case "1m-shared":
          await this.#ops.run1mShared(req, nowSec, timeoutMs, tickFallbackEffective);
          break;
        case "1h-shared":
          await this.#ops.run1hShared(req, nowSec, timeoutMs, tradeSeaAccessToken);
          break;
        case "1D-shared":
          await this.#ops.runDailyShared(req, nowSec, timeoutMs, tradeSeaAccessToken);
          break;
        case "1M-shared":
          await this.#ops.runMonthlyShared(req, nowSec, timeoutMs);
          break;
        case "native-partial":
          await this.#ops.runNativePartial(req, nowSec, timeoutMs, tradeSeaAccessToken);
          break;
        case "tick-window":
          await this.#ops.runTickWindow(req, nowSec, timeoutMs);
          break;
        case "tick-bar-partial":
          await this.#ops.runTickBarPartial(req, nowSec, timeoutMs);
          break;
        default:
          break;
      }
    }

    if (prefetchLive && !this.#s.live) {
      await this.attachLive({ updateBits: MarketUpdatePreset.QUOTE }).catch(() => {});
    }
    await this.#ops.overlaySessionRangeForHourly();

    if (this.#s.accuracyMode) {
      await this.#ops.applyTradeSeaSessionCalendar(nowSec, timeoutMs);
      await this.#ops.refineFormingExtremesFromTicks(nowSec, timeoutMs);
      await this.#ops.applyTradeSea4hHighFromNativeHourly(nowSec, timeoutMs);
    }

    return {
      plan: this.#s.plan,
      closed1m: this.#s.closed1m,
      partial1m: this.#s.partial1m,
      forming: new Map(this.#s.forming),
      bucketOpens,
    };
  }

  getForming(resolution) {
    const bar = this.#s.forming.get(resolutionKey(resolution));
    return bar ? { ...bar } : null;
  }

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
      symbol: this.#s.session.symbol,
      exchange: this.#s.session.exchange,
    };

    this.#s.forming.set(key, bar);
    if (!this.#s.resolutionByKey.has(key)) {
      this.#s.resolutionByKey.set(key, resolution);
      this.#s.targets.set(key, periodSeconds);
    }
    this.emit("formingBar", { resolution: key, bar });
    return { ...bar };
  }

  getAllForming() {
    const out = {};
    for (const [key, bar] of this.#s.forming) {
      if (bar) out[key] = { ...bar };
    }
    return out;
  }

  onTrade(trade) {
    const changed = new Map();
    for (const [key, periodSeconds] of this.#s.targets) {
      const cls = this.#s.classes.get(key);
      const tickSize = this.#s.tickSizes.get(key);

      if (cls?.mode === "tick-bar-partial" && tickSize) {
        const next = this.#ops.applyTradeToTickBar(key, trade, tickSize);
        if (next) {
          this.#s.forming.set(key, next);
          changed.set(key, next);
          this.emit("formingBar", { resolution: key, bar: next });
        }
        continue;
      }

      if (periodSeconds == null) continue;

      const resolution = this.#s.resolutionByKey.get(key);
      const is1m =
        resolution === 1 ||
        resolution === "1" ||
        periodSeconds === ONE_MINUTE_PERIOD ||
        key === "1";
      if (this.#s.accuracyMode && is1m) {
        if (this.#s.live) {
          this.#ops.record1mTrade(trade);
          const ssboe = Number(trade?.ssboe);
          const now =
            Number.isFinite(ssboe) && ssboe > 0
              ? ssboe
              : Math.floor(Date.now() / 1000);
          const marker = bucketOpen(now, ONE_MINUTE_PERIOD);
          const prev = this.#s.forming.get(key);
          let seedOpen;
          if (prev && Number(prev.marker) === marker && isUsablePrice(prev.open)) {
            seedOpen = prev.open;
          } else {
            if (prev && Number(prev.marker) < marker) {
              this.#ops.commitClosed1m(prev);
            }
            // First trade in the minute sets open (not prior close).
            seedOpen = undefined;
          }
          const next = applyTradeToFormingBar(prev, trade, {
            periodSeconds: ONE_MINUTE_PERIOD,
            symbol: this.#s.session.symbol,
            exchange: this.#s.session.exchange,
            seedOpen,
            chartResolution: resolution,
          });
          if (next && next !== prev) {
            this.#s.forming.set(key, next);
            this.#s.partial1m = { ...next };
            changed.set(key, next);
            this.emit("formingBar", { resolution: key, bar: next });
          }
        }
        continue;
      }

      if (isCalendarResolution(resolution) && resolution !== "1M" && resolution !== "1m") {
        continue;
      }

      const prev = this.#s.forming.get(key);
      const next = applyTradeToFormingBar(prev, trade, {
        periodSeconds,
        symbol: this.#s.session.symbol,
        exchange: this.#s.session.exchange,
        seedOpen: prev?.open,
        chartResolution: this.#s.resolutionByKey.get(key),
      });
      if (next && next !== prev) {
        this.#s.forming.set(key, next);
        changed.set(key, next);
        this.emit("formingBar", { resolution: key, bar: next });
      }
    }
    return changed;
  }

  async attachLive({ updateBits = MarketUpdatePreset.QUOTE, skipStartLive = false } = {}) {
    if (this.#s.live) return;
    const handler = (trade) => {
      this.onTrade(trade);
      this.syncFromLastTrade();
    };
    this.#s.session.on("trade", handler);
    this.#s.unbind = () => this.#s.session.off("trade", handler);
    this.#s.skipStopLive = skipStartLive;
    if (!skipStartLive) {
      await this.#s.session.startLive({ updateBits, exactFormingBar: false });
    }
    this.#s.live = true;
  }

  async detachLive() {
    if (this.#s.unbind) {
      this.#s.unbind();
      this.#s.unbind = null;
    }
    if (this.#s.live && !this.#s.skipStopLive) {
      await this.#s.session.stopLive();
    }
    this.#s.live = false;
    this.#s.skipStopLive = false;
  }

  async applySessionOverlay() {
    await this.#ops.overlaySessionRangeForHourly();
    if (this.#s.accuracyMode) {
      await this.#ops.applyTradeSea4hHighFromNativeHourly(
        Math.floor(Date.now() / 1000),
        8000,
      );
    }
  }

  syncFromLastTrade() {
    const last = Number(this.#s.session.status?.last);
    if (!isUsablePrice(last)) return;
    this.#ops.applyLastToFormingCloses(last);
    this.#ops.maybeRefine1mOpenFrom1s();
  }

  syncFromTradeSeaLast(lastPrice) {
    const last = Number(lastPrice);
    if (!isUsablePrice(last)) return;
    this.#ops.applyLastToFormingCloses(last);
  }

  async refreshSharedFrom1m(nowSec = Math.floor(Date.now() / 1000), timeoutMs = 30_000) {
    const req = this.#s.plan?.requests.find((r) => r.type === "1m-shared");
    if (!req) return;
    await this.#ops.run1mShared(req, nowSec, timeoutMs, true);
    await this.#ops.overlaySessionRangeForHourly();
    this.syncFromLastTrade();
  }

  async refreshSharedFrom1h(nowSec = Math.floor(Date.now() / 1000), timeoutMs = 30_000) {
    const req = this.#s.plan?.requests.find((r) => r.type === "1h-shared");
    if (!req) return;
    await this.#ops.run1hShared(req, nowSec, timeoutMs, this.#s.tradeSeaAccessToken);
    await this.#ops.overlaySessionRangeForHourly();
    this.syncFromLastTrade();
  }

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
          const existing = this.#s.forming.get(key);
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
    const existing = this.#s.forming.get(key);
    if (existing && Number(existing.marker) < targetOpen) {
      log1m(
        "refreshCurrent1m.roll",
        `commit ${fmtSec(Number(existing.marker))} → new bucket ${fmtSec(targetOpen)}`,
      );
      this.#ops.commitClosed1m(existing);
      this.#s.forming.delete(key);
      this.#s.partial1m = null;
    }

    log1m(
      "refreshCurrent1m.start",
      `now=${new Date(nowSec * 1000).toLocaleString()} bucket=${new Date(targetOpen * 1000).toLocaleString()}`,
    );

    if (this.#s.accuracyMode) {
      const current = this.#s.forming.get(key);
      if (current && Number(current.marker) === targetOpen) {
        log1m("refreshCurrent1m.path", "close-only (forming bar already on bucket)");
        this.#ops.sync1mCloseFromLast();
        log1m("refreshCurrent1m.final", fmt1mBar(this.#s.forming.get(key)));
        return;
      }
      if (rollover && this.#s.live) {
        log1m(
          "refreshCurrent1m.path",
          "live rollover — first-tick seed (skip 1s)",
        );
        await this.#ops.seedRollover1mPartial(nowSec, timeoutMs, targetOpen);
        this.#ops.publishPartial1mToForming(nowSec, targetOpen);
        this.#ops.sync1mCloseFromLast();
        log1m("refreshCurrent1m.final", fmt1mBar(this.#s.forming.get(key)));
        return;
      }
      const havePartial =
        this.#s.partial1m && Number(this.#s.partial1m.marker) === targetOpen;
      log1m(
        "refreshCurrent1m.path",
        havePartial
          ? `partial exists — refine from 1s ${fmt1mBar(this.#s.partial1m)}`
          : "buildPartial1mFrom1s (no partial for bucket)",
      );
      const replayMs = rollover ? Math.min(3000, timeoutMs) : timeoutMs;
      await this.#ops.buildPartial1mFrom1s(nowSec, replayMs, targetOpen);
      if (!this.#s.partial1m || Number(this.#s.partial1m.marker) !== targetOpen) {
        if (rollover) {
          await this.#ops.seedRollover1mPartial(nowSec, replayMs, targetOpen);
        } else {
          await this.#ops.ensure1mPartial(nowSec, timeoutMs, targetOpen);
        }
      }
      this.#ops.publishPartial1mToForming(nowSec, targetOpen);
      this.#ops.sync1mCloseFromLast();
      log1m("refreshCurrent1m.final", fmt1mBar(this.#s.forming.get(key)));
      if (rollover && !this.#s.live) {
        void this.#ops.refineRollover1m(nowSec, timeoutMs, targetOpen);
      }
      return;
    }

    const havePartial =
      this.#s.partial1m && Number(this.#s.partial1m.marker) === targetOpen;

    if (!havePartial) {
      try {
        const history1m = await this.#s.session.loadHistory({
          resolution: 1,
          countback: 4,
          to: nowSec + 60,
          include_forming: true,
          compat: this.#ops.compat1m(),
          timeoutMs: Math.min(8000, timeoutMs),
        });
        const split = splitHistoryForForming(history1m, ONE_MINUTE_PERIOD, nowSec);
        let partial = split.partial;
        if (!partial && history1m.length) {
          const last = history1m.at(-1);
          if (Number(last.marker) === targetOpen) partial = last;
        }
        if (partial) {
          this.#s.partial1m = {
            ...partial,
            forming: true,
            replaySource: "1m-partial",
          };
        }
      } catch {
        /* keep existing partial if any */
      }
      if (!this.#s.partial1m || Number(this.#s.partial1m.marker) !== targetOpen) {
        await this.#ops.ensure1mPartial(nowSec, timeoutMs, targetOpen);
      }
    }

    await this.#ops.refinePartial1m(nowSec, timeoutMs);
    this.#ops.publishPartial1mToForming(nowSec, targetOpen);
    this.#ops.sync1mCloseFromLast();
  }

}

export {
  planFormingBootstrap,
  classifyFormingResolution,
  NATIVE_PARTIAL_FROM_SEC,
  ONE_MINUTE_PERIOD,
  resolutionKey,
};
export { FormingBootstrapCache } from "../forming-cache.js";
