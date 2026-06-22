import { TimeBarType } from "./market-enums.js";

const CHICAGO = "America/Chicago";
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** Bar open time (Unix seconds) for a UTC-epoch-aligned bucket. */
export function bucketOpen(unixSec, periodSeconds) {
  return Math.floor(unixSec / periodSeconds) * periodSeconds;
}

/** True for calendar resolutions (`1D`, `1W`, `1M`) that anchor in Chicago time. */
export function isCalendarResolution(resolution) {
  const raw = String(resolution).trim().toUpperCase();
  return (
    raw === "D" ||
    raw === "1D" ||
    raw === "DAILY" ||
    raw === "W" ||
    raw === "1W" ||
    raw === "WEEKLY" ||
    raw === "M" ||
    raw === "1M" ||
    raw === "MONTHLY" ||
    raw === "Y" ||
    raw === "1Y" ||
    raw === "12M" ||
    raw === "YEARLY"
  );
}

/** YYYYMMDD integer for a Chicago calendar date (Rithmic daily/weekly markers). */
export function yyyymmddChicago(unixSec) {
  const w = chicagoWallClock(unixSec);
  return w.year * 10_000 + w.month * 100 + w.day;
}

/** Chicago midnight Unix seconds from a Rithmic YYYYMMDD marker. */
export function unixFromYyyymmddChicago(yyyymmdd) {
  const n = Number(yyyymmdd);
  const day = n % 100;
  const month = Math.floor(n / 100) % 100;
  const year = Math.floor(n / 10_000);
  return chicagoMidnight(year, month, day);
}

/** Normalize Rithmic calendar bar marker to Chicago-midnight Unix (for chart APIs). */
export function calendarBarUnix(marker, resolution) {
  const m = Number(marker);
  if (!Number.isFinite(m) || m <= 0) return m;
  if (m >= 1_000_000_000) return m;
  const raw = String(resolution).trim().toUpperCase();
  if (raw === "W" || raw === "1W" || raw === "WEEKLY") {
    return unixFromYyyymmddChicago(m);
  }
  if (
    raw === "D" ||
    raw === "1D" ||
    raw === "DAILY" ||
    raw === "M" ||
    raw === "1M" ||
    raw === "MONTHLY" ||
    raw === "Y" ||
    raw === "1Y" ||
    raw === "12M" ||
    raw === "YEARLY"
  ) {
    return unixFromYyyymmddChicago(m);
  }
  return m;
}

/** Expected Rithmic YYYYMMDD marker for the open bucket at `unixSec`. */
export function chartBucketRithmicMarker(unixSec, resolution) {
  const open = chartBucketOpen(unixSec, resolution);
  return yyyymmddChicago(open);
}

/** Chicago wall-clock parts for a Unix timestamp. */
export function chicagoWallClock(unixSec) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CHICAGO,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(unixSec * 1000));
  const g = (t) => parts.find((p) => p.type === t)?.value;
  const weekday = g("weekday");
  return {
    year: Number(g("year")),
    month: Number(g("month")),
    day: Number(g("day")),
    weekday,
    weekdayIndex: WEEKDAYS.indexOf(weekday),
    hour: Number(g("hour")),
    minute: Number(g("minute")),
    second: Number(g("second")),
  };
}

/** Unix seconds for Chicago local time on `year-month-day` at `hour` (0ΓÇô23). */
export function chicagoMidnightAtHour(year, month, day, hour = 0) {
  return chicagoMidnight(year, month, day) + hour * 3600;
}

/**
 * CME Globex session open (5:00 PM Chicago). Used for TradeSea session OHLC parity.
 * Handles weekend gaps by anchoring to the prior Sunday 5 PM when the market is closed.
 */
export function chicagoGlobexSessionOpen(unixSec) {
  const w = chicagoWallClock(unixSec);
  const today5pm = chicagoMidnightAtHour(w.year, w.month, w.day, 17);

  if (w.weekdayIndex === 6) {
    return today5pm - 86400;
  }
  if (w.weekdayIndex === 0 && w.hour < 17) {
    return today5pm - 2 * 86400;
  }
  if (w.hour >= 17) {
    return today5pm;
  }
  return today5pm - 86400;
}

/** Unix seconds for Chicago local midnight on `year-month-day`. */
export function chicagoMidnight(year, month, day) {
  let lo = Math.floor(Date.UTC(year, month - 1, day - 1, 6) / 1000);
  let hi = Math.floor(Date.UTC(year, month - 1, day + 1, 6) / 1000);
  for (let t = lo; t <= hi; t += 60) {
    const w = chicagoWallClock(t);
    if (
      w.year === year &&
      w.month === month &&
      w.day === day &&
      w.hour === 0 &&
      w.minute === 0 &&
      w.second === 0
    ) {
      return t;
    }
  }
  return lo;
}

