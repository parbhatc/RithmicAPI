/** Map BetterweightChart UDF resolution id → RithmicAPI resolution. */
export function toRithmicResolution(id) {
  const s = String(id ?? "1").trim().toUpperCase();
  if (s === "D" || s === "1D") return "1D";
  if (s === "W" || s === "1W") return "1W";
  if (s === "M" || s === "1M") return "1M";
  if (/^\d+S$/.test(s)) return s;
  const mins = parseInt(s, 10);
  if (Number.isFinite(mins) && mins > 0) return mins;
  return 1;
}
