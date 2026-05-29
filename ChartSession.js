import { EventEmitter } from "node:events";
import { connect, discover } from "./init.js";
import { InfraType } from "./protocol/RequestLogin.js";
import {
  RequestLogin,
  RequestLoginInfo,
  RequestHeartbeat,
  RequestMarketDataUpdate,
  RequestReferenceData,
  RequestTimeBarReplay,
  RequestTimeBarUpdate,
  ResponseTimeBarReplay,
  LastTrade,
  BestBidOffer,
  ClosePrice,
  HighPriceLowPrice,
  TimeBar,
} from "./protocol/index.js";
import {
  BarType,
  ReplayDirection,
  ReplayTimeOrder,
  SubscribeRequest,
  MarketUpdatePreset,
  LastTradePresence,
  BestBidOfferPresence,
} from "./lib/market-enums.js";
import {
  normalizeBar,
  normalizeTrade,
  normalizeQuote,
  normalizeClosePrice,
  normalizeHighLow,
  mergeTick,
  chartStatus,
} from "./lib/market-views.js";
import { resolveHistoryQuery, barsToHistoryPayload } from "./lib/history-query.js";

const WEB_APP = {
  template_version: "2.0",
  app_name: "Rithmic Trader Pro - Web",
  app_version: "2.8.0.0",
};

function userMsg(symbol, exchange) {
  return `${symbol}.${exchange}`;
}

function hasBit(bits, flag) {
  return ((bits ?? 0) & flag) !== 0;
}

async function resolveGatewayUri({ systemName, uri, gatewayName }) {
  if (uri) return uri;
  const { gateways } = await discover(systemName);
  if (gatewayName) {
    const match = gateways.find((g) => g.name.includes(gatewayName));
    if (match) return match.uri;
  }
  const chicago = gateways.find((g) => /chicago/i.test(g.name));
  return (chicago ?? gateways[0]).uri;
}

async function loginPlant(client, credentials, infraType) {
  const login = await client.exchange(
    new RequestLogin({
      user: credentials.user,
      password: credentials.password,
      system_name: credentials.systemName,
      infra_type: infraType,
      user_msg: ["new"],
      ...WEB_APP,
    }),
  );
  if (!login.ok) {
    throw new Error(`${client.label} login failed: ${login.rp_code?.join(", ")}`);
  }
  await client.exchange(new RequestLoginInfo(login.unique_user_id));
  return login;
}

/**
 * Live + historical chart session (ticker plant + history plant).
 *
 * Emits:
 * - `trade` — LastTrade (150)
 * - `quote` — BestBidOffer (151)
 * - `latest_high_low` — HighPriceLowPrice (152)
 * - `latest_close` — ClosePrice (155)
 * - `bar` — TimeBar (250)
 * - `status` — merged last/bid/ask/bar snapshot
 * - `message` — any other decoded packet (debug)
 */
export class ChartSession extends EventEmitter {
  #ticker = null;
  #history = null;
  #live = false;
  #pumps = [];
  #heartbeatTimer = null;
  #trade = null;
  #quote = null;
  #bar = null;
  #latestHighLow = null;
  #latestClose = null;

  constructor() {
    super();
    this.symbol = null;
    this.exchange = null;
    this.uri = null;
  }

  /** Latest merged status for chart headers. */
  get status() {
    return chartStatus({
      symbol: this.symbol,
      exchange: this.exchange,
      trade: this.#trade,
      quote: this.#quote,
      bar: this.#bar,
      latestHighLow: this.#latestHighLow,
      latestClose: this.#latestClose,
    });
  }

  /**
   * Connect ticker + history plants on a regional gateway.
   *
   * @param {object} options
   * @param {string} options.user
   * @param {string} options.password
   * @param {string} options.systemName
   * @param {string} options.symbol
   * @param {string} options.exchange
   * @param {string} [options.uri] Gateway WebSocket URL (from `discover()`)
   * @param {string} [options.gatewayName] Pick gateway by name substring
   * @param {boolean} [options.heartbeat=true] Send periodic heartbeats while live
   */
  static async open(options) {
    const session = new ChartSession();
    await session.connect(options);
    return session;
  }

