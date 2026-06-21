import { toPlain } from "./util.js";
import {
  TimeBarType,
  TickBarType,
  TickBarSubType,
  BarType,
  LastTradePresence,
  BestBidOfferPresence,
} from "./marketEnums.js";

const TIME_BAR_TYPE_NAME = {
  0: "UNSPECIFIED",
  1: "SECOND_BAR",
  2: "MINUTE_BAR",
  3: "DAILY_BAR",
  4: "WEEKLY_BAR",
};

const TICK_BAR_TYPE_NAME = {
  0: "UNSPECIFIED",
  1: "TICK_BAR",
  2: "RANGE_BAR",
  3: "VOLUME_BAR",
};

const TICK_BAR_SUB_TYPE_NAME = {
  0: "UNSPECIFIED",
  1: "REGULAR",
  2: "CUSTOM",
};

function toNum(value) {
  if (value == null) return value;
  if (typeof value === "object" && typeof value.toNumber === "function") return value.toNumber();
  return Number(value);
}

function firstStr(value) {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value[0];
  return String(value);
}

function timeBarTypeName(value) {
  return TIME_BAR_TYPE_NAME[value] ?? String(value);
}

function tickBarTypeName(value) {
  return TICK_BAR_TYPE_NAME[value] ?? String(value);
}

function tickBarSubTypeName(value) {
  return TICK_BAR_SUB_TYPE_NAME[value] ?? String(value);
}

function hasBit(bits, flag) {
  return (toNum(bits) & flag) !== 0;
}

/** Merge partial tick updates; `undefined` on `next` keeps the previous value. */
export function mergeTick(prev, next) {
  if (!next) return prev ?? null;
  if (!prev) return { ...next };
  const out = { ...prev };
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Rithmic daily/weekly bars use marker as YYYYMMDD (e.g. 20250428), not Unix seconds. */
export function calendarMarkerToUnix(marker) {
  const n = Number(marker);
  if (!Number.isFinite(n) || n < 19_000_000 || n > 30_000_000) return null;
  return calendarDateToChicagoUnix(
    Math.floor(n / 10_000),
    Math.floor((n % 10_000) / 100),
    n % 100,
  );
}

/** Unix seconds for Chicago midnight on a calendar date (CME session day). */
export function calendarDateToChicagoUnix(year, month, day) {
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const target = { y: year, m: month, d: day };
  let lo = Date.UTC(year, month - 1, day) / 1000 - 86_400;
  let hi = lo + 2 * 86_400;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const p = chicagoDateParts(mid);
    const before =
      p.y < target.y ||
      (p.y === target.y && p.m < target.m) ||
      (p.y === target.y && p.m === target.m && p.d < target.d);
    if (before) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function chicagoDateParts(unixSec) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date(unixSec * 1000));
  return {
    y: Number(parts.find((p) => p.type === "year").value),
    m: Number(parts.find((p) => p.type === "month").value),
    d: Number(parts.find((p) => p.type === "day").value),
  };
}

/** Convert Unix seconds → YYYYMMDD in America/Chicago (replay index for daily/weekly bars). */
export function unixToCalendarMarker(unixSec) {
  const p = chicagoDateParts(Math.floor(unixSec));
  return p.y * 10_000 + p.m * 100 + p.d;
}

function isCalendarBar(bar) {
  const t = bar?.bar_type;
  return t === "DAILY_BAR" || t === "WEEKLY_BAR" || t === 3 || t === 4;
}

export function barTimeSec(bar) {
  if (bar.t != null && Number.isFinite(Number(bar.t))) return Number(bar.t);
  const marker = Number(bar.marker ?? 0);
  const usecs = Number(bar.usecs ?? 0);
  if (usecs) return marker + usecs / 1_000_000;
  const cal = calendarMarkerToUnix(marker);
  if (cal != null) return cal;
  if (isCalendarBar(bar)) {
    const fallback = calendarMarkerToUnix(marker);
    if (fallback != null) return fallback;
  }
  return marker;
}

