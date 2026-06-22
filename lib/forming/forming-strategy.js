import { parseResolution, parseTickResolution } from "./history-query.js";
import { isIsolatedResolution, resolutionKey, ONE_MINUTE_PERIOD } from "./candle-layer.js";
import { isTickResolution } from "./forming-reconstruct.js";
import { bucketOpen, chartBucketOpen, isCalendarResolution } from "./forming-bar.js";
import {
  FormingSubSource,
  formingSubSource,
  formingBootstrapMode,
} from "./forming-source.js";

/** @deprecated Use {@link formingSubSource} ΓÇö daily+ no longer use native partial by default. */
export const NATIVE_PARTIAL_FROM_SEC = Number.POSITIVE_INFINITY;

/** @deprecated Use {@link formingSubSource}. */
export const DAILY_FROM_SEC = 86_400;

/**
 * How to bootstrap a forming candle with minimal history load.
 *
 * @typedef {'1m-shared'|'1D-shared'|'1M-shared'|'native-partial'|'tick-window'|'tick-bar-partial'} FormingBootstrapMode
 */

/**
 * @param {number|string} resolution
 * @returns {{
 *   key: string,
 *   resolution: number|string,
 *   mode: FormingBootstrapMode,
 *   subSource: string,
 *   periodSeconds: number|null,
 *   tickSize: number|null,
 *   maxSubBars: number,
 * }}
 */
export function classifyFormingResolution(resolution) {
  const key = resolutionKey(resolution);

  if (isTickResolution(resolution)) {
    const { tickSize } = parseTickResolution(resolution);
    return {
      key,
      resolution,
      mode: "tick-bar-partial",
      subSource: "tick",
      periodSeconds: null,
      tickSize,
      maxSubBars: tickSize * 3,
    };
  }

  const { periodSeconds } = parseResolution(resolution);

  if (isIsolatedResolution(resolution)) {
    return {
      key,
      resolution,
      mode: "tick-window",
      subSource: "tick",
      periodSeconds,
      tickSize: 1,
      maxSubBars: Math.max(3, Math.ceil(periodSeconds / periodSeconds) + 2),
    };
  }

  const sub = formingSubSource(resolution);
  const mode = formingBootstrapMode(resolution);

  if (mode === "1m-shared") {
    const elapsedMin =
      sub === FormingSubSource.ONE_SECOND
        ? 3
        : Math.ceil(periodSeconds / ONE_MINUTE_PERIOD) + 3;
    return {
      key,
      resolution,
      mode,
      subSource: sub,
      periodSeconds,
      tickSize: null,
      maxSubBars: elapsedMin,
    };
  }

  if (mode === "1D-shared") {
    const raw = String(resolution).trim().toUpperCase();
    const maxSubBars = raw === "1M" || raw === "M" ? 35 : 8;
    return {
      key,
      resolution,
      mode,
      subSource: sub,
      periodSeconds,
      tickSize: null,
      maxSubBars,
    };
  }

  if (mode === "1M-shared") {
    return {
      key,
      resolution,
      mode,
      subSource: sub,
      periodSeconds,
      tickSize: null,
      maxSubBars: 14,
    };
  }

  return {
    key,
    resolution,
    mode: "native-partial",
    subSource: sub,
    periodSeconds,
    tickSize: null,
    maxSubBars: 2,
  };
}

/**
 * Build a minimal bootstrap plan: dedupe network calls across resolutions.
 *
 * @param {(number|string)[]} resolutions
 * @param {number} [nowSec]
 */
export function planFormingBootstrap(
  resolutions,
  nowSec = Math.floor(Date.now() / 1000),
) {
  const classes = resolutions.map((r) => classifyFormingResolution(r));

  const oneMinuteShared = classes.filter((c) => c.mode === "1m-shared");
  const dailyShared = classes.filter((c) => c.mode === "1D-shared");
  const monthlyShared = classes.filter((c) => c.mode === "1M-shared");
  const tickWindows = classes.filter((c) => c.mode === "tick-window");
  const tickBars = classes.filter((c) => c.mode === "tick-bar-partial");

  let oneMinuteFrom = nowSec;
  let oneMinuteCountback = 5;
  for (const c of oneMinuteShared) {
    const open = isCalendarResolution(c.resolution)
      ? chartBucketOpen(nowSec, c.resolution)
      : bucketOpen(nowSec, c.periodSeconds);
    oneMinuteFrom = Math.min(oneMinuteFrom, open);
    oneMinuteCountback = Math.max(oneMinuteCountback, c.maxSubBars);
  }
  if (oneMinuteShared.length) {
    const curOpen = bucketOpen(nowSec, ONE_MINUTE_PERIOD);
    oneMinuteFrom = Math.min(
      oneMinuteFrom,
      curOpen - oneMinuteCountback * ONE_MINUTE_PERIOD,
    );
  }

  let dailyCountback = 8;
  for (const c of dailyShared) {
    dailyCountback = Math.max(dailyCountback, c.maxSubBars);
  }

  let monthlyCountback = 14;
  for (const c of monthlyShared) {
    monthlyCountback = Math.max(monthlyCountback, c.maxSubBars);
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
  if (dailyShared.length) {
    requests.push({
      type: "1D-shared",
      count: 1,
      countback: dailyCountback,
      serves: dailyShared.map((c) => c.key),
    });
  }
  if (monthlyShared.length) {
    requests.push({
      type: "1M-shared",
      count: 1,
      countback: monthlyCountback,
      serves: monthlyShared.map((c) => c.key),
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
