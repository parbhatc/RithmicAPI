import { EventEmitter } from "node:events";
import { RequestHeartbeat, RequestLogout } from "../../../protocol/index.js";
import { InfraType } from "../../../protocol/RequestLogin.js";
import { SessionGateway } from "./SessionGateway.js";
import { LiveFeed } from "./LiveFeed.js";
import { Planets } from "./planets/Planets.js";
import { DEFAULT_PLANTS } from "./plantDefaults.js";
import { resolveLog } from "../../util.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const PLANT_SETTLE_MS = 3_000;

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
  /** @type {{ user: string, password: string, systemName: string, gatewayName?: string, log?: boolean }|null} */
  #savedConnect = null;
  /** @type {import("../../util/wire-sniffer-log.js").WireSnifferLog|null} */
  #wireSniffer = null;
  /** @type {Promise<void>|null} */
  #reconnectLock = null;
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
    wireSniffer,
  }) {
    if (!user || !password) throw new Error("user and password are required");
    if (!systemName) throw new Error("systemName is required");

    this.log = resolveLog(log);
    this.#wireSniffer = wireSniffer ?? null;
    this.#savedConnect = { user, password, systemName, gatewayName, log: this.log };

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
      wireSniffer: this.#wireSniffer,
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

  /** Re-open ticker + history sockets after disconnect (re-login). */
  async reconnectDataPlants() {
    if (this.#reconnectLock) return this.#reconnectLock;
    this.#reconnectLock = this.#reconnectDataPlantsInner();
    try {
      await this.#reconnectLock;
    } finally {
      this.#reconnectLock = null;
    }
  }

  async #reconnectDataPlantsInner() {
    if (!this.#savedConnect || !this.uri) {
      throw new Error("session not connected");
    }
    const { user, password, systemName } = this.#savedConnect;
    const credentials = { user, password, systemName };
    const connectOpts = {
      uri: this.uri,
      credentials,
      debug: this.log,
      wireSniffer: this.#wireSniffer,
    };

    // One plant at a time — avoids overlapping logins on tp_max_session_count: 1.
    if (this.#plantFlags.ticker) {
      const old = this.#ticker;
      this.#ticker = null;
      await this.#logoutClient(old);
      await sleep(PLANT_SETTLE_MS);
      this.#ticker = await SessionGateway.connectPlant({
        ...connectOpts,
        label: "ticker",
        infraType: InfraType.TICKER_PLANT,
      });
    }
    if (this.#plantFlags.history) {
      const old = this.#history;
      this.#history = null;
      await this.#logoutClient(old);
      await sleep(PLANT_SETTLE_MS);
      this.#history = await SessionGateway.connectPlant({
        ...connectOpts,
        label: "history",
        infraType: InfraType.HISTORY_PLANT,
        timeoutMs: 180_000,
      });
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

  async #logoutClient(client) {
    if (!client) return;
    client._intentionalClose = true;
    const hadOpen = client.ws?.readyState === 1;
    try {
      if (hadOpen) {
        await client.exchange(new RequestLogout());
      }
    } catch {
      /* ignore */
    }
    client.close();
    if (!hadOpen) {
      await sleep(PLANT_SETTLE_MS);
    }
  }

  async close() {
    this.#live.live = false;
    this.#ticker?.releaseReceiveWaiters?.();
    this.#history?.releaseReceiveWaiters?.();
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    await this.#logoutClient(this.#ticker);
    await this.#logoutClient(this.#history);
    await this.#logoutClient(this.#order);
    await this.#logoutClient(this.#pnl);
    this.#ticker = null;
    this.#history = null;
    this.#order = null;
    this.#pnl = null;
    this.#planets = null;
  }
}