/**
 * Chart bucket open ΓÇö epoch buckets for intraday, Chicago calendar for `1D`/`1W`/`1M`.
 *
 * @param {number} unixSec
 * @param {number|string} resolutionOrPeriod ΓÇö minutes as number, or `"1D"` / `"1W"` / `"1M"`
 */
export function chartBucketOpen(unixSec, resolutionOrPeriod) {
  if (typeof resolutionOrPeriod === "string" && isCalendarResolution(resolutionOrPeriod)) {
    const raw = resolutionOrPeriod.trim().toUpperCase();
    const w = chicagoWallClock(unixSec);
    if (raw === "D" || raw === "1D" || raw === "DAILY") {
      return chicagoMidnight(w.year, w.month, w.day);
    }
    if (raw === "W" || raw === "1W" || raw === "WEEKLY") {
      const daysFromMonday = (w.weekdayIndex + 6) % 7;
      const dayStart = chicagoMidnight(w.year, w.month, w.day);
      return dayStart - daysFromMonday * 86_400;
    }
    if (raw === "M" || raw === "1M" || raw === "MONTHLY") {
      return chicagoMidnight(w.year, w.month, 1);
    }
    if (raw === "Y" || raw === "1Y" || raw === "12M" || raw === "YEARLY") {
      return chicagoMidnight(w.year, 1, 1);
    }
  }
  const ps =
    typeof resolutionOrPeriod === "number"
      ? resolutionOrPeriod
      : Number(resolutionOrPeriod) * 60;
  return bucketOpen(unixSec, ps);
}

/** `bar_type` + `bar_type_period` ΓåÆ bucket width in seconds. */
export function periodSecondsFromBarType(barType, barPeriod) {
  const p = Number(barPeriod) || 1;
  switch (barType) {
    case TimeBarType.SECOND_BAR:
      return p;
    case TimeBarType.MINUTE_BAR:
      return p * 60;
    case TimeBarType.DAILY_BAR:
      return 86_400 * p;
    case TimeBarType.WEEKLY_BAR:
      return 604_800 * p;
    default:
      return p * 60;
  }
}

/** Apply bucket open; only pull low down ΓÇö keep aggregated high/low from sub-bars. */
export function applyBucketOpen(bar, open) {
  if (!bar || !isUsablePrice(open)) return bar;
  const o = Number(open);
  const high = Number(bar.high);
  const low = Number(bar.low);
  return {
    ...bar,
    open: o,
    high: isUsablePrice(high) ? Math.max(high, o) : o,
    low: isUsablePrice(low) ? Math.min(low, o) : o,
  };
}

/** True when a price looks like a real quote (filters unset/zero template fields). */
export function isUsablePrice(price) {
  const n = Number(price);
  return Number.isFinite(n) && n > 0;
}

/**
 * TradeSea 1m open from 1s sub-bars: skip the boundary 1s print at bucket :00;
 * real session open is the :01 (second) 1s bar when present.
 */
export function tradeseaMinuteOpenFrom1s(bars1s, marker) {
  if (!bars1s?.length) return null;
  const sorted = [...bars1s].sort(
    (a, b) => Number(a.marker) - Number(b.marker),
  );
  const pick = (bar) => {
    const o = Number(bar?.open ?? bar?.close);
    return isUsablePrice(o) ? o : null;
  };

  const first = sorted[0];
  const o0 = pick(first);
  if (o0 == null) return null;

  const firstT = Number(first.marker);
  if (firstT === Number(marker) && sorted.length > 1) {
    const o1 = pick(sorted[1]);
    if (o1 != null) return o1;
  }
  return o0;
}

/** Last history bar strictly before `marker`. */
export function priorBarBefore(bars, marker) {
  const m = Number(marker);
  for (let i = bars.length - 1; i >= 0; i--) {
    if (Number(bars[i].marker) < m) return bars[i];
  }
  return null;
}

/**
 * Split replay: closed bars vs partial bar for the still-open bucket (if any).
 */
export function splitHistoryForForming(bars, periodSeconds, nowSec, resolution) {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const currentOpen =
    resolution != null && isCalendarResolution(resolution)
      ? chartBucketOpen(now, resolution)
      : bucketOpen(now, periodSeconds);
  const last = bars.at(-1);
  if (!last) {
    return { closed: [...bars], partial: null, currentOpen };
  }

  const lastMarker = Number(last.marker);
  const matchesCurrent =
    resolution != null && isCalendarResolution(resolution)
      ? lastMarker === chartBucketRithmicMarker(now, resolution) ||
        calendarBarUnix(lastMarker, resolution) === currentOpen
      : lastMarker === currentOpen;

  if (!matchesCurrent) {
    return { closed: [...bars], partial: null, currentOpen };
  }
  return {
    closed: bars.slice(0, -1),
    partial: last,
    currentOpen,
  };
}