  async connect({ user, password, systemName, symbol, exchange, uri, gatewayName, heartbeat = true }) {
    if (!user || !password) throw new Error("user and password are required");
    if (!systemName || !symbol || !exchange) {
      throw new Error("systemName, symbol, and exchange are required");
    }

    this.symbol = symbol;
    this.exchange = exchange;
    this.uri = await resolveGatewayUri({ systemName, uri, gatewayName });

    const credentials = { user, password, systemName };

    this.#ticker = await connect({ uri: this.uri, label: "ticker", log: false });
    this.#history = await connect({ uri: this.uri, label: "history", log: false });

    await loginPlant(this.#ticker, credentials, InfraType.TICKER_PLANT);
    await loginPlant(this.#history, credentials, InfraType.HISTORY_PLANT);

    if (heartbeat) {
      this.#heartbeatTimer = setInterval(() => {
        const ts = String(Math.floor(Date.now() / 1000));
        try {
          if (this.#ticker?.ws?.readyState === 1) {
            this.#ticker.send(new RequestHeartbeat({ user_msg: [ts] }));
          }
          if (this.#history?.ws?.readyState === 1) {
            this.#history.send(new RequestHeartbeat({ user_msg: [ts] }));
          }
        } catch {
          /* connection closing */
        }
      }, 25_000);
      this.#heartbeatTimer.unref?.();
    }
  }

