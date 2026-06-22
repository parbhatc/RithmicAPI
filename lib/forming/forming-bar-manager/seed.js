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
export function createSeedOps(s, emit, call) {
  return {
    seedFromOneMinute(periodSeconds, htfOpen, resolution) {
    const end = htfOpen + periodSeconds;
    const closedRows = s.closed1m.filter((b) => {
      const m = Number(b.marker);
      return m >= htfOpen && m < end;
    });
    const allRows = [...closedRows];
    if (s.partial1m) {
      const m = Number(s.partial1m.marker);
      if (m >= htfOpen && m < end) allRows.push(s.partial1m);
    }
    if (!allRows.length) return null;

    const base = { marker: htfOpen, periodSeconds, symbol: s.session.symbol, exchange: s.session.exchange };

    if (s.accuracyMode && periodSeconds < 86_400 && closedRows.length) {
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
  },
    seedFromOneHour(periodSeconds, htfOpen, resolution) {
    const end = htfOpen + periodSeconds;
    const closedRows = s.closed1h.filter((b) => {
      const m = Number(b.marker);
      return m >= htfOpen && m < end;
    });
    const allRows = [...closedRows];
    if (s.partial1h) {
      const m = Number(s.partial1h.marker);
      if (m >= htfOpen && m < end) allRows.push(s.partial1h);
    }
    if (!allRows.length) return null;

    const base = {
      marker: htfOpen,
      periodSeconds,
      symbol: s.session.symbol,
      exchange: s.session.exchange,
    };

    const bar = aggregateReplayOHLC(allRows, base);
    if (!bar) return null;

    return { ...bar, forming: true, replaySource: "1h-blind-spot" };
  },
    bucketOpenFor(nowSec, resolution, periodSeconds) {
    if (resolution != null && isCalendarResolution(resolution)) {
      return chartBucketOpen(nowSec, resolution);
    }
    return bucketOpen(nowSec, periodSeconds);
  },
  };
}
