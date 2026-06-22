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
export function createBootstrapHourlyOps(s, emit, call) {
  return {
    async run1hShared(req, nowSec, timeoutMs, tradeSeaAccessToken) {
    const history1h = await s.session.loadHistory({
      resolution: 60,
      from: req.from,
      to: nowSec + ONE_HOUR_PERIOD + 120,
      countback: Math.max(req.countback, 5),
      include_forming: true,
      compat: false,
      timeoutMs,
    });

    const split = splitHistoryForForming(history1h, ONE_HOUR_PERIOD, nowSec);
    s.closed1h = split.closed;
    s.partial1h = split.partial;

    const currentHourOpen = bucketOpen(nowSec, ONE_HOUR_PERIOD);
    if (!s.partial1h || Number(s.partial1h.marker) !== currentHourOpen) {
      const from1m = call("seedFromOneMinute", ONE_HOUR_PERIOD, currentHourOpen, 60);
      if (from1m) {
        s.partial1h = {
          ...from1m,
          marker: currentHourOpen,
          period: String(ONE_HOUR_PERIOD),
          forming: true,
          replaySource: "1h-1m-partial",
        };
      } else if (history1h.length) {
        const last = history1h.at(-1);
        if (Number(last.marker) === currentHourOpen) {
          s.partial1h = { ...last, forming: true, replaySource: "1h-partial" };
        }
      }
    }

    for (const key of req.serves) {
      const periodSeconds = s.targets.get(key);
      if (periodSeconds == null) continue;
      const resolution = s.resolutionByKey.get(key);
      const htfOpen = call("bucketOpenFor", nowSec, resolution, periodSeconds);
      let bar = call("seedFromOneHour", periodSeconds, htfOpen, resolution);
      if (!bar) continue;

      const raw = String(resolution).trim().toUpperCase();
      if (raw === "1W" || raw === "W" || raw === "WEEKLY") {
        const adjust = await call("resolveWeeklyAdjust", nowSec, timeoutMs, tradeSeaAccessToken);
        bar = {
          ...shiftBarOHLC(bar, adjust),
          marker: htfOpen,
          forming: true,
          replaySource: adjust ? "1h-week-rollup+ts-adjust" : "1h-week-rollup",
        };
      }

      s.forming.set(key, bar);
      emit("formingBar", { resolution: key, bar });
    }
  },
  };
}
