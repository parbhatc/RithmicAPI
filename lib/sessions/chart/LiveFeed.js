import {
  RequestReferenceData,
  RequestMarketDataUpdate,
  RequestTimeBarUpdate,
  RequestTickBarUpdate,
  LastTrade,
  BestBidOffer,
  ClosePrice,
  HighPriceLowPrice,
  TimeBar,
  TickBar,
  OrderBook,
  MarketMode,
  DepthByOrder,
} from "../../../protocol/index.js";
import {
  BarType,
  TickBarType,
  TickBarSubType,
  SubscribeRequest,
  MarketUpdatePreset,
  LastTradePresence,
  BestBidOfferPresence,
} from "../../marketEnums.js";
import {
  normalizeBar,
  normalizeTickBar,
  normalizeTrade,
  normalizeQuote,
  normalizeClosePrice,
  normalizeHighLow,
  mergeTick,
  chartStatus,
} from "../../marketViews.js";
import { SessionGateway } from "./SessionGateway.js";

export class LiveFeed {
  live = false;
  pumps = [];
  trade = null;
  quote = null;
  bar = null;
  tickBar = null;
  orderBook = null;
  marketMode = null;
  latestHighLow = null;
  latestClose = null;
  liveBarType = null;
  liveBarPeriod = null;
  liveTickBarType = null;
  liveTickBarSubType = null;
  liveTickBarPeriod = null;
  #historyPumpPaused = false;

  /** Pause history live pump so RequestTimeBarReplay can read responses. */
  pauseHistoryPump(client) {
    this.#historyPumpPaused = true;
    client?.releaseReceiveWaiters?.();
  }

  resumeHistoryPump() {
    this.#historyPumpPaused = false;
  }

  get historyPumpPaused() {
    return this.#historyPumpPaused;
  }

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
    if (this.live) {
      const wsOk =
        ctx.ticker.ws?.readyState === 1 && ctx.history.ws?.readyState === 1;
      if (wsOk && this.pumps.length >= 2) return;
      await this.stop(session, ctx);
    }
    const {
      updateBits = MarketUpdatePreset.QUOTE,
      referenceData = true,
      priceType = "final",
      referenceMode = "auto",
      barType = BarType.MINUTE_BAR,
      barPeriod = 1,
      tickBar = null,
    } = options;

    const msg = SessionGateway.userMsg(session.symbol, session.exchange);
    this.liveBarType = barType;
    this.liveBarPeriod = barPeriod;

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
        bar_type: barType,
        bar_type_period: barPeriod,
      }),
    );

    if (tickBar) {
      this.liveTickBarType = tickBar.barType ?? TickBarType.TICK_BAR;
      this.liveTickBarSubType = tickBar.barSubType ?? TickBarSubType.REGULAR;
      this.liveTickBarPeriod = tickBar.barPeriod ?? 100;
      await ctx.history.exchange(
        new RequestTickBarUpdate({
          symbol: session.symbol,
          exchange: session.exchange,
          user_msg: [msg],
          request: SubscribeRequest.SUBSCRIBE,
          bar_type: this.liveTickBarType,
          bar_type_period: this.liveTickBarPeriod,
          bar_sub_type: this.liveTickBarSubType,
          custom_session_open_ssboe: tickBar.customSessionOpenSsboe ?? 0,
          custom_session_close_ssboe: tickBar.customSessionCloseSsboe ?? 0,
        }),
      );
    }

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

    if (this.liveTickBarType != null) {
      try {
        await ctx.history.exchange(
          new RequestTickBarUpdate({
            symbol: session.symbol,
            exchange: session.exchange,
            user_msg: [msg],
            request: SubscribeRequest.UNSUBSCRIBE,
            bar_type: this.liveTickBarType,
            bar_type_period: this.liveTickBarPeriod ?? 100,
            bar_sub_type: this.liveTickBarSubType ?? TickBarSubType.REGULAR,
          }),
        );
      } catch {
        /* ignore */
      }
    }

    this.live = false;
    this.liveBarType = null;
    this.liveBarPeriod = null;
    this.liveTickBarType = null;
    this.liveTickBarSubType = null;
    this.liveTickBarPeriod = null;
    await Promise.allSettled(this.pumps);
    this.pumps = [];
  }

  async #pump(session, ctx, client, label) {
    while (this.live && client.ws?.readyState === 1) {
      if (label === "history" && this.#historyPumpPaused) {
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      let packet;
      try {
        packet = await client.receive();
      } catch (err) {
        if (err instanceof Error && err.name === "ReceiveYield") continue;
        if (!this.live) break;
        session.emit("liveReceiveError", { plant: label, error: err });
        continue;
      }
      this.dispatch(session, packet, label);
    }
    if (this.live) {
      session.emit("liveStall", {
        plant: label,
        readyState: client.ws?.readyState ?? -1,
      });
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
      const bar = normalizeBar(packet, { defaultPeriod: this.liveBarPeriod ?? 1 });
      this.bar = bar;
      session.emit("bar", bar);
      session.emit("status", this.status(session));
      return;
    }
    if (packet instanceof TickBar) {
      const bar = normalizeTickBar(packet);
      this.tickBar = bar;
      session.emit("tickBar", bar);
      session.emit("status", this.status(session));
      return;
    }
    if (packet instanceof OrderBook) {
      this.orderBook = packet.toObject();
      session.emit("orderBook", this.orderBook);
      session.emit("status", this.status(session));
      return;
    }
    if (packet instanceof MarketMode) {
      this.marketMode = packet.toObject();
      session.emit("marketMode", this.marketMode);
      session.emit("status", this.status(session));
      return;
    }
    if (packet instanceof DepthByOrder) {
      session.emit("depthByOrder", packet.toObject());
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
