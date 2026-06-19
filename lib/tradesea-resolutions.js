import { resolutionKey } from "./candle-layer.js";

/** Map FormingBarManager resolution → TradeSea MDS/UDF `r` string. */
export function toTradeseaResolution(resolution) {
  if (resolution == null) return "1";
  if (typeof resolution === "number") {
    if (resolution >= 86_400) {
      if (resolution >= 365 * 86_400) return "1Y";
      if (resolution >= 604_800) return resolution >= 2_592_000 ? "1M" : "1W";
      return "1D";
    }
    return String(resolution);
  }

  const s = String(resolution).trim().toUpperCase();
  if (s === "D" || s === "1D") return "1D";
  if (s === "W" || s === "1W") return "1W";
  if (s === "M" || s === "1M") return "1M";
  if (s === "Y" || s === "1Y" || s === "12M") return "1Y";
  if (/^\d+T$/i.test(s)) return s.toUpperCase();
  if (/^\d+S$/i.test(s)) return s.toUpperCase();
  return s;
}

/** Map TradeSea `r` → FormingBarManager resolution key input. */
export function fromTradeseaResolution(tsResolution) {
  const r = String(tsResolution).trim().toUpperCase();
  if (r === "1D" || r === "D") return "1D";
  if (r === "1W" || r === "W") return "1W";
  if (r === "1M" || r === "M") return "1M";
  if (r === "1Y" || r === "Y" || r === "12M") return "1Y";
  if (/^\d+T$/i.test(r)) return r.toUpperCase();
  if (/^\d+S$/i.test(r)) return r.toUpperCase();
  const mins = parseInt(r, 10);
  if (Number.isFinite(mins) && mins > 0) return mins;
  return r;
}

/** Normalize TradeSea bar open time to Unix seconds. */
export function tradeseaBarUnix(time) {
  const t = Number(time);
  if (!Number.isFinite(t)) return null;
  return t < 1e12 ? t : Math.floor(t / 1000);
}

/** Internal map key for a resolution (matches FormingBarManager). */
export function tradeseaResolutionKey(resolution) {
  return resolutionKey(fromTradeseaResolution(resolution));
}
