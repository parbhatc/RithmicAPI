import {
  RequestReferenceData,
  RequestSubscribeForUnderlying,
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
  ForcedLogout,
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

/** Idle window for streaming pumps — silence is normal, not a socket failure. */
const PUMP_IDLE_MS = 120_000;
/** Yield to the event loop every N dispatches when catching up on a backlog. */
const PUMP_YIELD_EVERY = 32;

const RECEIVE_TIMEOUT = /timed out waiting for response/i;

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
  /** @type {{ symbol: string, exchange: string, barType: number, barPeriod: number, periodSeconds: number }[]} */
  #instruments = [];
  /** @type {Map<string, number>} */
  #barPeriodByKey = new Map();
  /** @type {Map<string, object>} */
  #tradesByKey = new Map();
  /** @type {Map<string, object>} */
  #quotesByKey = new Map();
  #subscribedUpdateBits = MarketUpdatePreset.QUOTE;
  #historyPumpPaused = false;
  #tickerPumpPaused = false;
  #historyReplayDepth = 0;

  /** Pause history live pump so RequestTimeBarReplay can read responses. */
  pauseHistoryPump(client) {
    this.#historyPumpPaused = true;
    client?.releaseReceiveWaiters?.();
  }

  beginHistoryReplay(depth = 1) {
    this.#historyReplayDepth += depth;
  }

  endHistoryReplay(depth = 1) {
    this.#historyReplayDepth = Math.max(0, this.#historyReplayDepth - depth);
  }

  resumeHistoryPump() {
    if (this.#historyReplayDepth > 0) return;
    this.#historyPumpPaused = false;
  }

  get historyPumpPaused() {
    return this.#historyPumpPaused;
  }

  /** Per-symbol merged last trade (multi-instrument sessions). */
  tradeFor(symbol, exchange) {
    if (!symbol || !exchange) return null;
    return this.#tradesByKey.get(SessionGateway.userMsg(symbol, exchange)) ?? null;
  }

  /** Pause ticker/history pumps so request/response pairs can own the sockets. */
  async #withWirePlants(ctx, fn) {
    this.#tickerPumpPaused = true;
    this.#historyPumpPaused = true;
    ctx.ticker?.releaseReceiveWaiters?.();
    ctx.history?.releaseReceiveWaiters?.();
    try {
      return await fn();
    } finally {
      this.#historyPumpPaused = false;
      this.#tickerPumpPaused = false;
    }
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

  /** Root + trading-month reference data (Rithmic Trader Pro pattern). */
  async #fetchReferenceData(ctx, { symbol, exchange }, priceType, referenceMode) {
    const msg = SessionGateway.userMsg(symbol, exchange);
    const resp = await ctx.ticker.exchange(
      new RequestReferenceData({
        symbol,
        exchange,
        user_msg: [msg, priceType, referenceMode],
      }),
    );
    const tradingSymbol = resp?.trading_symbol?.[0] ?? resp?.trading_symbol;
    const tradingExchange =
      resp?.trading_exchange?.[0] ?? resp?.trading_exchange ?? exchange;
    if (tradingSymbol && tradingSymbol !== symbol) {
      await ctx.ticker.exchange(
        new RequestReferenceData({
          symbol: tradingSymbol,
          exchange: tradingExchange,
          user_msg: [msg, priceType, "update_underlying", msg],
        }),
      );
    }
    return resp;
  }

  /**
   * Unsubscribe an old time-bar stream and subscribe to a new bar type/period on the same symbol.
   */
  async #wireInstrument(ctx, sub, { updateBits, referenceData, priceType, referenceMode }) {
    const msg = SessionGateway.userMsg(sub.symbol, sub.exchange);

    if (referenceData) {
      await this.#fetchReferenceData(ctx, sub, priceType, referenceMode);
    }

    await ctx.ticker.exchange(
      new RequestMarketDataUpdate({
        symbol: sub.symbol,
        exchange: sub.exchange,
        user_msg: [msg],
        request: SubscribeRequest.SUBSCRIBE,
        update_bits: updateBits,
      }),
    );

    await ctx.history.exchange(
      new RequestTimeBarUpdate({
        symbol: sub.symbol,
        exchange: sub.exchange,
        user_msg: [msg],
        request: SubscribeRequest.SUBSCRIBE,
        bar_type: sub.barType,
        bar_type_period: sub.barPeriod,
      }),
    );

    const key = msg;
    const periodSeconds =
      sub.periodSeconds ?? sub.barPeriod * (sub.barType === BarType.SECOND_BAR ? 1 : 60);
    const idx = this.#instruments.findIndex(
      (s) => s.symbol === sub.symbol && s.exchange === sub.exchange,
    );
    const entry = { ...sub, periodSeconds };
    if (idx >= 0) this.#instruments[idx] = entry;
    else this.#instruments.push(entry);
    this.#barPeriodByKey.set(key, periodSeconds);
    if (this.#instruments.length === 1) {
      this.liveBarType = sub.barType;
      this.liveBarPeriod = sub.barPeriod;
    }
  }

  async #unwireInstrument(ctx, sub) {
    const msg = SessionGateway.userMsg(sub.symbol, sub.exchange);
    try {
      await ctx.ticker.exchange(
        new RequestMarketDataUpdate({
          symbol: sub.symbol,
          exchange: sub.exchange,
          user_msg: [msg],
          request: SubscribeRequest.UNSUBSCRIBE,
          update_bits: this.#subscribedUpdateBits,
        }),
      );
    } catch {
      /* ignore */
    }
    try {
      await ctx.history.exchange(
        new RequestTimeBarUpdate({
          symbol: sub.symbol,
          exchange: sub.exchange,
          user_msg: [msg],
          request: SubscribeRequest.UNSUBSCRIBE,
          bar_type: sub.barType,
          bar_type_period: sub.barPeriod,
        }),
      );
    } catch {
      /* ignore */
    }
    const key = msg;
    this.#instruments = this.#instruments.filter(
      (s) => !(s.symbol === sub.symbol && s.exchange === sub.exchange),
    );
    this.#barPeriodByKey.delete(key);
    this.#tradesByKey.delete(key);
    this.#quotesByKey.delete(key);
    const primary = this.#instruments[0];
    this.liveBarType = primary?.barType ?? null;
    this.liveBarPeriod = primary?.barPeriod ?? null;
  }

  /** Subscribe one symbol while pumps are already running. */
  async subscribeInstrument(
    session,
    ctx,
    sub,
    {
      updateBits = this.#subscribedUpdateBits,
      referenceData = false,
      priceType = "final",
      referenceMode = "auto",
      subscribeUnderlying = false,
    } = {},
  ) {
    if (!this.live) throw new Error("live feed is not running");
    const exists = this.#instruments.some(
      (s) => s.symbol === sub.symbol && s.exchange === sub.exchange,
    );
    if (exists) throw new Error(`already subscribed: ${sub.symbol}.${sub.exchange}`);

    await this.#withWirePlants(ctx, async () => {
      if (subscribeUnderlying) {
        const msg = SessionGateway.userMsg(sub.symbol, sub.exchange);
        await ctx.ticker.exchange(
          new RequestSubscribeForUnderlying({
            symbol: sub.symbol,
            exchange: sub.exchange,
            user_msg: [msg],
            update_bits: updateBits,
          }),
        );
      }

      await this.#wireInstrument(ctx, sub, {
        updateBits,
        referenceData,
        priceType,
        referenceMode,
      });
    });

    const earlyTicker = await ctx.ticker.drain({ idleMs: 200, max: 20 });
    for (const packet of earlyTicker) this.dispatch(session, packet, "ticker");
    const earlyHistory = await ctx.history.drain({ idleMs: 200, max: 20 });
    for (const packet of earlyHistory) this.dispatch(session, packet, "history");
  }

  /** Unsubscribe one symbol while pumps keep running for other symbols. */
  async unsubscribeInstrument(session, ctx, sub) {
    const exists = this.#instruments.some(
      (s) => s.symbol === sub.symbol && s.exchange === sub.exchange,
    );
    if (!exists) throw new Error(`not subscribed: ${sub.symbol}.${sub.exchange}`);
    await this.#withWirePlants(ctx, () => this.#unwireInstrument(ctx, sub));
  }

  /** Run ticker/history wire work while live pumps are paused. */
  runWireTask(ctx, fn) {
    return this.#withWirePlants(ctx, fn);
  }

  /** Unsubscribe live time bars only (keeps market-data subscription). */
  async unsubscribeTimeBar(ctx, { symbol, exchange, barType, barPeriod }) {
    const msg = SessionGateway.userMsg(symbol, exchange);
    await ctx.history.exchange(
      new RequestTimeBarUpdate({
        symbol,
        exchange,
        user_msg: [msg],
        request: SubscribeRequest.UNSUBSCRIBE,
        bar_type: barType,
        bar_type_period: barPeriod,
      }),
    );
  }

  /** Subscribe live time bars and update the instrument registry. */
  async subscribeTimeBar(ctx, sub) {
    const msg = SessionGateway.userMsg(sub.symbol, sub.exchange);
    await ctx.history.exchange(
      new RequestTimeBarUpdate({
        symbol: sub.symbol,
        exchange: sub.exchange,
        user_msg: [msg],
        request: SubscribeRequest.SUBSCRIBE,
        bar_type: sub.barType,
        bar_type_period: sub.barPeriod,
      }),
    );
    const key = msg;
    const periodSeconds =
      sub.periodSeconds ?? sub.barPeriod * (sub.barType === BarType.SECOND_BAR ? 1 : 60);
    const idx = this.#instruments.findIndex(
      (s) => s.symbol === sub.symbol && s.exchange === sub.exchange,
    );
    const entry = { ...sub, periodSeconds };
    if (idx >= 0) this.#instruments[idx] = entry;
    else this.#instruments.push(entry);
    this.#barPeriodByKey.set(key, periodSeconds);
  }

  /**
   * Unsubscribe an old time-bar stream and subscribe to a new bar type/period on the same symbol.
   * For history replay between unsub/sub (Trader Pro chart switch), use
   * {@link unsubscribeTimeBar} → replay/bootstrap → {@link subscribeTimeBar}.
   */
  async changeTimeBarSubscription(
    ctx,
    { symbol, exchange, barType, barPeriod, periodSeconds },
    previous,
  ) {
    if (previous) {
      await this.unsubscribeTimeBar(ctx, {
        symbol,
        exchange,
        barType: previous.barType,
        barPeriod: previous.barPeriod,
      });
    }
    await this.subscribeTimeBar(ctx, {
      symbol,
      exchange,
      barType,
      barPeriod,
      periodSeconds,
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
      instruments = null,
      subscribeUnderlying = (instruments?.length ?? 0) > 1,
    } = options;

    this.#subscribedUpdateBits = updateBits;

    const subs =
      instruments != null
        ? instruments
        : [
            {
              symbol: session.symbol,
              exchange: session.exchange,
              barType,
              barPeriod,
              periodSeconds: barPeriod * (barType === BarType.SECOND_BAR ? 1 : 60),
            },
          ];

    this.#instruments = [];
    this.#barPeriodByKey = new Map();
    this.#tradesByKey = new Map();
    this.#quotesByKey = new Map();

    if (
      ctx.ticker?.ws?.readyState !== 1 ||
      ctx.history?.ws?.readyState !== 1
    ) {
      throw new Error("live plants not connected");
    }

    if (subscribeUnderlying && subs.length > 0) {
      const first = subs[0];
      const msg = SessionGateway.userMsg(first.symbol, first.exchange);
      await ctx.ticker.exchange(
        new RequestSubscribeForUnderlying({
          symbol: first.symbol,
          exchange: first.exchange,
          user_msg: [msg],
          update_bits: updateBits,
        }),
      );
    }

    for (const sub of subs) {
      await this.#wireInstrument(ctx, sub, {
        updateBits,
        referenceData,
        priceType,
        referenceMode,
      });
    }

    if (tickBar) {
      const msg = SessionGateway.userMsg(session.symbol, session.exchange);
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
    const subs = [...this.#instruments];
    for (const sub of subs) {
      try {
        await this.#unwireInstrument(ctx, sub);
      } catch {
        /* ignore */
      }
    }

    if (this.liveTickBarType != null) {
      const msg = SessionGateway.userMsg(session.symbol, session.exchange);
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
    this.#instruments = [];
    this.#barPeriodByKey = new Map();
    this.#tradesByKey = new Map();
    this.#quotesByKey = new Map();
    await Promise.allSettled(this.pumps);
    this.pumps = [];
  }

  /** Next live packet, or null when the stream is idle past {@link PUMP_IDLE_MS}. */
  async #pumpReceive(client) {
    const saved = client.timeoutMs;
    client.timeoutMs = Math.max(saved, PUMP_IDLE_MS);
    try {
      return await client.receive();
    } catch (err) {
      if (err instanceof Error && err.name === "ReceiveYield") throw err;
      if (RECEIVE_TIMEOUT.test(String(err?.message ?? err))) return null;
      throw err;
    } finally {
      client.timeoutMs = saved;
    }
  }

  async #pump(session, ctx, client, label) {
    let dispatched = 0;
    while (this.live && client.ws?.readyState === 1) {
      if (
        (label === "history" && this.#historyPumpPaused) ||
        (label === "ticker" && this.#tickerPumpPaused)
      ) {
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      let packet;
      try {
        packet = await this.#pumpReceive(client);
        if (packet === null) continue;
      } catch (err) {
        if (err instanceof Error && err.name === "ReceiveYield") continue;
        if (!this.live) break;
        session.emit("liveReceiveError", { plant: label, error: err });
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      this.dispatch(session, packet, label);
      if (++dispatched % PUMP_YIELD_EVERY === 0) {
        await new Promise((r) => setImmediate(r));
      }
    }
    if (this.live) {
      session.emit("liveStall", {
        plant: label,
        readyState: client.ws?.readyState ?? -1,
      });
    }
  }

  dispatch(session, packet, plant) {
    if (packet instanceof ForcedLogout) {
      session.emit("sessionKicked", { plant });
      return;
    }
    if (packet instanceof LastTrade) {
      const partial = normalizeTrade(packet);
      const sym = partial.symbol;
      const exch = partial.exchange;
      if (sym && exch) {
        const key = SessionGateway.userMsg(sym, exch);
        this.#tradesByKey.set(key, mergeTick(this.#tradesByKey.get(key), partial));
        if (SessionGateway.hasBit(partial.presence_bits, LastTradePresence.LAST_TRADE)) {
          session.emit("trade", { ...this.#tradesByKey.get(key), symbol: sym, exchange: exch });
        }
        if (sym === session.symbol && exch === session.exchange) {
          this.trade = this.#tradesByKey.get(key);
        }
      } else {
        this.trade = mergeTick(this.trade, partial);
        if (SessionGateway.hasBit(partial.presence_bits, LastTradePresence.LAST_TRADE)) {
          session.emit("trade", this.trade);
        }
      }
      session.emit("status", this.status(session));
      return;
    }
    if (packet instanceof BestBidOffer) {
      const partial = normalizeQuote(packet);
      const sym = partial.symbol;
      const exch = partial.exchange;
      if (sym && exch) {
        const key = SessionGateway.userMsg(sym, exch);
        this.#quotesByKey.set(key, mergeTick(this.#quotesByKey.get(key), partial));
        if (
          SessionGateway.hasBit(partial.presence_bits, BestBidOfferPresence.BID) ||
          SessionGateway.hasBit(partial.presence_bits, BestBidOfferPresence.ASK)
        ) {
          session.emit("quote", { ...this.#quotesByKey.get(key), symbol: sym, exchange: exch });
        }
        if (sym === session.symbol && exch === session.exchange) {
          this.quote = this.#quotesByKey.get(key);
        }
      } else {
        this.quote = mergeTick(this.quote, partial);
        if (
          SessionGateway.hasBit(partial.presence_bits, BestBidOfferPresence.BID) ||
          SessionGateway.hasBit(partial.presence_bits, BestBidOfferPresence.ASK)
        ) {
          session.emit("quote", this.quote);
        }
      }
      session.emit("status", this.status(session));
      return;
    }
    if (packet instanceof TimeBar) {
      const obj = typeof packet.toObject === "function" ? packet.toObject() : {};
      const key =
        obj.symbol && obj.exchange
          ? SessionGateway.userMsg(obj.symbol, obj.exchange)
          : null;
      const defaultPeriod =
        (key && this.#barPeriodByKey.get(key)) ?? this.liveBarPeriod ?? 1;
      const bar = normalizeBar(packet, { defaultPeriod });
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
