import { parseResolution } from "./history-query.js";
import { resolutionKey, ONE_MINUTE_PERIOD } from "./candle-layer.js";

/**
 * Sub-bar source used to build a forming candle.
 *
 * | Resolution   | Built from |
 * |--------------|------------|
 * | 1m           | 1s bars    |
 * | 2m ΓÇª 1D      | 1m bars    |
 * | 1W, 1M       | 1D bars    |
 * | 1Y           | 1M bars    |
 */
export const FormingSubSource = {
  ONE_SECOND: "1s",
  ONE_MINUTE: "1m",
  DAILY: "1D",
  MONTHLY: "1M",
};

/** @returns {typeof FormingSubSource[keyof typeof FormingSubSource]} */
export function formingSubSource(resolution) {
  const key = resolutionKey(resolution);
  if (key === "1") return FormingSubSource.ONE_SECOND;

  const raw = String(resolution).trim().toUpperCase();
  if (raw === "Y" || raw === "1Y" || raw === "12M" || raw === "YEARLY") {
    return FormingSubSource.MONTHLY;
  }

  const { periodSeconds } = parseResolution(resolution);
  if (periodSeconds <= 86_400) return FormingSubSource.ONE_MINUTE;
  if (periodSeconds < 365 * 86_400) return FormingSubSource.DAILY;
  return FormingSubSource.MONTHLY;
}

/** Bootstrap mode implied by {@link formingSubSource}. */
export function formingBootstrapMode(resolution) {
  const sub = formingSubSource(resolution);
  if (sub === FormingSubSource.ONE_SECOND || sub === FormingSubSource.ONE_MINUTE) {
    return "1m-shared";
  }
  if (sub === FormingSubSource.DAILY) return "1D-shared";
  if (sub === FormingSubSource.MONTHLY) return "1M-shared";
  return "1m-shared";
}
