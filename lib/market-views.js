import { toPlain } from "./util.js";
import { BarType, LastTradePresence, BestBidOfferPresence } from "./market-enums.js";

const BAR_TYPE_NAME = {
  0: "UNSPECIFIED",
  1: "SECOND_BAR",
  2: "MINUTE_BAR",
  3: "DAILY_BAR",
  4: "WEEKLY_BAR",
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

function barTypeName(value) {
  return BAR_TYPE_NAME[value] ?? String(value);
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

/** OHLC bar from ResponseTimeBarReplay (203) or live TimeBar (250). */
export function normalizeBar(msg, { defaultPeriod = 60 } = {}) {
  const p = toPlain(msg.toObject());
  const periodSec =
    p.period != null ? Number(p.period) : p.bar_type_period != null ? p.bar_type_period * 60 : defaultPeriod;

  return {
    source: msg.constructor.MESSAGE_NAME,
    symbol: p.symbol,
    exchange: p.exchange,
    bar_type: barTypeName(p.type ?? p.bar_type),
    period: String(periodSec),
    marker: toNum(p.marker),
    open: p.open_price,
    high: p.high_price,
    low: p.low_price,
    close: p.close_price,
    volume: toNum(p.volume),
    bid_volume: toNum(p.bid_volume),
    ask_volume: toNum(p.ask_volume),
    num_trades: toNum(p.num_trades),
    settlement: p.settlement_price,
    has_settlement: Boolean(p.has_settlement_price),
    user_msg: firstStr(p.user_msg),
    rp_code: firstStr(p.rp_handler_rp_code ?? p.rp_code),
  };
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

export { BarType };
