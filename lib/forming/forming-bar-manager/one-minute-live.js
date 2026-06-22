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
export function createOneMinuteLiveOps(s, emit, call) {
  return {
    record1mTrade(trade) {
    const price = Number(trade?.price);
    if (!Number.isFinite(price)) return;
    const ssboe = Number(trade?.ssboe);
    const now =
      Number.isFinite(ssboe) && ssboe > 0 ? ssboe : Math.floor(Date.now() / 1000);
    const marker = bucketOpen(now, ONE_MINUTE_PERIOD);
    if (!s.buffered1mTrades.has(marker)) {
      s.buffered1mTrades.set(marker, []);
    }
    s.buffered1mTrades.get(marker).push(trade);
    for (const m of s.buffered1mTrades.keys()) {
      if (m < marker - ONE_MINUTE_PERIOD) s.buffered1mTrades.delete(m);
    }
  },
    seedLiveRollover1m(marker) {
    const buffered = s.buffered1mTrades.get(marker) ?? [];
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
        symbol: s.session.symbol,
        exchange: s.session.exchange,
        seedOpen: bar.open,
        chartResolution: 1,
      });
      if (next) bar = next;
    }

    s.partial1m = bar;
    log1mBuild("seedLiveRollover1m", s.partial1m, {
      openFrom: `first tick=${firstPrice} (${buffered.length} buffered)`,
      bufferedTrades: buffered.length,
    });
  },
    async seedRollover1mPartial(nowSec, timeoutMs, marker) {
    if (s.live) {
      call("seedLiveRollover1m", marker);
      return;
    }
    try {
      const bars1s = await s.session.replay1sInMinute(
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
          s.partial1m = {
            marker,
            ...ts,
            volume: 0,
            forming: true,
            replaySource: "1m-rollover-seed",
          };
          log1mBuild("seedRollover1mPartial", s.partial1m, {
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

    const last = Number(s.session.status?.last);
    const prev = s.closed1m.at(-1);
    const prevClose = prev ? Number(prev.close) : NaN;
    if (
      isUsablePrice(last) &&
      (!isUsablePrice(prevClose) || Math.abs(last - prevClose) >= 0.01)
    ) {
      s.partial1m = {
        marker,
        open: last,
        high: last,
        low: last,
        close: last,
        volume: 0,
        forming: true,
        replaySource: "1m-rollover-last",
      };
      log1mBuild("seedRollover1mPartial.last", s.partial1m, {
        openFrom: `status.last=${last}`,
      });
    }
  },
    async refineRollover1m(nowSec, timeoutMs, targetOpen) {
    try {
      const key = resolutionKey(1);
      const bar = s.forming.get(key);
      if (!bar || Number(bar.marker) !== targetOpen) return;

      const bars1s = await s.session.replay1sInMinute(
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

      s.partial1m = { ...s.partial1m, ...next, marker: targetOpen };
      s.forming.set(key, next);
      log1m(
        "refineRollover1m.done",
        `O=${open} H=${bar.high}→${next.high} L=${bar.low}→${next.low}`,
      );
      emit("formingBar", { resolution: key, bar: next });
    } catch (err) {
      log1m("refineRollover1m.error", err?.message ?? String(err));
    }
  },
    async ensure1mPartial(
    nowSec,
    timeoutMs,
    marker = bucketOpen(nowSec, ONE_MINUTE_PERIOD),
  ) {
    const compat = call("compat1m", );
    log1m("ensure1mPartial.start", `bucket=${new Date(marker * 1000).toLocaleString()} compat=${compat}`);

    try {
      const history1m = await s.session.loadHistory({
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
        s.partial1m = {
          ...split.partial,
          forming: true,
          replaySource: call("compat1m", ) ? "1m-partial+compat" : "1m-partial",
        };
        log1mBuild("ensure1mPartial.splitPartial", s.partial1m, {
          openFrom: `compat history partial @ ${fmtSec(split.partial.marker)} O=${split.partial.open}`,
          histPartial: split.partial,
        });
        return;
      }
      const last = history1m.at(-1);
      if (last && Number(last.marker) === marker) {
        s.partial1m = {
          ...last,
          forming: true,
          replaySource: call("compat1m", ) ? "1m-partial+compat" : "1m-partial",
        };
        log1mBuild("ensure1mPartial.lastBar", s.partial1m, {
          openFrom: `compat history tail @ ${fmtSec(last.marker)} O=${last.open}`,
          histPartial: last,
        });
        return;
      }
      log1m("ensure1mPartial.miss", "history loaded but no bar for current bucket");
    } catch (err) {
      log1m("ensure1mPartial.error", err?.message ?? String(err));
    }

    if (s.partial1m && Number(s.partial1m.marker) === marker) {
      log1m("ensure1mPartial.keepExisting", fmt1mBar(s.partial1m));
      return;
    }

    if (!s.accuracyMode) {
      try {
        const from1s = await s.session.replay1mFrom1s(
          marker,
          nowSec + ONE_MINUTE_PERIOD,
          { timeoutMs: Math.min(8000, timeoutMs) },
        );
        if (from1s) {
          s.partial1m = {
            ...from1s,
            forming: true,
            replaySource: "1m-1s-seed",
          };
          log1m("ensure1mPartial.1sSeedDone", fmt1mBar(s.partial1m));
          return;
        }
      } catch (err) {
        log1m("ensure1mPartial.1sSeedError", err?.message ?? String(err));
      }
    }

    const last = Number(s.session.status?.last);
    if (!isUsablePrice(last)) {
      log1m("ensure1mPartial.liveSeedSkip", "no status.last");
      return;
    }

    if (s.accuracyMode) {
      log1m("ensure1mPartial.liveSeedSkip", "accuracy mode — open from 1s replay only");
      return;
    }

    log1m("ensure1mPartial.liveSeed", `last=${last}`);
    let secOpen = null;
    let first1s = null;
    try {
      const bars1s = await s.session.replay1sInMinute(
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
        first1s = await s.session.first1sBarInRange(
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
    s.partial1m = {
      marker,
      open,
      high: Math.max(open, last),
      low: Math.min(open, last),
      close: last,
      volume: 0,
      forming: true,
      replaySource: "1m-live-seed",
    };
    log1mBuild("ensure1mPartial.liveSeed", s.partial1m, {
      openFrom: isUsablePrice(secOpen)
        ? `first1s ${fmtSubBar(first1s)}`
        : `status.last=${last} (no 1s bar)`,
      first1s,
    });
  },
    commitClosed1m(bar) {
    if (!bar) return;
    const m = Number(bar.marker);
    if (!Number.isFinite(m)) return;
    const row = { ...bar, forming: false };
    const idx = s.closed1m.findIndex((b) => Number(b.marker) === m);
    if (idx >= 0) s.closed1m[idx] = row;
    else s.closed1m.push(row);
    s.closed1m.sort((a, b) => Number(a.marker) - Number(b.marker));
  },
    maybeRefine1mOpenFrom1s() {
    if (!s.accuracyMode || s.refine1mOpenInflight || s.live) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const marker = bucketOpen(nowSec, ONE_MINUTE_PERIOD);
    if (nowSec - marker > 20) return;
    if (Date.now() - s.lastRefine1mOpenAt < 750) return;

    const key = resolutionKey(1);
    const bar = s.forming.get(key);
    if (!bar?.forming || Number(bar.marker) !== marker) return;

    s.refine1mOpenInflight = true;
    void call("refine1mOpenFrom1s", marker, nowSec).finally(() => {
      s.refine1mOpenInflight = false;
      s.lastRefine1mOpenAt = Date.now();
    });
  },
    async refine1mOpenFrom1s(marker, nowSec) {
    try {
      const bars1s = await s.session.replay1sInMinute(
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
      const bar = s.forming.get(key);
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

      if (s.partial1m && Number(s.partial1m.marker) === marker) {
        s.partial1m = { ...s.partial1m, ...next };
      }
      s.forming.set(key, next);
      log1m(
        "refine1mOpenFrom1s",
        `O=${curOpen} (locked) H=${curHigh}→${next.high} L=${curLow}→${next.low}`,
      );
      log1mBuild("refine1mOpenFrom1s", next, {
        openFrom: `TradeSea active 1s (${sorted.length} bars), open locked`,
        bars1s: sorted,
      });
      emit("formingBar", { resolution: key, bar: next });
    } catch (err) {
      log1m("refine1mOpenFrom1s.error", err?.message ?? String(err));
    }
  },
    sync1mCloseFromLast() {
    const key = resolutionKey(1);
    const bar = s.forming.get(key);
    const last = Number(s.session.status?.last);
    const nowSec = Math.floor(Date.now() / 1000);
    const current1mOpen = bucketOpen(nowSec, ONE_MINUTE_PERIOD);
    if (bar && Number(bar.marker) < current1mOpen) {
      log1m("sync1mCloseFromLast.skip", `stale bucket ${fmtSec(Number(bar.marker))}`);
      return;
    }
    if (bar && isUsablePrice(last)) {
      if (call("isStaleBoundaryLast", bar, last, nowSec)) {
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
      s.forming.set(key, next);
      log1m(
        "sync1mCloseFromLast",
        `close ${bar.close} → ${last} H=${bar.high} → ${next.high} L=${bar.low} → ${next.low}`,
      );
      emit("formingBar", { resolution: key, bar: next });
    } else {
      log1m("sync1mCloseFromLast.skip", `bar=${bar ? "yes" : "no"} last=${last}`);
    }
  },
    publishPartial1mToForming(
    nowSec,
    targetOpen = bucketOpen(nowSec, ONE_MINUTE_PERIOD),
  ) {
    if (!s.partial1m) {
      log1m("publishPartial1m.skip", "partial1m is null");
      return;
    }
    const bucket = Number(targetOpen);
    if (Number(s.partial1m.marker) !== bucket) {
      log1m(
        "publishPartial1m.skip",
        `marker mismatch partial=${new Date(Number(s.partial1m.marker) * 1000).toLocaleString()} bucket=${new Date(bucket * 1000).toLocaleString()}`,
      );
      return;
    }

    const key = resolutionKey(1);
    const bar = {
      ...s.partial1m,
      marker: bucket,
      period: String(ONE_MINUTE_PERIOD),
      forming: true,
      replaySource: s.partial1m.replaySource ?? "1m-partial",
    };
    s.forming.set(key, bar);
    log1mBuild("publishPartial1m", bar, {
      openFrom: `${bar.replaySource ?? "1m-partial"} O=${bar.open}`,
    });
    if (!s.targets.has(key)) {
      s.targets.set(key, ONE_MINUTE_PERIOD);
      s.resolutionByKey.set(key, 1);
    }
    emit("formingBar", { resolution: key, bar });
  },
  };
}
