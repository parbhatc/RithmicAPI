/** Apply uniform price offset to bar OHLC (weekly TradeSea parity). */
export function shiftBarOHLC(bar, adjust) {
  if (!bar || !Number.isFinite(adjust)) return bar;
  const o = Number(bar.open);
  const h = Number(bar.high);
  const l = Number(bar.low);
  const c = Number(bar.close);
  return {
    ...bar,
    open: o + adjust,
    high: h + adjust,
    low: l + adjust,
    close: c + adjust,
  };
}
