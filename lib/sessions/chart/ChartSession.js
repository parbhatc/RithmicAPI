import { EventEmitter } from "node:events";
import { RequestHeartbeat } from "../../../protocol/index.js";
import { SessionGateway } from "./SessionGateway.js";
import { LiveFeed } from "./LiveFeed.js";
import { Planets } from "./planets/Planets.js";
import { DEFAULT_PLANTS } from "./plantDefaults.js";
import { resolveLog } from "../../util.js";

/**
 * Multi-plant chart session.
 *
 * ```js
 * const chart = await ChartSession.open({
 *   user, password, systemName, symbol, exchange,
 *   plants: { ticker: true, history: true, order: true, pnl: true },
 * });
 * await chart.planets.history.load({ countback: 300 });
 * ```
 */
export class ChartSession extends EventEmitter {
  #ticker = null;
  #history = null;
  #order = null;
  #pnl = null;
  #heartbeatTimer = null;
  #live = new LiveFeed();
  #planets = null;
  #plantFlags = { ...DEFAULT_PLANTS };
  log = false;

  constructor() {
    super();
    this.symbol = null;
    this.exchange = null;
    this.uri = null;
  }

  get planets() {
    return (this.#planets ??= new Planets(this));
  }

  get liveFeed() {
    return this.#live;
  }

  get tickerClient() {
    return this.#ticker;
  }

  get historyClient() {
    return this.#history;
  }

  get orderClient() {
    return this.#order;
  }

  get pnlClient() {
    return this.#pnl;
  }

  ctx(overrides = {}) {
    return {
      ticker: this.#ticker,
      history: this.#history,
      symbol: overrides.symbol ?? this.symbol,
      exchange: overrides.exchange ?? this.exchange,
      log: this.log,
    };
  }

  get status() {
    return this.#live.status(this);
  }

  static async open(options) {
    const session = new ChartSession();
    await session.connect(options);
    return session;
  }

  async connect({
    user,
    password,
    systemName,
    symbol,
    exchange,
    uri,
    gatewayName,
    heartbeat = true,
    plants,
    log,
  }) {
    if (!user || !password) throw new Error("user and password are required");
    if (!systemName) throw new Error("systemName is required");

    this.log = resolveLog(log);

    if (symbol) this.symbol = symbol;
    if (exchange) this.exchange = exchange;

    const opened = await SessionGateway.openPlants({
      user,
      password,
      systemName,
      uri,
      gatewayName,
      plants,
      log: this.log,
    });

    this.#plantFlags = opened.plants;
    this.#ticker = opened.ticker ?? null;
    this.#history = opened.history ?? null;
    this.#order = opened.order ?? null;
    this.#pnl = opened.pnl ?? null;
    this.uri = opened.uri;

    if (heartbeat) {
      this.#heartbeatTimer = setInterval(() => {
        const ts = String(Math.floor(Date.now() / 1000));
        for (const client of [this.#ticker, this.#history, this.#order, this.#pnl]) {
          try {
            if (client?.ws?.readyState === 1) {
              client.send(new RequestHeartbeat({ user_msg: [ts] }));
            }
          } catch {
            /* closing */
          }
        }
      }, 25_000);
      this.#heartbeatTimer.unref?.();
    }
  }

  /** @deprecated use `chart.planets.history.load()` */
  loadHistory(options) {
    return this.planets.history.load(options);
  }

  /** @deprecated use `chart.planets.history.loadTick()` */
  loadTickHistory(options) {
    return this.planets.history.loadTick(options);
  }

  /** @deprecated use `chart.planets.live.start()` */
  startLive(options) {
    return this.planets.live.start(options);
  }

  /** @deprecated use `chart.planets.live.stop()` */
  stopLive() {
    return this.planets.live.stop();
  }

  close() {
    this.#live.live = false;
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    for (const client of [this.#ticker, this.#history, this.#order, this.#pnl]) {
      client?.close();
    }
    this.#ticker = null;
    this.#history = null;
    this.#order = null;
    this.#pnl = null;
    this.#planets = null;
  }
}