/**
 * Build OHLCV for one time bucket from replayed sub-bars (1-tick or 1s).
 */
export function aggregateReplayOHLC(
  bars,
  { marker, periodSeconds, symbol, exchange } = {},
) {
  if (!bars?.length) return null;

  const sorted = [...bars].sort(
    (a, b) => Number(a.marker ?? 0) - Number(b.marker ?? 0),
  );

  let open;
  let high = -Infinity;
  let low = Infinity;
  let close;
  let volume = 0;
  let num_trades = 0;

  for (const b of sorted) {
    const o = Number(b.open);
    const h = Number(b.high ?? b.close ?? b.open);
    const l = Number(b.low ?? b.close ?? b.open);
    const c = Number(b.close ?? b.open);
    const useO = isUsablePrice(o) ? o : isUsablePrice(c) ? c : null;
    const useC = isUsablePrice(c) ? c : useO;
    if (useO == null && useC == null) continue;

    if (open == null) open = useO ?? useC;
    const hi = [h, o, c].filter(isUsablePrice);
    const lo = [l, o, c].filter(isUsablePrice);
    if (hi.length) high = Math.max(high, ...hi);
    if (lo.length) low = Math.min(low, ...lo);
    close = useC ?? close;
    volume += Number(b.volume ?? 0);
    num_trades += Number(b.num_trades ?? 0);
  }

  if (open == null || !Number.isFinite(close)) return null;
  if (!Number.isFinite(high)) high = Math.max(open, close);
  if (!Number.isFinite(low)) low = Math.min(open, close);

  return {
    symbol: symbol ?? sorted[0]?.symbol,
    exchange: exchange ?? sorted[0]?.exchange,
    marker: marker ?? Number(sorted[0].marker),
    period: String(periodSeconds),
    open,
    high,
    low,
    close,
    volume,
    num_trades,
    forming: true,
  };
}

/**
 * New in-progress OHLC bar seeded with one price (usually prior bar close).
 */
export function createFormingBar({
  marker,
  seedPrice,
  symbol,
  exchange,
  periodSeconds,
  volume = 0,
  num_trades = 0,
}) {
  const price = Number(seedPrice);
  if (!isUsablePrice(price)) return null;
  return {
    symbol,
    exchange,
    marker,
    period: String(periodSeconds),
    open: price,
    high: price,
    low: price,
    close: price,
    volume,
    num_trades,
    forming: true,
  };
}

/**
 * Seed the current bucket after history replay.
 *
 * Prefer `exactBar` from `fetchExactFormingBar` (tick / 1s / native replay).
 * Do not assume open === prior bar close (Rithmic can gap).
 */
export function seedFormingBar(
  lastBar,
  { periodSeconds, symbol, exchange, nowSec, priorBar, bars, exactOpen, exactBar } = {},
) {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const currentOpen = bucketOpen(now, periodSeconds);

  if (exactBar != null && isUsablePrice(exactBar.open)) {
    return {
      ...exactBar,
      marker: currentOpen,
      period: String(periodSeconds),
      symbol: symbol ?? exactBar.symbol,
      exchange: exchange ?? exactBar.exchange,
      forming: true,
    };
  }

  if (exactOpen != null && Number.isFinite(Number(exactOpen))) {
    const open = Number(exactOpen);
    const partial =
      lastBar && Number(lastBar.marker) === currentOpen ? lastBar : null;
    const bar = createFormingBar({
      marker: currentOpen,
      seedPrice: open,
      symbol: symbol ?? partial?.symbol ?? lastBar?.symbol,
      exchange: exchange ?? partial?.exchange ?? lastBar?.exchange,
      periodSeconds,
      volume: 0,
    });
    if (bar && partial) {
      const snapClose = Number(partial.close);
      if (Number.isFinite(snapClose)) {
        bar.close = snapClose;
        bar.high = Math.max(Number(bar.open), snapClose, Number(bar.high));
        bar.low = Math.min(Number(bar.open), snapClose, Number(bar.low));
      }
      bar.volume = Number(partial.volume ?? 0);
      bar.num_trades = Number(partial.num_trades ?? 0);
    }
    return bar;
  }

  if (!lastBar) return null;

  const lastMarker = Number(lastBar.marker);
  if (lastMarker > currentOpen) return null;

  if (lastMarker === currentOpen) {
    const open = isUsablePrice(lastBar.open)
      ? Number(lastBar.open)
      : Number(lastBar.close);
    if (!isUsablePrice(open)) return null;
    const bar = createFormingBar({
      marker: currentOpen,
      seedPrice: open,
      symbol: symbol ?? lastBar.symbol,
      exchange: exchange ?? lastBar.exchange,
      periodSeconds,
      volume: Number(lastBar.volume ?? 0),
      num_trades: Number(lastBar.num_trades ?? 0),
    });
    return attachPartialSnapshot(bar, lastBar);
  }

  const prior =
    priorBar ??
    (Array.isArray(bars) ? priorBarBefore(bars, currentOpen) : null);
  const seed = Number(lastBar.open ?? lastBar.close ?? prior?.close);
  return createFormingBar({
    marker: currentOpen,
    seedPrice: seed,
    symbol: symbol ?? lastBar.symbol,
    exchange: exchange ?? lastBar.exchange,
    periodSeconds,
  });
}

