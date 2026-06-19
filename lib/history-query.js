import { BarType, TickBarType, TickBarSubType } from "./market-enums.js";
import { tickBarTime } from "./market-views.js";
import { yyyymmddChicago, unixFromYyyymmddChicago } from "./forming-bar.js";

/** Rithmic daily/weekly replay uses YYYYMMDD indices, not Unix seconds. */
function toCalendarReplayIndex(value, barType) {
  const n = Math.floor(Number(value));
  if (barType !== BarType.DAILY_BAR && barType !== BarType.WEEKLY_BAR) return n;
  if (n > 99_999_999) return yyyymmddChicago(n);
  return n;
}

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
  if (raw === "M" || raw === "1M" || raw === "MONTHLY") {
    return { barType: BarType.DAILY_BAR, barTypePeriod: 30, periodSeconds: 30 * 86_400 };
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
 * Parse tick resolution strings like `100T`, `1T`, `500T`.
 *
 * @param {number|string} resolution
 * @returns {{ barType: number, barSubType: number, barTypeSpecifier: string, tickSize: number }}
 */
export function parseTickResolution(resolution = "1T") {
  const raw = String(resolution).trim().toUpperCase();
  const match = /^(\d+)\s*T?$/.exec(raw);
  if (!match) {
    throw new Error(`Invalid tick resolution: ${resolution} (expected e.g. 100T)`);
  }
  const tickSize = Number(match[1]);
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    throw new Error(`Invalid tick resolution: ${resolution}`);
  }
  return {
    barType: TickBarType.TICK_BAR,
    barSubType: TickBarSubType.REGULAR,
    barTypeSpecifier: String(tickSize),
    tickSize,
  };
}

/**
 * Resolve tick bar history range (supports fractional `from` / `to` like chart UIs).
 *
 * @param {object} options
 */
export function resolveTickHistoryQuery(options = {}) {
  let tick;
  if (options.barType != null) {
    const size = options.barTypeSpecifier ?? options.tickSize ?? "1";
    tick = {
      barType: options.barType,
      barSubType: options.barSubType ?? TickBarSubType.REGULAR,
      barTypeSpecifier: String(size),
      tickSize: Number(size),
    };
  } else if (options.resolution != null) {
    tick = parseTickResolution(options.resolution);
  } else if (options.barTypeSpecifier != null || options.tickSize != null) {
    const size = options.barTypeSpecifier ?? options.tickSize ?? "1";
    tick = {
      barType: TickBarType.TICK_BAR,
      barSubType: options.barSubType ?? TickBarSubType.REGULAR,
      barTypeSpecifier: String(size),
      tickSize: Number(size),
    };
  } else {
    tick = parseTickResolution("1T");
  }

  const countback = options.countback ?? options.barCount;
  let finish_index = options.finish_index ?? options.to;
  let start_index = options.start_index ?? options.from;

  if (finish_index == null) finish_index = Date.now() / 1000;
  if (start_index == null && countback != null) {
    const span = Math.max(options.windowSeconds ?? 3600, countback * 60);
    start_index = finish_index - span;
  }
  if (start_index == null) {
    const n = countback ?? 300;
    start_index = finish_index - n * 60;
  }

  return {
    ...tick,
    tickSize: tick.tickSize ?? Number(tick.barTypeSpecifier),
    start_index: Math.floor(start_index),
    finish_index: Math.floor(finish_index),
    resolution: String(options.resolution ?? `${tick.barTypeSpecifier}T`),
    countback: countback ?? null,
  };
}

/**
 * Combine consecutive 1-tick bars into N-tick OHLC bars (e.g. 100T).
 *
 * @param {object[]} bars Sorted 1-tick bars
 * @param {number} tickSize Bar width in ticks (e.g. 100)
 */
