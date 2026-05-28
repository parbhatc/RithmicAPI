import { toPlain } from "./util.js";
import { BarType } from "./market-enums.js";

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

/** Last trade tick (template 150). */
export function normalizeTrade(msg) {
  const p = toPlain(msg.toObject());
  return {
    source: "LastTrade",
    symbol: p.symbol,
    exchange: p.exchange,
    price: p.trade_price,
    size: toNum(p.trade_size),
    volume: toNum(p.volume),
    net_change: p.net_change,
    percent_change: p.percent_change,
    vwap: p.vwap,
    aggressor: p.aggressor,
    is_snapshot: Boolean(p.is_snapshot),
    trade_time: p.trade_time,
    ssboe: toNum(p.ssboe),
  };
}

/** Best bid/offer (template 151). */
export function normalizeQuote(msg) {
  const p = toPlain(msg.toObject());
  return {
    source: "BestBidOffer",
    symbol: p.symbol,
    exchange: p.exchange,
    bid: p.bid_price,
    bid_size: toNum(p.bid_size),
    ask: p.ask_price,
    ask_size: toNum(p.ask_size),
    lean: p.lean_price,
    is_snapshot: Boolean(p.is_snapshot),
    ssboe: toNum(p.ssboe),
  };
}

/** Compact chart status object for UI headers. */
export function chartStatus({ symbol, exchange, trade, quote, bar }) {
  return {
    symbol,
    exchange,
    last: trade?.price ?? bar?.close,
    bid: quote?.bid,
    ask: quote?.ask,
    bid_size: quote?.bid_size,
    ask_size: quote?.ask_size,
    net_change: trade?.net_change,
    volume: trade?.volume ?? bar?.volume,
    bar_marker: bar?.marker,
    bar_close: bar?.close,
    updated_at: Date.now(),
  };
}

export { BarType };
