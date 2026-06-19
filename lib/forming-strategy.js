import { parseResolution, parseTickResolution } from "./history-query.js";
import { isIsolatedResolution, resolutionKey, ONE_MINUTE_PERIOD } from "./candle-layer.js";
import { isTickResolution } from "./forming-reconstruct.js";
import { bucketOpen, chartBucketOpen, isCalendarResolution } from "./forming-bar.js";

/** Use native partial replay (1–2 bars) instead of 1m rollup from this width upward. */
export const NATIVE_PARTIAL_FROM_SEC = 86_400;

/** Daily+ always native — never rollup from 1m. */
export const DAILY_FROM_SEC = 86_400;

/**
 * How to bootstrap a forming candle with minimal history load.
 *
 * @typedef {'1m-shared'|'native-partial'|'tick-window'|'tick-bar-partial'} FormingBootstrapMode
 */

/**
 * @param {number|string} resolution
 * @param {{ nativePartialFromSec?: number }} [options]
 * @returns {{
 *   key: string,
 *   resolution: number|string,
 *   mode: FormingBootstrapMode,
 *   periodSeconds: number|null,
 *   tickSize: number|null,
 *   maxSubBars: number,
 * }}
 */
export function classifyFormingResolution(resolution, options = {}) {
  const nativePartialFromSec = options.nativePartialFromSec ?? NATIVE_PARTIAL_FROM_SEC;
  const key = resolutionKey(resolution);

  if (isTickResolution(resolution)) {
    const { tickSize } = parseTickResolution(resolution);
    return {
      key,
      resolution,
      mode: "tick-bar-partial",
      periodSeconds: null,
      tickSize,
      maxSubBars: tickSize * 3,
    };
  }

  const { periodSeconds } = parseResolution(resolution);

  if (isIsolatedResolution(resolution)) {
    const elapsed = Math.ceil(periodSeconds / ONE_MINUTE_PERIOD) + 2;
    return {
      key,
      resolution,
      mode: "tick-window",
      periodSeconds,
      tickSize: 1,
      maxSubBars: Math.max(3, Math.ceil(periodSeconds / periodSeconds) + 2),
    };
  }

  if (periodSeconds >= nativePartialFromSec) {
    return {
      key,
      resolution,
      mode: "native-partial",
      periodSeconds,
      tickSize: null,
      maxSubBars: 2,
    };
  }

  const elapsedMin = Math.ceil(periodSeconds / ONE_MINUTE_PERIOD) + 3;
  return {
    key,
    resolution,
    mode: "1m-shared",
    periodSeconds,
    tickSize: null,
    maxSubBars: elapsedMin,
  };
}

/**
 * Build a minimal bootstrap plan: dedupe network calls across resolutions.
 *
 * @param {(number|string)[]} resolutions
 * @param {number} [nowSec]
 * @param {{ nativePartialFromSec?: number }} [options]
 */
export function planFormingBootstrap(
  resolutions,
  nowSec = Math.floor(Date.now() / 1000),
  options = {},
) {
  const classes = resolutions.map((r) => classifyFormingResolution(r, options));

  const oneMinuteShared = classes.filter((c) => c.mode === "1m-shared");
  const nativePartial = classes.filter((c) => c.mode === "native-partial");
  const tickWindows = classes.filter((c) => c.mode === "tick-window");
  const tickBars = classes.filter((c) => c.mode === "tick-bar-partial");

  let oneMinuteFrom = nowSec;
  let oneMinuteCountback = 5;
  for (const c of oneMinuteShared) {
    const open = bucketOpen(nowSec, c.periodSeconds);
    oneMinuteFrom = Math.min(oneMinuteFrom, open);
    oneMinuteCountback = Math.max(
      oneMinuteCountback,
      Math.ceil((nowSec - open) / ONE_MINUTE_PERIOD) + 3,
    );
  }

  /** @type {Map<number, { from: number, resolutions: typeof classes }>} */
  const secondWindows = new Map();
  for (const c of tickWindows) {
    const open = bucketOpen(nowSec, c.periodSeconds);
    const existing = secondWindows.get(c.periodSeconds);
    if (existing) {
      existing.from = Math.min(existing.from, open);
      existing.resolutions.push(c);
    } else {
      secondWindows.set(c.periodSeconds, { from: open, resolutions: [c] });
    }
  }

  /** @type {Map<number, typeof classes} */
  const tickSizes = new Map();
  for (const c of tickBars) {
    if (!tickSizes.has(c.tickSize)) tickSizes.set(c.tickSize, []);
    tickSizes.get(c.tickSize).push(c);
  }

  const requests = [];
  if (oneMinuteShared.length) {
    requests.push({
      type: "1m-shared",
      count: 1,
      countback: oneMinuteCountback,
      from: oneMinuteFrom,
      serves: oneMinuteShared.map((c) => c.key),
    });
  }
  for (const c of nativePartial) {
    const from = isCalendarResolution(c.resolution)
      ? chartBucketOpen(nowSec, c.resolution)
      : bucketOpen(nowSec, c.periodSeconds);
    requests.push({
      type: "native-partial",
      count: 1,
      resolution: c.resolution,
      countback: 2,
      from,
      serves: [c.key],
    });
  }
  for (const [periodSec, win] of secondWindows) {
    requests.push({
      type: "tick-window",
      count: 1,
      periodSeconds: periodSec,
      from: win.from,
      to: nowSec + periodSec,
      serves: win.resolutions.map((c) => c.key),
    });
  }
  for (const [tickSize] of tickSizes) {
    requests.push({
      type: "tick-bar-partial",
      count: 1,
      tickSize,
      serves: tickSizes.get(tickSize).map((c) => c.key),
    });
  }

  return {
    nowSec,
    classes,
    requests,
    requestCount: requests.length,
  };
}