export function aggregateTickBars(bars, tickSize) {
  const n = Math.floor(Number(tickSize));
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`Invalid tick size for aggregation: ${tickSize}`);
  }
  if (n === 1) return bars;

  const out = [];
  for (let i = 0; i + n <= bars.length; i += n) {
    const chunk = bars.slice(i, i + n);
    const first = chunk[0];
    const last = chunk[n - 1];
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    for (const b of chunk) {
      high = Math.max(high, Number(b.high));
      low = Math.min(low, Number(b.low));
      volume += Number(b.volume ?? 0);
    }
    out.push({
      ...last,
      type_specifier: String(n),
      open: first.open,
      high,
      low,
      close: last.close,
      volume,
      t: tickBarTime(last),
    });
  }
  return out;
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

  finish_index = Math.floor(finish_index);
  start_index = Math.floor(start_index);

  if (barType === BarType.DAILY_BAR || barType === BarType.WEEKLY_BAR) {
    finish_index = toCalendarReplayIndex(finish_index, barType);
    if (options.from == null && options.start_index == null && countback != null) {
      const finishUnix = unixFromYyyymmddChicago(finish_index);
      start_index = toCalendarReplayIndex(finishUnix - countback * periodSeconds, barType);
    } else {
      start_index = toCalendarReplayIndex(start_index, barType);
    }
  }

  return {
    barType,
    barTypePeriod,
    periodSeconds,
    start_index,
    finish_index,
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

  const barTime = (bar) => {
    if (bar.t != null && Number.isFinite(Number(bar.t))) return Number(bar.t);
    const marker = Number(bar.marker ?? 0);
    const usecs = Number(bar.usecs ?? 0);
    return marker + (Number.isFinite(usecs) ? usecs : 0) / 1_000_000;
  };

  if (compat) {
    for (let i = 0; i + 1 < bars.length; i++) {
      const labelBar = bars[i];
      const valueBar = bars[i + 1];
      const labelT = barTime(labelBar);
      const valueT = barTime(valueBar);
      const step =
        Number(labelBar.period ?? valueBar.period) ||
        Math.max(valueT - labelT, 1e-6) ||
        60;
      const gap = valueT - labelT;
      // Forming: bucket open. Session gap: label at bucket open (valueT - step). Contiguous: prior label time.
      const compatT = valueBar.forming
        ? valueT
        : gap > step
          ? valueT - step
          : labelT;
      t.push(compatT + timeOffset);
      o.push(valueBar.open);
      h.push(valueBar.high);
      l.push(valueBar.low);
      c.push(valueBar.close);
      v.push(valueBar.volume ?? 0);
    }
    return { s: "ok", t, o, h, l, c, v };
  }

  for (const bar of bars) {
    t.push(barTime(bar) + timeOffset);
    o.push(bar.open);
    h.push(bar.high);
    l.push(bar.low);
    c.push(bar.close);
    v.push(bar.volume ?? 0);
  }

  return { s: "ok", t, o, h, l, c, v };
}

/**
 * Trim to `countback` bars when the replay returns more than requested.
 *
 * @param {object[]} bars
 * @param {number} countback
 * @param {"from"|"to"|"spread"} [anchor="to"] — `"to"` newest, `"from"` oldest, `"spread"` evenly across time
 */
export function trimCountbackBars(bars, countback, anchor = "to") {
  if (bars.length <= countback) return bars;
  if (anchor === "spread") return subsampleCountbackBars(bars, countback);
  return anchor === "from" ? bars.slice(0, countback) : bars.slice(-countback);
}

/**
 * Pick `countback` bars evenly spaced across a sorted series (for wide from/to + countback).
 *
 * @param {object[]} bars — sorted ascending by time
 * @param {number} countback
 */
export function subsampleCountbackBars(bars, countback) {
  const n = bars.length;
  if (n <= countback) return bars;
  if (countback <= 1) return [bars[0]];
  const out = [];
  for (let i = 0; i < countback; i++) {
    const idx = Math.round((i * (n - 1)) / (countback - 1));
    out.push(bars[idx]);
  }
  return out;
}