/** Fractional Unix time from Rithmic tick bar fields (ssboe + usecs). */
export function tickBarTime(bar) {
  const ssboe = Number(bar?.marker ?? 0);
  const usecs = Number(bar?.usecs ?? 0);
  if (!Number.isFinite(ssboe)) return 0;
  return ssboe + (Number.isFinite(usecs) ? usecs : 0) / 1_000_000;
}

/** OHLC tick bar from ResponseTickBarReplay (207) or live TickBar (251). */
export function normalizeTickBar(msg) {
  const p = toPlain(msg.toObject());
  const ssboe = Array.isArray(p.data_bar_ssboe) ? p.data_bar_ssboe[0] : p.data_bar_ssboe;
  const usecs = Array.isArray(p.data_bar_usecs) ? p.data_bar_usecs[0] : p.data_bar_usecs;

  const bar = {
    source: msg.constructor.MESSAGE_NAME,
    symbol: p.symbol,
    exchange: p.exchange,
    bar_type: tickBarTypeName(p.type ?? p.bar_type),
    bar_sub_type: tickBarSubTypeName(p.sub_type ?? p.bar_sub_type),
    type_specifier: p.type_specifier ?? p.bar_type_specifier,
    marker: toNum(ssboe),
    usecs: toNum(usecs),
    open: toNum(p.open_price),
    high: toNum(p.high_price),
    low: toNum(p.low_price),
    close: toNum(p.close_price),
    volume: toNum(p.volume),
    bid_volume: toNum(p.bid_volume),
    ask_volume: toNum(p.ask_volume),
    num_trades: toNum(p.num_trades),
    user_msg: firstStr(p.user_msg),
    rp_code: firstStr(p.rp_handler_rp_code ?? p.rp_code),
  };
  bar.t = tickBarTime(bar);
  return bar;
}

/** OHLC bar from ResponseTimeBarReplay (203) or live TimeBar (250). */
export function normalizeBar(msg, { defaultPeriod = 60 } = {}) {
  const p = toPlain(msg.toObject());
  const barTypeRaw = p.type ?? p.bar_type;
  const barType = timeBarTypeName(barTypeRaw);

  let periodSec = defaultPeriod;
  const periodNum = p.period != null ? Number(p.period) : NaN;
  if (Number.isFinite(periodNum) && periodNum > 0) {
    periodSec = periodNum;
  } else if (barTypeRaw === 3 || barType === "DAILY_BAR") {
    periodSec = 86_400;
  } else if (barTypeRaw === 4 || barType === "WEEKLY_BAR") {
    periodSec = 604_800;
  } else if (barTypeRaw === 1 || barType === "SECOND_BAR") {
    periodSec = p.bar_type_period ?? defaultPeriod;
  } else if (p.bar_type_period != null) {
    periodSec = p.bar_type_period * 60;
  }

  const marker = toNum(p.marker);
  const bar = {
    source: msg.constructor.MESSAGE_NAME,
    symbol: p.symbol,
    exchange: p.exchange,
    bar_type: barType,
    period: String(periodSec),
    marker,
    open: toNum(p.open_price),
    high: toNum(p.high_price),
    low: toNum(p.low_price),
    close: toNum(p.close_price),
    volume: toNum(p.volume),
    bid_volume: toNum(p.bid_volume),
    ask_volume: toNum(p.ask_volume),
    num_trades: toNum(p.num_trades),
    settlement: p.settlement_price,
    has_settlement: Boolean(p.has_settlement_price),
    user_msg: firstStr(p.user_msg),
    rp_code: firstStr(p.rp_handler_rp_code ?? p.rp_code),
  };
  bar.t = barTimeSec(bar);
  return bar;
}

