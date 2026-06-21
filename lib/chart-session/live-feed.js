import {
  RequestReferenceData,
  RequestMarketDataUpdate,
  RequestTimeBarUpdate,
  LastTrade,
  BestBidOffer,
  ClosePrice,
  HighPriceLowPrice,
  TimeBar,
} from "../../protocol/index.js";
import {
  BarType,
  SubscribeRequest,
  MarketUpdatePreset,
  LastTradePresence,
  BestBidOfferPresence,
} from "../market-enums.js";
import {
  normalizeBar,
  normalizeTrade,
  normalizeQuote,
  normalizeClosePrice,
  normalizeHighLow,
  mergeTick,
  chartStatus,
} from "../market-views.js";
import { SessionGateway } from "./util.js";

const DEFAULT_BAR_PERIOD = 60;

export class LiveFeed {
  live = false;
  pumps = [];
  trade = null;
  quote = null;
  bar = null;
  latestHighLow = null;
  latestClose = null;
  liveBarType = null;
  liveBarPeriod = null;

  status(session) {
    return chartStatus({
      symbol: session.symbol,
      exchange: session.exchange,
      trade: this.trade,
      quote: this.quote,
      bar: this.bar,
      latestHighLow: this.latestHighLow,
      latestClose: this.latestClose,
    });
  }

  async start(session, ctx, options = {}) {
    if (this.live) return;
    const {
      updateBits = MarketUpdatePreset.QUOTE,
      referenceData = true,
      priceType = "final",
      referenceMode = "auto",
    } = options;

    const msg = SessionGateway.userMsg(session.symbol, session.exchange);
    this.liveBarType = BarType.MINUTE_BAR;
    this.liveBarPeriod = 1;

    if (referenceData) {
      await ctx.ticker.exchange(
        new RequestReferenceData({
          symbol: session.symbol,
          exchange: session.exchange,
          user_msg: [msg, priceType, referenceMode],
        }),
      );
    }

    await ctx.ticker.exchange(
      new RequestMarketDataUpdate({
        symbol: session.symbol,
        exchange: session.exchange,
        user_msg: [msg],
        request: SubscribeRequest.SUBSCRIBE,
        update_bits: updateBits,
      }),
    );

    await ctx.history.exchange(
      new RequestTimeBarUpdate({
        symbol: session.symbol,
        exchange: session.exchange,
        user_msg: [msg],
        request: SubscribeRequest.SUBSCRIBE,
        bar_type: BarType.MINUTE_BAR,
        bar_type_period: 1,
      }),
    );

    const earlyTicker = await ctx.ticker.drain({ idleMs: 400, max: 30 });
    for (const packet of earlyTicker) {
      this.dispatch(session, packet, "ticker");
    }
    const earlyHistory = await ctx.history.drain({ idleMs: 400, max: 30 });
    for (const packet of earlyHistory) {
      this.dispatch(session, packet, "history");
    }

    this.live = true;
    this.pumps.push(
      this.#pump(session, ctx, ctx.ticker, "ticker"),
      this.#pump(session, ctx, ctx.history, "history"),
    );
  }

  async stop(session, ctx) {
    if (!this.live) return;
    const msg = SessionGateway.userMsg(session.symbol, session.exchange);

    try {
      await ctx.ticker.exchange(
        new RequestMarketDataUpdate({
          symbol: session.symbol,
          exchange: session.exchange,
          user_msg: [msg],
          request: SubscribeRequest.UNSUBSCRIBE,
          update_bits: MarketUpdatePreset.QUOTE,
        }),
      );
    } catch {
      /* ignore */
    }

    try {
      await ctx.history.exchange(
        new RequestTimeBarUpdate({
          symbol: session.symbol,
          exchange: session.exchange,
          user_msg: [msg],
          request: SubscribeRequest.UNSUBSCRIBE,
          bar_type: this.liveBarType ?? BarType.MINUTE_BAR,
          bar_type_period: this.liveBarPeriod ?? 1,
        }),
      );
    } catch {
      /* ignore */
    }

    this.live = false;
    this.liveBarType = null;
    this.liveBarPeriod = null;
    await Promise.allSettled(this.pumps);
    this.pumps = [];
  }

  async #pump(session, ctx, client, label) {
    while (this.live && client.ws?.readyState === 1) {
      let packet;
      try {
        packet = await client.receive();
      } catch {
        if (!this.live) break;
        continue;
      }
      this.dispatch(session, packet, label);
    }
  }

  dispatch(session, packet, plant) {
    if (packet instanceof LastTrade) {
      const partial = normalizeTrade(packet);
      this.trade = mergeTick(this.trade, partial);
      if (SessionGateway.hasBit(partial.presence_bits, LastTradePresence.LAST_TRADE)) {
        session.emit("trade", this.trade);
      }
      session.emit("status", this.status(session));
      return;
    }
    if (packet instanceof BestBidOffer) {
      const partial = normalizeQuote(packet);
      this.quote = mergeTick(this.quote, partial);
      if (
        SessionGateway.hasBit(partial.presence_bits, BestBidOfferPresence.BID) ||
        SessionGateway.hasBit(partial.presence_bits, BestBidOfferPresence.ASK)
      ) {
        session.emit("quote", this.quote);
      }
      session.emit("status", this.status(session));
      return;
    }
    if (packet instanceof TimeBar) {
      const bar = normalizeBar(packet, { defaultPeriod: DEFAULT_BAR_PERIOD });
      this.bar = bar;
      session.emit("bar", bar);
      session.emit("status", this.status(session));
      return;
    }
    if (packet instanceof HighPriceLowPrice) {
      this.latestHighLow = normalizeHighLow(packet);
      session.emit("latest_high_low", this.latestHighLow);
      session.emit("status", this.status(session));
      return;
    }
    if (packet instanceof ClosePrice) {
      this.latestClose = normalizeClosePrice(packet);
      session.emit("latest_close", this.latestClose);
      session.emit("status", this.status(session));
      return;
    }
    session.emit("message", { plant, packet });
  }
}
