import { applyBucketOpen } from "./forming-bar.js";
import { parseResolution } from "./history-query.js";

export const ONE_MINUTE_PERIOD = 60;
export const ONE_HOUR_PERIOD = 3600;
export const TWO_HOUR_PERIOD = 7200;

/** Stable key for maps (`15`, `1D`, `100T`). */
export function resolutionKey(resolution) {
  return String(resolution).trim().toUpperCase();
}

/** Seconds chart (`5S` … `45S`) or tick chart (`100T`) — isolated from the 1m canonical layer. */
export function isIsolatedResolution(resolution) {
  const raw = resolutionKey(resolution);
  if (/^\d+T$/.test(raw)) return true;
  const m = /^(\d+)S$/.exec(raw);
  if (m) return Number(m[1]) < ONE_MINUTE_PERIOD;
  return false;
}

/** Minute+ timeframes (includes `1`, `1D`, `1W`, `1M`). */
export function isCanonicalResolution(resolution) {
  return !isIsolatedResolution(resolution);
}

export function patch1mBarOpen(closed1m, marker, open) {
  const m = Number(marker);
  const i = closed1m.findIndex((b) => Number(b.marker) === m);
  if (i < 0) return false;
  closed1m[i] = applyBucketOpen({ ...closed1m[i] }, open);
  return true;
}
