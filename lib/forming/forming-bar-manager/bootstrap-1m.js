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
export function createBootstrap1mOps(s, emit, externalCall) {
  const ops = {};
  const call = (name, ...args) => {
    const fn = ops[name];
    if (fn) return fn(...args);
    return externalCall(name, ...args);
  };

  ops.compat1m = function compat1m() {
    return s.accuracyMode;
  };

  ops.tryCompatValuePartial = async function tryCompatValuePartial(nowSec, timeoutMs) {
    const marker = bucketOpen(nowSec, ONE_MINUTE_PERIOD);
    try {
      const raw = await s.session.loadHistory({
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
  };

  ops.buildPartial1mFrom1s = async function buildPartial1mFrom1s(
    nowSec,
    timeoutMs,
    marker = bucketOpen(nowSec, ONE_MINUTE_PERIOD),
  ) {
    const prevOpen = s.partial1m?.open;
    try {
      const perMs = Math.min(8000, timeoutMs);
      const bars1s = await s.session.replay1sInMinute(
        marker,
        nowSec + ONE_MINUTE_PERIOD,
        { timeoutMs: perMs },
      );
      const from1s = await s.session.replay1mFrom1s(
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
      if (s.accuracyMode) {
        const ts = tradeseaMinuteFormingFrom1s(bars1s, marker, ONE_MINUTE_PERIOD);
        if (ts) {
          const prior = s.partial1m;
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
          s.partial1m = {
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
          log1mBuild("buildPartial1mFrom1s", s.partial1m, {
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
      if (s.accuracyMode) {
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
      s.partial1m = {
        ...from1s,
        open,
        high,
        low,
        forming: true,
        replaySource: s.accuracyMode ? "1m-1s+compat+ts-open" : "1m-1s",
      };
      log1mBuild("buildPartial1mFrom1s", s.partial1m, {
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
  };

  ops.needsSession1mTickRefine = function needsSession1mTickRefine(resolutions = null) {
    if (resolutions) {
      for (const r of resolutions) {
        const { periodSeconds } = parseResolution(r);
        if (periodSeconds != null && periodSeconds >= 900) return true;
      }
      return false;
    }
    for (const ps of s.targets.values()) {
      if (ps != null && ps >= 900) return true;
    }
    return false;
  };

  ops.refineBucketStartMinute = async function refineBucketStartMinute(bucketStartSec, timeoutMs) {
    const marker = bucketOpen(bucketStartSec, ONE_MINUTE_PERIOD);
    if (s.partial1m && Number(s.partial1m.marker) === marker) return;
    const secOpen = await s.session.first1sOpenInRange(
      marker,
      marker + ONE_MINUTE_PERIOD,
      { timeoutMs },
    );
    if (!isUsablePrice(secOpen)) return;

    if (patch1mBarOpen(s.closed1m, marker, secOpen)) return;

    const i = s.closed1m.findIndex((b) => Number(b.marker) === marker);
    if (i >= 0) {
      s.closed1m[i] = applyBucketOpen(s.closed1m[i], secOpen);
      return;
    }

    if (s.accuracyMode) {
      const last = Number(s.session.status?.last);
      const close = isUsablePrice(last) ? last : secOpen;
      s.closed1m.push({
        marker,
        open: secOpen,
        high: Math.max(secOpen, close),
        low: Math.min(secOpen, close),
        close,
        volume: 0,
        replaySource: "1m-1s-open-only",
      });
      s.closed1m.sort((a, b) => Number(a.marker) - Number(b.marker));
      return;
    }

    const from1s = await s.session.replay1mFrom1s(
      marker,
      marker + ONE_MINUTE_PERIOD,
      { timeoutMs },
    );
    if (from1s) {
      s.closed1m = [...s.closed1m, from1s].sort(
        (a, b) => Number(a.marker) - Number(b.marker),
      );
    }
  };

  ops.refineClosed1mExtremesFrom1s = async function refineClosed1mExtremesFrom1s(fromSec, toSec, timeoutMs) {
    const from = Math.floor(fromSec);
    const to = Math.floor(toSec);
    const refined = await s.session.replay1mBarsFrom1s(from, to, { timeoutMs });
    const byMarker = new Map(refined.map((b) => [Number(b.marker), b]));

    for (let i = 0; i < s.closed1m.length; i++) {
      const bar = s.closed1m[i];
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
      if (next !== bar) s.closed1m[i] = next;
    }
  };

  ops.refinePartial1m = async function refinePartial1m(nowSec, timeoutMs) {
    if (s.accuracyMode) return;
    if (!s.partial1m) return;
    const marker = Number(s.partial1m.marker);
    const current1mOpen = bucketOpen(nowSec, ONE_MINUTE_PERIOD);
    if (marker !== current1mOpen) return;

    const from1s = await s.session.replay1mFrom1s(
      marker,
      marker + ONE_MINUTE_PERIOD,
      { timeoutMs },
    );
    if (from1s) {
      s.partial1m = {
        ...from1s,
        forming: true,
        replaySource: "1m-1s-partial",
      };
    }
  };

  ops.run1mShared = async function run1mShared(req, nowSec, timeoutMs, tickFallback) {
    let history1m = null;
    if (s.useCache) {
      const hit = s.cache.get1m(
        s.session,
        req.from,
        req.countback,
        nowSec,
        undefined,
        ops.compat1m(),
      );
      if (hit) history1m = hit.raw;
    }

    if (!history1m) {
      log1m("run1mShared.loadHistory", `from=${req.from} countback=${req.countback} compat=${ops.compat1m()}`);
      const compat = ops.compat1m();
      history1m = await s.session.loadHistory({
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
    s.closed1m = split.closed;
    s.partial1m = split.partial;
    const current1mOpen = bucketOpen(nowSec, ONE_MINUTE_PERIOD);
    log1m(
      "run1mShared.split",
      `bucket=${fmtSec(current1mOpen)} closed=${split.closed.length} partial=${split.partial ? "yes" : "null"}`,
    );
    if (s.partial1m && Number(s.partial1m.marker) === current1mOpen) {
      log1mBuild("run1mShared.splitPartial", s.partial1m, {
        openFrom: `history split partial @ ${fmtSec(s.partial1m.marker)} O=${s.partial1m.open}`,
        histPartial: s.partial1m,
      });
    }
    if (!s.partial1m && history1m.length) {
      const last = history1m.at(-1);
      if (Number(last.marker) === current1mOpen) {
        s.partial1m = last;
        log1mBuild("run1mShared.partialFallback", s.partial1m, {
          openFrom: `compat-history last bar @ ${fmtSec(last.marker)} O=${last.open}`,
          histPartial: last,
        });
      }
    }
    if (s.partial1m && ops.compat1m()) {
      const prev = s.partial1m;
      s.partial1m = {
        ...s.partial1m,
        replaySource: "1m-partial+compat",
      };
      log1mBuild("run1mShared.compatTag", s.partial1m, {
        openFrom: `compat-transformed history O=${prev.open}`,
        histPartial: prev,
      });
    }

    if (s.useCache) {
      s.cache.set1m(
        s.session,
        req.from,
        req.countback,
        nowSec,
        history1m,
        split.closed,
        split.partial,
        ops.compat1m(),
      );
    }

    if (
      tickFallback &&
      !s.accuracyMode &&
      (!s.partial1m || Number(s.partial1m.marker) !== current1mOpen)
    ) {
      const from1s = await s.session.replay1mFrom1s(
        current1mOpen,
        nowSec + ONE_MINUTE_PERIOD,
        { timeoutMs },
      );
      if (from1s) {
        s.partial1m = { ...from1s, forming: true, replaySource: "1m-1s-fallback" };
      }
    }

    if (!s.fast && !s.accuracyMode) {
      await ops.buildPartial1mFrom1s(nowSec, timeoutMs);
      await ops.refinePartial1m(nowSec, timeoutMs);
    } else if (!s.fast && s.accuracyMode) {
      const current1mOpen = bucketOpen(nowSec, ONE_MINUTE_PERIOD);
      if (!s.partial1m || Number(s.partial1m.marker) !== current1mOpen) {
        await call("ensure1mPartial", nowSec, timeoutMs);
      }
      if (!s.partial1m || Number(s.partial1m.marker) !== current1mOpen) {
        const compatValue = await ops.tryCompatValuePartial(nowSec, timeoutMs);
        if (compatValue) {
          s.partial1m = compatValue;
          log1mBuild("tryCompatValuePartial", compatValue, {
            openFrom: `raw compat value-bar O=${compatValue.open}`,
          });
        } else {
          await ops.buildPartial1mFrom1s(nowSec, timeoutMs);
        }
      }
    }

    if (s.accuracyMode && ops.needsSession1mTickRefine()) {
      await ops.refineClosed1mExtremesFrom1s(req.from, nowSec + 120, timeoutMs);
    }

    const refinedMinutes = new Set();
    for (const key of req.serves) {
      const periodSeconds = s.targets.get(key);
      if (periodSeconds == null) continue;
      const resolution = s.resolutionByKey.get(key);
      const htfOpen = call("bucketOpenFor", nowSec, resolution, periodSeconds);
      if (!s.fast) {
        const firstMin = bucketOpen(htfOpen, ONE_MINUTE_PERIOD);
        if (!refinedMinutes.has(firstMin)) {
          refinedMinutes.add(firstMin);
          await ops.refineBucketStartMinute(htfOpen, timeoutMs);
        }
      }
      if (s.accuracyMode && periodSeconds === ONE_MINUTE_PERIOD) continue;
      if (periodSeconds >= TWO_HOUR_PERIOD) continue;
      const bar = call("seedFromOneMinute", periodSeconds, htfOpen, resolution);
      s.forming.set(key, bar);
      if (bar) emit("formingBar", { resolution: key, bar });
    }

    if (s.accuracyMode) {
      log1m("run1mShared.publish", s.partial1m ? fmt1mBar(s.partial1m) : "partial=null SKIP");
      call("publishPartial1mToForming", nowSec);
      call("sync1mCloseFromLast", );
      log1m("run1mShared.final", fmt1mBar(s.forming.get(resolutionKey(1))));
    }
  };

  return ops;
}
