/** Bar types for RequestTimeBarReplay / RequestTimeBarUpdate / TimeBar. */
export const BarType = {
  UNSPECIFIED: 0,
  SECOND_BAR: 1,
  MINUTE_BAR: 2,
  DAILY_BAR: 3,
  WEEKLY_BAR: 4,
};

/** RequestTimeBarReplay.direction */
export const ReplayDirection = {
  UNSPECIFIED: 0,
  FIRST: 1,
  LAST: 2,
};

/** RequestTimeBarReplay.time_order */
export const ReplayTimeOrder = {
  UNSPECIFIED: 0,
  FORWARDS: 1,
  BACKWARDS: 2,
};

/** RequestMarketDataUpdate.request / RequestTimeBarUpdate.request */
export const SubscribeRequest = {
  UNSPECIFIED: 0,
  SUBSCRIBE: 1,
  UNSUBSCRIBE: 2,
};

/** RequestMarketDataUpdate.update_bits (bitmask). */
export const MarketUpdateBits = {
  LAST_TRADE: 1,
  BBO: 2,
  ORDER_BOOK: 4,
  OPEN: 8,
  HIGH_LOW: 32,
  CLOSE: 128,
  SETTLEMENT: 512,
};

/** Common presets for live quote panels. */
export const MarketUpdatePreset = {
  /** Last price + best bid/ask (templates 150, 151). */
  QUOTE: MarketUpdateBits.LAST_TRADE | MarketUpdateBits.BBO,
  /** Last trade only. */
  LAST: MarketUpdateBits.LAST_TRADE,
  /** Bid/ask only. */
  BBO: MarketUpdateBits.BBO,
};

/** LastTrade.presence_bits (best_bid_offer / last_trade.proto). */
export const LastTradePresence = {
  LAST_TRADE: 1,
  NET_CHANGE: 2,
  PERCENT_CHANGE: 4,
  VOLUME: 8,
  VWAP: 16,
};

/** BestBidOffer.presence_bits */
export const BestBidOfferPresence = {
  BID: 1,
  ASK: 2,
  LEAN_PRICE: 4,
};
