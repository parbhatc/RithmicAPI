/** Verbose trace for 1m forming candle build. Set FORMING_1M_DEBUG=1 */
export function is1mFormingDebug() {
  const v = process.env.FORMING_1M_DEBUG;
  return v === "1" || v === "true" || v === "yes";
}

export function fmt1mBar(bar) {
  if (!bar) return "null";
  const t = new Date(Number(bar.marker) * 1000).toLocaleString();
  const f = (n) => (n == null || !Number.isFinite(Number(n)) ? "—" : Number(n).toFixed(2));
  return (
    `t=${t} O=${f(bar.open)} H=${f(bar.high)} L=${f(bar.low)} C=${f(bar.close)}` +
    ` forming=${Boolean(bar.forming)} src=${bar.replaySource ?? "—"}`
  );
}

export function log1m(step, detail = "") {
  if (!is1mFormingDebug()) return;
  console.log(detail ? `[1m-forming] ${step}  ${detail}` : `[1m-forming] ${step}`);
}

export function log1mBars(step, bars, { nowSec, tail = 6 } = {}) {
  if (!is1mFormingDebug()) return;
  const list = bars ?? [];
  const slice = list.slice(-tail);
  log1m(
    step,
    `count=${list.length} now=${nowSec != null ? new Date(nowSec * 1000).toLocaleString() : "—"}`,
  );
  for (const b of slice) {
    console.log(`           ${fmt1mBar(b)}`);
  }
}
