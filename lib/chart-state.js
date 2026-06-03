/** @deprecated Use `CandleLayer` — same canonical 1m data layer. */
export {
  CandleLayer as ChartState,
  resolutionKey,
  ONE_MINUTE_PERIOD,
  isCanonicalResolution,
  isIsolatedResolution,
  countback1mForResolutions,
  countback1mTail,
  deriveFormingFrom1m,
  deriveClosedFrom1m,
} from "./candle-layer.js";
