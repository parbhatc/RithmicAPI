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

const tradeseaWeekAdjustUrl = new URL("../../../testing/tradesea/week-adjust.js", import.meta.url);

/** @param {import("./state.js").FormingState} s */
export function createSessionOps(s, emit, call) {
  return {
    applySessionOpenToBar(periodSeconds) {
    return periodSeconds != null && periodSeconds >= 86_400;
  },
    applySessionLowToBar(periodSeconds) {
    if (periodSeconds == null) return false;
    if (periodSeconds >= 86_400) return true;
    return periodSeconds >= 3600;
  },
    applySessionHighCapToBar(periodSeconds) {
    return periodSeconds != null && periodSeconds >= 86_400;
  },
    getSessionStatsFrom1m(sessionOpenSec) {
    const rows = [];
    for (const b of s.closed1m) {
      if (Number(b.marker) >= sessionOpenSec) rows.push(b);
    }
    if (s.partial1m && Number(s.partial1m.marker) >= sessionOpenSec) {
      rows.push(s.partial1m);
    }
    if (!rows.length) return null;
    return aggregateReplayOHLC(rows, {});
  },
    resolveSessionStats(nowSec) {
    const sessionOpenSec = chicagoGlobexSessionOpen(nowSec);
    const from1m = call("getSessionStatsFrom1m", sessionOpenSec);
    if (!from1m) return null;

    const last = Number(s.session.status?.last);
    const close = isUsablePrice(last) ? last : from1m.close;

    if (!isUsablePrice(from1m.open) && !isUsablePrice(from1m.high) && !isUsablePrice(from1m.low)) {
      return null;
    }
    return { open: from1m.open, high: from1m.high, low: from1m.low, close, sessionOpenSec };
  },
    async applyTradeSeaSessionCalendar(nowSec, timeoutMs) {
    const stats = call("resolveSessionStats", nowSec);
    if (!stats) return;

    for (const [key, bar] of s.forming) {
      const resolution = s.resolutionByKey.get(key);
      if (resolution !== "1D" && resolution !== "1W") continue;

      const { periodSeconds } = parseResolution(resolution);
      const htfOpen = call("bucketOpenFor", nowSec, resolution, periodSeconds);
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
      s.forming.set(key, next);
      emit("formingBar", { resolution: key, bar: next });
    }
  },
    async refineFormingExtremesFromTicks(nowSec, timeoutMs) {
    const perBucketMs = Math.min(4000, Math.floor(timeoutMs / 6));
    const jobs = [];

    for (const [key, bar] of s.forming) {
      const ps = s.targets.get(key);
      if (ps == null || ps >= 86_400 || !bar) continue;
      if (ps === 14_400) continue;
      // TradeSea minute+ HTF extremes come from 1m rollup; tick replay can spike +1 pt off.
      if (s.accuracyMode) continue;

      const bucketStart = Number(bar.marker);
      if (!Number.isFinite(bucketStart)) continue;

      jobs.push(
        s.session
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
            s.forming.set(key, next);
          }),
      );
    }

    await Promise.all(jobs);
  },
    async applyTradeSea4hHighFromNativeHourly(_nowSec, _timeoutMs) {
    if (s.accuracyMode) return;
  },
    async overlaySessionRangeForHourly() {
    const stats = call("resolveSessionStats", Math.floor(Date.now() / 1000));
    if (!stats) return;

    const sessionOpen = stats.open;
    const sessionHigh = stats.high;
    const sessionLow = stats.low;

    for (const [key, bar] of s.forming) {
      const ps = s.targets.get(key);
      if (ps == null || !bar) continue;

      const applyOpen = call("applySessionOpenToBar", ps);
      const applyLow = call("applySessionLowToBar", ps);
      const applyHighCap = call("applySessionHighCapToBar", ps);
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
        s.forming.set(key, next);
        emit("formingBar", { resolution: key, bar: next });
      }
    }
  },
    async resolveWeeklyAdjust(nowSec, timeoutMs, tradeSeaAccessToken) {
    if (s.weeklyPriceAdjust != null) return s.weeklyPriceAdjust;

    const weekYmd = chartBucketRithmicMarker(nowSec, "1W");
    if (s.useCache) {
      const cached = s.cache.getWeeklyAdjust(s.session, weekYmd);
      if (cached != null) {
        s.weeklyPriceAdjust = cached;
        return cached;
      }
    }

    let nativeClose = s.scratch.nativeWeeklyClose;
    if (!Number.isFinite(nativeClose)) {
      const nativeWeeks = await s.session.loadHistory({
        resolution: "1W",
        countback: 2,
        include_forming: false,
        timeoutMs,
      });
      nativeClose = Number(nativeWeeks.at(-1)?.close);
      s.scratch.nativeWeeklyClose = nativeClose;
    }
    if (!Number.isFinite(nativeClose)) return 0;

    let adjust = 0;
    if (tradeSeaAccessToken) {
      const { resolveTradeSeaWeeklyAdjust } = await import(tradeseaWeekAdjustUrl);
      adjust = (await resolveTradeSeaWeeklyAdjust(nativeClose, {
        accessToken: tradeSeaAccessToken,
        nowSec,
      })) ?? 0;
    }
    s.weeklyPriceAdjust = adjust;
    if (s.useCache && s.weeklyPriceAdjust != null) {
      s.cache.setWeeklyAdjust(s.session, weekYmd, s.weeklyPriceAdjust);
    }
    return s.weeklyPriceAdjust;
  },
  };
}
