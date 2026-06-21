/** @typedef {{ id: string, label: string, sec: number }} ResolutionDef */

const MONTH_SEC = 2592000;

/** @param {string} id */
export function normalizeResolutionId(id) {
  const s = String(id ?? "").trim();
  if (!s) return s;
  if (s === "1D") return "D";
  if (s === "1W") return "W";
  if (s === "1M") return "M";
  return s;
}

/** @param {string} id */
function computeResolutionSec(id) {
  const s = normalizeResolutionId(id);
  if (!s) return null;
  if (s === "D") return 86400;
  if (s === "W") return 604800;
  if (s === "M") return MONTH_SEC;
  const tick = /^(\d+)T$/i.exec(s);
  if (tick) return 1;
  const sec = /^(\d+)S$/i.exec(s);
  if (sec) return Number(sec[1]);
  if (/^\d+$/.test(s)) return Number(s) * 60;
  const months = /^(\d+)M$/i.exec(s);
  if (months) return Number(months[1]) * MONTH_SEC;
  return null;
}

/** @param {string} id */
export function resolutionSec(id) {
  const norm = normalizeResolutionId(id);
  if (RESOLUTION_SEC[norm] != null) return RESOLUTION_SEC[norm];
  return computeResolutionSec(norm) ?? 60;
}

/** @param {number} tick */
export function tickToMinmovPricescale(tick) {
  const t = Number(tick) || 0.01;
  let scale = 1;
  while (Math.abs(Math.round(t * scale) - t * scale) > 1e-9 && scale < 1e10) {
    scale *= 10;
  }
  const minmov = Math.round(t * scale);
  return { minmov, pricescale: scale, tick: minmov / scale };
}

export const CHART_RESOLUTIONS = [
  { id: "1S", label: "1s", sec: 1 },
  { id: "5S", label: "5s", sec: 5 },
  { id: "15S", label: "15s", sec: 15 },
  { id: "30S", label: "30s", sec: 30 },
  { id: "1", label: "1m", sec: 60 },
  { id: "3", label: "3m", sec: 180 },
  { id: "5", label: "5m", sec: 300 },
  { id: "15", label: "15m", sec: 900 },
  { id: "30", label: "30m", sec: 1800 },
  { id: "45", label: "45m", sec: 2700 },
  { id: "60", label: "1h", sec: 3600 },
  { id: "120", label: "2h", sec: 7200 },
  { id: "180", label: "3h", sec: 10800 },
  { id: "240", label: "4h", sec: 14400 },
  { id: "D", label: "1D", sec: 86400 },
  { id: "W", label: "1W", sec: 604800 },
  { id: "M", label: "1M", sec: 2592000 },
];

export const RESOLUTION_SEC = Object.fromEntries(CHART_RESOLUTIONS.map((r) => [r.id, r.sec]));
