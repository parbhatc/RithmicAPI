const TZ = "America/New_York";

const timeOpts = {
  timeZone: TZ,
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
};

export function fmtPrice(n) {
  return n == null ? "—" : Number(n).toFixed(2);
}

export function fmtWall(ms = Date.now()) {
  return new Date(ms).toLocaleString("en-US", timeOpts);
}

export function fmtBarTime(sec) {
  return new Date(Number(sec) * 1000).toLocaleString("en-US", timeOpts);
}

export function fmtOhlc(bar) {
  return `O=${fmtPrice(bar.open)} H=${fmtPrice(bar.high)} L=${fmtPrice(bar.low)} C=${fmtPrice(bar.close)}`;
}

export function fmtOhlcChange(bar) {
  const o = Number(bar.open);
  const c = Number(bar.close);
  if (!Number.isFinite(o) || !Number.isFinite(c)) return fmtOhlc(bar);
  const pts = c - o;
  const pct = o !== 0 ? (pts / o) * 100 : 0;
  const sign = pts >= 0 ? "+" : "";
  return `${fmtOhlc(bar)} ${sign}${pts.toFixed(2)} (${sign}${pct.toFixed(2)}%)`;
}