/**
 * Apply a normalized LastTrade (merged) into the current forming bar.
 */
export function applyTradeToFormingBar(
  forming,
  trade,
  { periodSeconds, symbol, exchange, seedOpen, chartResolution },
) {
  const price = Number(trade?.price);
  const size = Number(trade?.size ?? 0);
  if (!Number.isFinite(price)) return forming;

  const ssboe = Number(trade?.ssboe);
  const now = Number.isFinite(ssboe) && ssboe > 0 ? ssboe : Math.floor(Date.now() / 1000);
  const marker =
    chartResolution != null && isCalendarResolution(chartResolution)
      ? chartBucketOpen(now, chartResolution)
      : bucketOpen(now, periodSeconds);

  let bar = forming;
  if (!bar || Number(bar.marker) !== marker) {
    const seed = Number.isFinite(Number(seedOpen)) ? Number(seedOpen) : price;
    bar = createFormingBar({
      marker,
      seedPrice: seed,
      symbol: symbol ?? trade?.symbol,
      exchange: exchange ?? trade?.exchange,
      periodSeconds,
    });
  }
  if (!bar) return null;

  const vol = Number(bar.volume ?? 0) + (Number.isFinite(size) ? size : 0);
  const fixOpen = !isUsablePrice(bar.open);
  const open = fixOpen ? price : Number(bar.open);
  const high = Math.max(fixOpen ? price : Number(bar.high), price);
  const low = Math.min(
    fixOpen ? price : isUsablePrice(bar.low) ? Number(bar.low) : price,
    price,
  );
  return {
    ...bar,
    open,
    high,
    low,
    close: price,
    volume: vol,
    num_trades: Number(bar.num_trades ?? 0) + 1,
    forming: true,
  };
}

/**
 * Merge a live `TimeBar` snapshot for the **open** bucket into the forming bar.
 * Ignores unset/zero template prices.
 */
export function mergeFormingFromTimeBar(forming, timeBar, { periodSeconds } = {}) {
  if (!timeBar) return forming;
  const marker = Number(timeBar.marker);
  const currentOpen = bucketOpen(Math.floor(Date.now() / 1000), periodSeconds);
  if (marker !== currentOpen) return forming;

  const patch = {};
  if (isUsablePrice(timeBar.open)) patch.open = Number(timeBar.open);
  if (isUsablePrice(timeBar.high)) patch.high = Number(timeBar.high);
  if (isUsablePrice(timeBar.low)) patch.low = Number(timeBar.low);
  if (isUsablePrice(timeBar.close)) patch.close = Number(timeBar.close);
  if (Number.isFinite(Number(timeBar.volume))) patch.volume = Number(timeBar.volume);
  if (Number.isFinite(Number(timeBar.num_trades))) patch.num_trades = Number(timeBar.num_trades);
  if (!Object.keys(patch).length) return forming;

  if (!forming || Number(forming.marker) !== marker) {
    const seed = patch.open ?? patch.close;
    const created = createFormingBar({
      marker,
      seedPrice: seed,
      symbol: timeBar.symbol,
      exchange: timeBar.exchange,
      periodSeconds,
      volume: patch.volume ?? 0,
      num_trades: patch.num_trades ?? 0,
    });
    if (!created) return forming;
    return { ...created, ...patch, forming: true };
  }

  const open = patch.open ?? (isUsablePrice(forming.open) ? Number(forming.open) : patch.close);
  const close = patch.close ?? forming.close;
  const high = Math.max(
    ...[forming.high, patch.high, open, close].filter(isUsablePrice).map(Number),
  );
  const low = Math.min(
    ...[forming.low, patch.low, open, close].filter(isUsablePrice).map(Number),
  );
  return {
    ...forming,
    ...patch,
    open,
    high,
    low,
    close,
    forming: true,
  };
}

/** Insert or replace by `marker` in a sorted bar array. */
export function mergeBarIntoSeries(series, bar) {
  const m = Number(bar.marker);
  const idx = series.findIndex((b) => Number(b.marker) === m);
  if (idx >= 0) {
    const next = [...series];
    next[idx] = bar;
    return next;
  }
  const out = [...series, bar].sort((a, b) => Number(a.marker) - Number(b.marker));
  return out;
}