  /**
   * Replay historical OHLC bars (history plant, template 202 → 203).
   *
   * TradingView-style: `resolution`, `from`, `to`, `countback`
   * (e.g. `resolution=1&from=1779788481&to=1779929351&countback=300`).
   *
   * Legacy: `barCount`, `period`, `start_index`, `finish_index`, `barType`.
   *
   * @param {object} [options]
   * @param {number|string} [options.resolution=1] Bar size in minutes, or `"1D"` / `"1W"`
   * @param {number} [options.from] Range start (Unix s) → `start_index`
   * @param {number} [options.to] Range end (Unix s) → `finish_index`
   * @param {number} [options.countback] Bar count when `from` omitted
   * @param {number} [options.timeoutMs=120000]
   * @param {boolean} [options.payload=false] If true, return `{ s, t, o, h, l, c, v }`
   * @param {number} [options.timeOffset=0] Seconds added to each `t` in payload mode
   * @param {boolean} [options.compat=false] Shift OHLCV by one bar for compatibility mode
   * @returns {Promise<object[]|{ s: string, t: number[], o: number[], h: number[], l: number[], c: number[], v: number[] }>}
   */
  async loadHistory(options = {}) {
    const {
      timeoutMs = 120_000,
      payload = false,
      timeOffset = 0,
      compat = false,
      ...queryOpts
    } = options;
    const q = resolveHistoryQuery(queryOpts);
    const msg = userMsg(this.symbol, this.exchange);
    const replayRange = async (start_index, finish_index) => {
      this.#history.send(
        new RequestTimeBarReplay({
          symbol: this.symbol,
          exchange: this.exchange,
          user_msg: [msg],
          bar_type: q.barType,
          bar_type_period: q.barTypePeriod,
          start_index,
          finish_index,
          direction: ReplayDirection.LAST,
          time_order: ReplayTimeOrder.FORWARDS,
        }),
      );

      const out = [];
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const packet = await this.#history.receive();
        if (!(packet instanceof ResponseTimeBarReplay)) continue;

        const marker = Number(packet.marker ?? 0);
        const isBar =
          marker !== 0 &&
          (packet.open_price != null || packet.close_price != null);

        if (isBar) out.push(normalizeBar(packet, { defaultPeriod: q.periodSeconds }));
        if (packet.rp_code?.[0] === "0" && !isBar) break;
      }
      return out;
    };

    let bars = await replayRange(q.start_index, q.finish_index);

    const targetCount =
      q.countback == null
        ? null
        : q.countback + (payload && compat ? 1 : 0);

    // If caller asked for countback and the explicit range is too short, backfill older bars.
    if (targetCount != null && bars.length > 0 && bars.length < targetCount) {
      let loops = 0;
      while (bars.length < targetCount && loops < 8) {
        loops++;
        const firstMarker = Number(bars[0]?.marker ?? q.start_index);
        const needed = targetCount - bars.length;
        const span = Math.max(needed * q.periodSeconds * 2, q.periodSeconds * 120);
        const extraStart = Math.floor(firstMarker - span);
        const extraEnd = Math.floor(firstMarker - q.periodSeconds);
        if (extraEnd <= extraStart) break;

        const older = await replayRange(extraStart, extraEnd);
        if (!older.length) break;

        const seen = new Set(bars.map((b) => Number(b.marker)));
        const uniqueOlder = older.filter((b) => !seen.has(Number(b.marker)));
        if (!uniqueOlder.length) break;

        bars = [...uniqueOlder, ...bars];
      }

      if (bars.length > targetCount) {
        bars = bars.slice(-targetCount);
      }
    }

    if (payload) return barsToHistoryPayload(bars, { timeOffset, compat });
    return bars;
  }

  /**
   * Subscribe to live last trade, bid/ask, and forming bars.
   * Starts background readers; emits `trade`, `quote`, `bar`, `status`.
   *
   * @param {object} [options]
   * @param {number} [options.updateBits=MarketUpdatePreset.QUOTE]
   * @param {boolean} [options.referenceData=true] Send RequestReferenceData before subscribe (web app does this)
   * @param {string} [options.priceType='final'] Reference data price type (`user_msg[1]`)
   * @param {string} [options.referenceMode='auto'] Reference data mode (`user_msg[2]`)
   * @param {number} [options.barType=BarType.MINUTE_BAR]
   * @param {number} [options.barPeriod=1]
   */
  async startLive({
    updateBits = MarketUpdatePreset.QUOTE,
    referenceData = true,
    priceType = "final",
    referenceMode = "auto",
    barType = BarType.MINUTE_BAR,
    barPeriod = 1,
  } = {}) {
    if (this.#live) return;
    const msg = userMsg(this.symbol, this.exchange);

    if (referenceData) {
      await this.#ticker.exchange(
        new RequestReferenceData({
          symbol: this.symbol,
          exchange: this.exchange,
          user_msg: [msg, priceType, referenceMode],
        }),
      );
    }

    await this.#ticker.exchange(
      new RequestMarketDataUpdate({
        symbol: this.symbol,
        exchange: this.exchange,
        user_msg: [msg],
        request: SubscribeRequest.SUBSCRIBE,
        update_bits: updateBits,
      }),
    );

    await this.#history.exchange(
      new RequestTimeBarUpdate({
        symbol: this.symbol,
        exchange: this.exchange,
        user_msg: [msg],
        request: SubscribeRequest.SUBSCRIBE,
        bar_type: barType,
        bar_type_period: barPeriod,
      }),
    );

    // Snapshots (152/155) often arrive right after subscribe, before the pump loop runs.
    const early = await this.#ticker.drain({ idleMs: 400, max: 30 });
    for (const packet of early) {
      this.#dispatch(packet, "ticker");
    }

    this.#live = true;
    this.#pumps.push(this.#pump(this.#ticker, "ticker"), this.#pump(this.#history, "history"));
  }

  /** Unsubscribe live feeds and stop background readers. */
  async stopLive() {
    if (!this.#live) return;
    const msg = userMsg(this.symbol, this.exchange);

    try {
      await this.#ticker.exchange(
        new RequestMarketDataUpdate({
          symbol: this.symbol,
          exchange: this.exchange,
          user_msg: [msg],
          request: SubscribeRequest.UNSUBSCRIBE,
          update_bits: MarketUpdatePreset.QUOTE,
        }),
      );
    } catch {
      /* ignore */
    }

    try {
      await this.#history.exchange(
        new RequestTimeBarUpdate({
          symbol: this.symbol,
          exchange: this.exchange,
          user_msg: [msg],
          request: SubscribeRequest.UNSUBSCRIBE,
          bar_type: BarType.MINUTE_BAR,
          bar_type_period: 1,
        }),
      );
    } catch {
      /* ignore */
    }

    this.#live = false;
    await Promise.allSettled(this.#pumps);
    this.#pumps = [];
  }

  async #pump(client, label) {
    while (this.#live && client.ws?.readyState === 1) {
      let packet;
      try {
        packet = await client.receive();
      } catch {
        if (!this.#live) break;
        continue;
      }
      this.#dispatch(packet, label);
    }
  }

  #dispatch(packet, plant) {
    if (packet instanceof LastTrade) {
      const partial = normalizeTrade(packet);
      this.#trade = mergeTick(this.#trade, partial);
      if (hasBit(partial.presence_bits, LastTradePresence.LAST_TRADE)) {
        this.emit("trade", this.#trade);
      }
      this.emit("status", this.status);
      return;
    }
    if (packet instanceof BestBidOffer) {
      const partial = normalizeQuote(packet);
      this.#quote = mergeTick(this.#quote, partial);
      if (
        hasBit(partial.presence_bits, BestBidOfferPresence.BID) ||
        hasBit(partial.presence_bits, BestBidOfferPresence.ASK)
      ) {
        this.emit("quote", this.#quote);
      }
      this.emit("status", this.status);
      return;
    }
    if (packet instanceof TimeBar) {
      this.#bar = normalizeBar(packet);
      this.emit("bar", this.#bar);
      this.emit("status", this.status);
      return;
    }
    if (packet instanceof HighPriceLowPrice) {
      this.#latestHighLow = normalizeHighLow(packet);
      this.emit("latest_high_low", this.#latestHighLow);
      this.emit("status", this.status);
      return;
    }
    if (packet instanceof ClosePrice) {
      this.#latestClose = normalizeClosePrice(packet);
      this.emit("latest_close", this.#latestClose);
      this.emit("status", this.status);
      return;
    }
    this.emit("message", { plant, packet });
  }

  close() {
    this.#live = false;
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    this.#ticker?.close();
    this.#history?.close();
    this.#ticker = null;
    this.#history = null;
  }
}

/**
 * One-shot historical bar fetch (opens history plant, replays, closes).
 *
 * @param {object} options — connect fields + history query:
 *   `resolution`, `from`, `to`, `countback` (or legacy `barCount` / `start_index` / `finish_index`)
 * @param {boolean} [options.payload=false] Return `{ s, t, o, h, l, c, v }` instead of bar objects
 * @returns {Promise<object[]|{ s: string, t: number[], o: number[], h: number[], l: number[], c: number[], v: number[] }>}
 */
export async function fetchHistoryBars(options) {
  const {
    resolution,
    from,
    to,
    countback,
    barCount,
    period,
    barType,
    barTypePeriod,
    start_index,
    finish_index,
    timeoutMs,
    payload,
    timeOffset,
    compat,
    ...connectOpts
  } = options;

  const session = await ChartSession.open(connectOpts);
  try {
    return await session.loadHistory({
      resolution,
      from,
      to,
      countback,
      barCount,
      period,
      barType,
      barTypePeriod,
      start_index,
      finish_index,
      timeoutMs,
      payload,
      timeOffset,
      compat,
    });
  } finally {
    session.close();
  }
}

/** Alias for `fetchHistoryBars` with `payload: true`. */
export async function fetchHistory(options) {
  return fetchHistoryBars({
    ...options,
    payload: true,
    compat: options?.compat ?? true,
  });
}
