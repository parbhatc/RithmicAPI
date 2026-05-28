import { BarType } from "./market-enums.js";

/**
 * Parse chart resolution (TradingView-style) → Rithmic bar_type + bar_type_period.
 *
 * @param {number|string} resolution — minutes as number/`"1"`, `"5"`, `"15"`, `"60"`, or `"1D"` / `"D"`
 * @returns {{ barType: number, barTypePeriod: number, periodSeconds: number }}
 */
export function parseResolution(resolution = 1) {
  const raw = String(resolution).trim().toUpperCase();

  if (raw === "D" || raw === "1D" || raw === "DAILY") {
    return { barType: BarType.DAILY_BAR, barTypePeriod: 1, periodSeconds: 86_400 };
  }
  if (raw === "W" || raw === "1W" || raw === "WEEKLY") {
    return { barType: BarType.WEEKLY_BAR, barTypePeriod: 1, periodSeconds: 604_800 };
  }

  const secMatch = /^(\d+)S$/.exec(raw);
  if (secMatch) {
    const sec = Number(secMatch[1]);
    return { barType: BarType.SECOND_BAR, barTypePeriod: sec, periodSeconds: sec };
  }

  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`Invalid resolution: ${resolution}`);
  }

  return {
    barType: BarType.MINUTE_BAR,
    barTypePeriod: minutes,
    periodSeconds: minutes * 60,
  };
}

/**
 * Resolve history range from TradingView-style and legacy options.
 *
 * Query-style (preferred):
 * - `resolution` — bar size (default `1` = 1 minute)
 * - `from` — range start (Unix seconds) → Rithmic `start_index`
 * - `to` — range end (Unix seconds) → Rithmic `finish_index`
 * - `countback` — bar count; used when `from` is omitted: `from = to - countback * period`
 *
 * Legacy aliases: `start_index`, `finish_index`, `barCount`, `period`, `barType`.
 *
 * @param {object} options
 * @returns {{ barType: number, barTypePeriod: number, periodSeconds: number, start_index: number, finish_index: number }}
 */
export function resolveHistoryQuery(options = {}) {
  const resolution = options.resolution ?? options.period ?? 1;
  const { barType, barTypePeriod, periodSeconds } =
    options.barType != null
      ? {
          barType: options.barType,
          barTypePeriod: options.barTypePeriod ?? options.period ?? 1,
          periodSeconds: (options.barTypePeriod ?? options.period ?? 1) * 60,
        }
      : parseResolution(resolution);

  const countback = options.countback ?? options.barCount;
  let finish_index = options.finish_index ?? options.to;
  let start_index = options.start_index ?? options.from;

  if (finish_index == null) {
    finish_index = Math.floor(Date.now() / 1000);
  }

  if (start_index == null && countback != null) {
    start_index = finish_index - countback * periodSeconds;
  }

  if (start_index == null) {
    const n = countback ?? 300;
    start_index = finish_index - n * periodSeconds;
  }

  return {
    barType,
    barTypePeriod,
    periodSeconds,
    start_index: Math.floor(start_index),
    finish_index: Math.floor(finish_index),
    resolution: String(resolution),
    countback: countback ?? null,
  };
}

/**
 * Chart payload `{ s, t, o, h, l, c, v }`.
 *
 * @param {object[]} bars — normalized bars from `normalizeBar`
 * @param {object} [options]
 * @param {number} [options.timeOffset=0] — add to each `t` (e.g. `-60` for label shifts)
 * @param {boolean} [options.compat=false] — align OHLCV to next bar while keeping current `t`
 */
export function barsToHistoryPayload(bars, { timeOffset = 0, compat = false } = {}) {
  const t = [];
  const o = [];
  const h = [];
  const l = [];
  const c = [];
  const v = [];

  if (compat) {
    for (let i = 0; i + 1 < bars.length; i++) {
      const labelBar = bars[i];
      const valueBar = bars[i + 1];
      const marker = Number(labelBar.marker ?? 0);
      const nextMarker = Number(valueBar.marker ?? marker);
      const step = Number(labelBar.period ?? valueBar.period ?? 60) || 60;
      const gap = nextMarker - marker;
      const compatMarker = gap > step ? nextMarker - step : marker;
      t.push(compatMarker + timeOffset);
      o.push(valueBar.open);
      h.push(valueBar.high);
      l.push(valueBar.low);
      c.push(valueBar.close);
      v.push(valueBar.volume ?? 0);
    }
    return { s: "ok", t, o, h, l, c, v };
  }

  for (const bar of bars) {
    t.push((bar.marker ?? 0) + timeOffset);
    o.push(bar.open);
    h.push(bar.high);
    l.push(bar.low);
    c.push(bar.close);
    v.push(bar.volume ?? 0);
  }

  return { s: "ok", t, o, h, l, c, v };
}
