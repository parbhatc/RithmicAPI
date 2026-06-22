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
} from "../forming-bar.js";
import { parseResolution } from "../history-query.js";
import { ONE_MINUTE_PERIOD, ONE_HOUR_PERIOD, TWO_HOUR_PERIOD, resolutionKey, patch1mBarOpen } from "../candle-layer.js";
import { fmt1mBar, log1m, log1mBars, log1mBuild, fmtSec, fmtSubBar } from "../forming-1m-debug.js";
import { aggregatePartialTickForming } from "../forming-reconstruct.js";
import { tickBarTime } from "../market-views.js";
import { ReplayDirection, ReplayTimeOrder } from "../market-enums.js";

/** @param {import("./state.js").FormingState} s */
export function createBootstrapNativeOps(s, emit, call) {
  return {
    async runNativePartial(req, nowSec, timeoutMs, tradeSeaAccessToken) {
    const { periodSeconds } = parseResolution(req.resolution);
    const htfOpen = call("bucketOpenFor", nowSec, req.resolution, periodSeconds);
    const cal = isCalendarResolution(req.resolution);
    const expectedYmd = cal ? chartBucketRithmicMarker(nowSec, req.resolution) : null;
    const cacheMarker = cal ? expectedYmd : htfOpen;

    let bars = null;
    if (s.useCache) {
      bars = s.cache.getNative(
        s.session,
        req.resolution,
        cacheMarker,
        nowSec,
      );
    }

    if (!bars) {
      bars = await s.session.loadHistory({
        resolution: req.resolution,
        countback: req.countback,
        to: nowSec + 120,
        include_forming: true,
        compat: false,
        timeoutMs,
      });
      if (s.useCache && bars?.length) {
        s.cache.setNative(
          s.session,
          req.resolution,
          cacheMarker,
          nowSec,
          bars,
        );
      }
    }

    if (String(req.resolution).toUpperCase() === "1D" && bars?.length) {
      s.scratch.daily = bars;
    }
    if (String(req.resolution).toUpperCase() === "1W" && bars?.length) {
      s.scratch.nativeWeeklyClose = Number(bars.at(-1)?.close);
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
        await call("seedWeekFromDaily", 
          req.serves[0],
          htfOpen,
          call("dailyRowsWithForming1m", s.scratch.daily ?? [], nowSec),
          nowSec,
          timeoutMs,
          tradeSeaAccessToken,
        );
        return;
      }
      await bootstrapFrom1mForKeys(
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
      s.forming.set(key, bar);
      emit("formingBar", { resolution: key, bar });
    }
  },
    async bootstrapFrom1mForKeys(keys, resolution, periodSeconds, htfOpen, nowSec, timeoutMs) {
    const elapsed = Math.ceil((nowSec - htfOpen) / ONE_MINUTE_PERIOD) + 3;
    const maxCountback = isCalendarResolution(resolution) ? 1500 : 500;
    const countback = Math.min(maxCountback, Math.max(5, elapsed));
    const history1m = await s.session.loadHistory({
      resolution: 1,
      from: htfOpen,
      to: nowSec + 120,
      countback,
      include_forming: true,
      compat: call("compat1m", ),
      timeoutMs,
    });
    const split = splitHistoryForForming(history1m, ONE_MINUTE_PERIOD, nowSec);
    const savedClosed = s.closed1m;
    const savedPartial = s.partial1m;
    s.closed1m = split.closed;
    s.partial1m = split.partial;

    for (const key of keys) {
      const bar = call("seedFromOneMinute", periodSeconds, htfOpen, resolution);
      if (bar) {
        bar.replaySource = "1m-fallback";
        s.forming.set(key, bar);
        emit("formingBar", { resolution: key, bar });
      }
    }

    if (!savedClosed.length) s.closed1m = split.closed;
    else s.closed1m = savedClosed;
    if (!savedPartial) s.partial1m = split.partial;
    else s.partial1m = savedPartial;
  },
    async runTickWindow(req, nowSec, timeoutMs) {
    const periodSeconds = req.periodSeconds;
    const ticks = await s.session.loadTickHistory({
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
      symbol: s.session.symbol,
      exchange: s.session.exchange,
    });

    if (!bar) return;

    const seeded = { ...bar, forming: true, replaySource: "tick-window" };
    for (const key of req.serves) {
      s.forming.set(key, { ...seeded, period: String(periodSeconds) });
      emit("formingBar", { resolution: key, bar: s.forming.get(key) });
    }
  },
    async runTickBarPartial(req, nowSec, timeoutMs) {
    const tickSize = req.tickSize;
    const windowSec = Math.min(900, Math.max(120, tickSize * 2));
    const ticks = await s.session.loadTickHistory({
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
      symbol: s.session.symbol,
      exchange: s.session.exchange,
      forming: true,
      replaySource: `${tickSize}T-tick-partial`,
      tickSize,
    };

    for (const key of req.serves) {
      s.forming.set(key, seeded);
      s.tickCounts.set(key, ticks.length % tickSize);
      emit("formingBar", { resolution: key, bar: seeded });
    }
  },
    applyTradeToTickBar(key, trade, tickSize) {
    const price = Number(trade?.price);
    if (!Number.isFinite(price)) return null;

    let bar = s.forming.get(key);
    let count = (s.tickCounts.get(key) ?? 0) + 1;

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
        symbol: s.session.symbol,
        exchange: s.session.exchange,
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
      s.tickCounts.set(key, 0);
      emit("bar", { resolution: key, bar: { ...bar, forming: false } });
      return {
        marker: tickBarTime(trade) || Date.now() / 1000,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: Number(trade?.size ?? 0),
        forming: true,
        tickSize,
        symbol: s.session.symbol,
        exchange: s.session.exchange,
      };
    }

    s.tickCounts.set(key, count);
    return bar;
  },
  };
}