/** Last trade tick (template 150). Only fields set in presence_bits are populated. */
export function normalizeTrade(msg) {
  const p = toPlain(msg.toObject());
  const bits = toNum(p.presence_bits) ?? 0;
  return {
    source: "LastTrade",
    symbol: p.symbol,
    exchange: p.exchange,
    presence_bits: bits,
    price: hasBit(bits, LastTradePresence.LAST_TRADE) ? p.trade_price : undefined,
    size: hasBit(bits, LastTradePresence.LAST_TRADE) ? toNum(p.trade_size) : undefined,
    volume: hasBit(bits, LastTradePresence.VOLUME) ? toNum(p.volume) : undefined,
    net_change: hasBit(bits, LastTradePresence.NET_CHANGE) ? p.net_change : undefined,
    percent_change: hasBit(bits, LastTradePresence.PERCENT_CHANGE) ? p.percent_change : undefined,
    vwap: hasBit(bits, LastTradePresence.VWAP) ? p.vwap : undefined,
    aggressor: p.aggressor,
    is_snapshot: Boolean(p.is_snapshot),
    trade_time: p.trade_time,
    ssboe: toNum(p.ssboe),
  };
}

/** Best bid/offer (template 151). Only fields set in presence_bits are populated. */
export function normalizeQuote(msg) {
  const p = toPlain(msg.toObject());
  const bits = toNum(p.presence_bits) ?? 0;
  return {
    source: "BestBidOffer",
    symbol: p.symbol,
    exchange: p.exchange,
    presence_bits: bits,
    bid: hasBit(bits, BestBidOfferPresence.BID) ? p.bid_price : undefined,
    bid_size: hasBit(bits, BestBidOfferPresence.BID) ? toNum(p.bid_size) : undefined,
    ask: hasBit(bits, BestBidOfferPresence.ASK) ? p.ask_price : undefined,
    ask_size: hasBit(bits, BestBidOfferPresence.ASK) ? toNum(p.ask_size) : undefined,
    lean: hasBit(bits, BestBidOfferPresence.LEAN_PRICE) ? p.lean_price : undefined,
    is_snapshot: Boolean(p.is_snapshot),
    ssboe: toNum(p.ssboe),
  };
}

/** Session close / settlement snapshot (template 155). */
export function normalizeClosePrice(msg) {
  const p = toPlain(msg.toObject());
  return {
    source: "ClosePrice",
    symbol: p.symbol,
    exchange: p.exchange,
    close_price: p.close_price,
    close_date: p.close_date,
    settlement_price: p.settlement_price,
    settlement_date: p.settlement_date,
    price_type: p.price_type,
    presence_bits: toNum(p.presence_bits) ?? 0,
    is_snapshot: Boolean(p.is_snapshot),
    ssboe: toNum(p.ssboe),
  };
}

/** Session high/low snapshot (template 152). */
export function normalizeHighLow(msg) {
  const p = toPlain(msg.toObject());
  return {
    source: "HighPriceLowPrice",
    symbol: p.symbol,
    exchange: p.exchange,
    high_price: p.high_price,
    low_price: p.low_price,
    presence_bits: toNum(p.presence_bits) ?? 0,
    is_snapshot: Boolean(p.is_snapshot),
    ssboe: toNum(p.ssboe),
  };
}

/** Compact chart status object for UI headers. */
export function chartStatus({ symbol, exchange, trade, quote, bar, latestHighLow, latestClose }) {
  return {
    symbol,
    exchange,
    last: trade?.price ?? bar?.close,
    bid: quote?.bid,
    ask: quote?.ask,
    bid_size: quote?.bid_size,
    ask_size: quote?.ask_size,
    vwap: trade?.vwap,
    net_change: trade?.net_change,
    volume: trade?.volume ?? bar?.volume,
    latest_high: latestHighLow?.high_price,
    latest_low: latestHighLow?.low_price,
    latest_close: latestClose?.close_price,
    latest_settlement: latestClose?.settlement_price,
    bar_marker: bar?.marker,
    bar_close: bar?.close,
    updated_at: Date.now(),
  };
}

export { TimeBarType, TickBarType, TickBarSubType, BarType };
