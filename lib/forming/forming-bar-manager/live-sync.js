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
export function createLiveSyncOps(s, emit, call) {
  return {
    isStaleBoundaryLast(bar, last, nowSec = Math.floor(Date.now() / 1000)) {
    const marker = Number(bar?.marker);
    if (!Number.isFinite(marker) || !isUsablePrice(last)) return false;
    if (nowSec - marker > 5) return false;

    const prev = s.closed1m.at(-1);
    if (!prev) return false;
    if (Number(prev.marker) !== marker - ONE_MINUTE_PERIOD) return false;

    const prevClose = Number(prev.close);
    return isUsablePrice(prevClose) && Math.abs(last - prevClose) < 0.01;
  },
    applyLastToFormingCloses(last) {
    const nowSec = Math.floor(Date.now() / 1000);
    const current1mOpen = bucketOpen(nowSec, ONE_MINUTE_PERIOD);
    for (const [key, bar] of s.forming) {
      const resolution = s.resolutionByKey.get(key);
      if (resolution === "1M") continue;

      const ps = s.targets.get(key);
      if (ps == null) continue;

      if (
        (resolution === 1 || resolution === "1" || ps === ONE_MINUTE_PERIOD) &&
        Number(bar.marker) < current1mOpen
      ) {
        continue;
      }

      const is1m =
        resolution === 1 || resolution === "1" || ps === ONE_MINUTE_PERIOD;
      if (s.accuracyMode && is1m && call("isStaleBoundaryLast", bar, last, nowSec)) {
        log1m("applyLastToFormingCloses.skip", `stale boundary last=${last}`);
        continue;
      }

      let next;
      if (s.accuracyMode && (resolution === 1 || resolution === "1" || ps === ONE_MINUTE_PERIOD)) {
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

      s.forming.set(key, next);
      emit("formingBar", { resolution: key, bar: next });
    }
  },
  };
}
