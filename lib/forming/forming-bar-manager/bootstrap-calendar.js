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
import { shiftBarOHLC } from "../shift-bar-ohlc.js";

/** @param {import("./state.js").FormingState} s */
export function createBootstrapCalendarOps(s, emit, externalCall) {
  const ops = {};
  const call = (name, ...args) => {
    const fn = ops[name];
    if (fn) return fn(...args);
    return externalCall(name, ...args);
  };

  ops.runDailyShared = async function runDailyShared(req, nowSec, timeoutMs, tradeSeaAccessToken) {
    let daily = s.scratch.daily;
    if (!daily?.length) {
      daily = await s.session.loadHistory({
        resolution: "1D",
        countback: req.countback,
        to: nowSec + 120,
        include_forming: true,
        compat: false,
        timeoutMs,
      });
      s.scratch.daily = daily;
    }

    const dailyRows = ops.dailyRowsWithForming1m(daily, nowSec);

    for (const key of req.serves) {
      const resolution = s.resolutionByKey.get(key);
      const { periodSeconds } = parseResolution(resolution);
      const htfOpen = call("bucketOpenFor", nowSec, resolution, periodSeconds);
      const raw = String(resolution).trim().toUpperCase();

      if (raw === "1W" || raw === "W" || raw === "WEEKLY") {
        await ops.seedWeekFromDaily(
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
        ops.seedMonthFromDaily(key, htfOpen, dailyRows, periodSeconds);
      }
    }
  };

  ops.runMonthlyShared = async function runMonthlyShared(req, nowSec, timeoutMs) {
    let monthly = s.scratch.monthly;
    if (!monthly?.length) {
      monthly = await s.session.loadHistory({
        resolution: "1M",
        countback: req.countback,
        to: nowSec + 120,
        include_forming: true,
        compat: false,
        timeoutMs,
      });
      s.scratch.monthly = monthly;
    }

    for (const key of req.serves) {
      const resolution = s.resolutionByKey.get(key);
      const { periodSeconds } = parseResolution(resolution);
      const htfOpen = call("bucketOpenFor", nowSec, resolution, periodSeconds);
      const rows = monthly
        .filter((b) => calendarBarUnix(b.marker, "1M") >= htfOpen)
        .sort(
          (a, b) =>
            calendarBarUnix(a.marker, "1M") - calendarBarUnix(b.marker, "1M"),
        );
      const rollup = aggregateReplayOHLC(rows, {
        marker: htfOpen,
        periodSeconds,
        symbol: s.session.symbol,
        exchange: s.session.exchange,
      });
      if (!rollup) continue;

      const bar = {
        ...rollup,
        marker: htfOpen,
        period: String(periodSeconds),
        forming: true,
        replaySource: "1M-year-rollup",
      };
      s.forming.set(key, bar);
      emit("formingBar", { resolution: key, bar });
    }
  };

  ops.dailyRowsWithForming1m = function dailyRowsWithForming1m(daily, nowSec) {
    const todayOpen = chartBucketOpen(nowSec, "1D");
    const todayYmd = chartBucketRithmicMarker(nowSec, "1D");
    const rows = [...(daily ?? [])];
    const hasToday = rows.some((b) => {
      const m = Number(b.marker);
      return m === todayYmd || calendarBarUnix(m, "1D") === todayOpen;
    });
    if (!hasToday) {
      const derived = ops.deriveFormingDailyFrom1m(todayOpen, nowSec);
      if (derived) rows.push(derived);
    }
    return rows.sort(
      (a, b) => calendarBarUnix(a.marker, "1D") - calendarBarUnix(b.marker, "1D"),
    );
  };

  ops.deriveFormingDailyFrom1m = function deriveFormingDailyFrom1m(dayOpen, nowSec) {
    const rows = [];
    for (const b of s.closed1m) {
      if (Number(b.marker) >= dayOpen) rows.push(b);
    }
    if (s.partial1m && Number(s.partial1m.marker) >= dayOpen) {
      rows.push(s.partial1m);
    }
    if (!rows.length) return null;

    const bar = aggregateReplayOHLC(rows, {
      marker: chartBucketRithmicMarker(nowSec, "1D"),
      periodSeconds: 86_400,
      symbol: s.session.symbol,
      exchange: s.session.exchange,
    });
    if (!bar) return null;
    return { ...bar, forming: true, replaySource: "1m-daily-rollup" };
  };

  ops.seedWeekFromDaily = async function seedWeekFromDaily(key, htfOpen, dailyRows, nowSec, timeoutMs, tradeSeaAccessToken) {
    const weekYmd = chartBucketRithmicMarker(nowSec, "1W");
    const rows = dailyRows
      .filter((b) => Number(b.marker) >= weekYmd)
      .sort((a, b) => Number(a.marker) - Number(b.marker));
    const rollup = aggregateReplayOHLC(rows, {
      marker: htfOpen,
      periodSeconds: 604_800,
      symbol: s.session.symbol,
      exchange: s.session.exchange,
    });
    if (!rollup) {
      await call("bootstrapFrom1mForKeys", 
        [key],
        "1W",
        604_800,
        htfOpen,
        nowSec,
        timeoutMs,
      );
      return;
    }

    const adjust = await call("resolveWeeklyAdjust", nowSec, timeoutMs, tradeSeaAccessToken);
    const bar = shiftBarOHLC(rollup, adjust);
    const seeded = {
      ...bar,
      marker: htfOpen,
      forming: true,
      replaySource: adjust ? "1D-week-rollup+ts-adjust" : "1D-week-rollup",
    };
    s.forming.set(key, seeded);
    emit("formingBar", { resolution: key, bar: seeded });
  };

  ops.seedMonthFromDaily = function seedMonthFromDaily(key, htfOpen, dailyRows, periodSeconds) {
    const rows = dailyRows.filter(
      (b) => calendarBarUnix(b.marker, "1D") >= htfOpen,
    );
    const rollup = aggregateReplayOHLC(rows, {
      marker: htfOpen,
      periodSeconds,
      symbol: s.session.symbol,
      exchange: s.session.exchange,
    });
    if (!rollup) return;

    const bar = {
      ...rollup,
      marker: htfOpen,
      period: String(periodSeconds),
      forming: true,
      replaySource: "1D-month-rollup",
    };
    s.forming.set(key, bar);
    emit("formingBar", { resolution: key, bar });
  };

  return ops;
}
