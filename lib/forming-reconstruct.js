import { parseResolution, parseTickResolution, aggregateTickBars } from "./history-query.js";
import { isUsablePrice } from "./forming-bar.js";
import { aggregateReplayOHLC } from "./forming-bar.js";
import { tickBarTime } from "./market-views.js";
import { isIsolatedResolution, isCanonicalResolution } from "./candle-layer.js";

export { isCanonicalResolution, isIsolatedResolution } from "./candle-layer.js";

export const FormingReconstructKind = {
  TICK_REPLAY: "tick-replay",
  ONE_MINUTE_DERIVED: "1m-derived",
};

export function isTickResolution(resolution) {
  return /^\d+T$/i.test(String(resolution).trim());
}

/** Canonical 1m layer vs isolated seconds/tick (does not affect higher TFs). */
export function resolveDataLayer(resolution) {
  if (isTickResolution(resolution)) {
    const { tickSize } = parseTickResolution(resolution);
    return {
      layer: "tick",
      tickSize,
      sourceLabel: tickSize > 1 ? `${tickSize}T-tick-replay` : "1-tick-replay",
    };
  }
  if (isIsolatedResolution(resolution)) {
    const raw = String(resolution).trim().toUpperCase();
    const sec = Number(/^(\d+)S$/.exec(raw)?.[1] ?? 1);
    return { layer: "seconds", periodSeconds: sec, sourceLabel: `${sec}s-tick-replay` };
  }
  return { layer: "1m", sourceLabel: "1m-derived" };
}

/** @deprecated Use `resolveDataLayer`. */
export function resolveFormingReconstructStrategy(resolution) {
  const d = resolveDataLayer(resolution);
  if (d.layer === "tick") {
    return {
      kind: FormingReconstructKind.TICK_REPLAY,
      tickSize: d.tickSize,
      periodSeconds: null,
      sourceLabel: d.sourceLabel,
    };
  }
  if (d.layer === "seconds") {
    return {
      kind: FormingReconstructKind.TICK_REPLAY,
      tickSize: 1,
      periodSeconds: d.periodSeconds,
      sourceLabel: d.sourceLabel,
    };
  }
  return {
    kind: FormingReconstructKind.ONE_MINUTE_DERIVED,
    sourceLabel: d.sourceLabel,
  };
}

export function aggregatePartialTickForming(oneTickBars, tickSize) {
  const n = Math.floor(Number(tickSize));
  if (!oneTickBars?.length || !Number.isFinite(n) || n < 1) {
    return { complete: [], forming: null, tickCount: 0 };
  }

  const sorted = [...oneTickBars].sort((a, b) => tickBarTime(a) - tickBarTime(b));
  const complete = aggregateTickBars(sorted, n);
  const remainder = sorted.length % n;
  if (!remainder) {
    return { complete, forming: null, tickCount: sorted.length };
  }

  const partialTicks = sorted.slice(-remainder);
  const marker = tickBarTime(partialTicks[0]);
  const forming = aggregateReplayOHLC(partialTicks, { marker });
  if (forming) forming.forming = true;
  return { complete, forming, tickCount: sorted.length };
}

export function subBarsInBucket(bars, bucket, periodSeconds) {
  const end = bucket + periodSeconds;
  return bars.filter((b) => {
    const m = Number(b.marker);
    return m >= bucket && m < end && isUsablePrice(b.close ?? b.open);
  });
}

export function formingSubBarCountback(periodSeconds, subResolution) {
  const subPeriod = parseResolution(subResolution).periodSeconds;
  return Math.max(2, Math.ceil(periodSeconds / subPeriod) + 5);
}

export function formingReplayWindowSeconds(periodSeconds, tickSize = 1) {
  if (periodSeconds == null) return Math.max(3600, tickSize * 120);
  return Math.min(periodSeconds + 300, 900);
}
