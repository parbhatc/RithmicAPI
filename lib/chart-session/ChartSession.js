import { EventEmitter } from "node:events";
import { RequestHeartbeat } from "../../protocol/index.js";
import { SessionGateway } from "./util.js";
import { TimeBarHistory } from "./time-bar-history.js";
import { TickBarHistory } from "./tick-bar-history.js";
import { LiveFeed } from "./live-feed.js";

/**
 * Live + historical chart session (ticker plant + history plant).
 *
 * Emits: `trade`, `quote`, `latest_high_low`, `latest_close`, `bar`, `status`, `message`
 */
export class ChartSession extends EventEmitter {
  #ticker = null;
  #history = null;
  #heartbeatTimer = null;
  #live = new LiveFeed();

  constructor() {
    super();
    this.symbol = null;
    this.exchange = null;
    this.uri = null;
  }

  #ctx() {
    return {
      ticker: this.#ticker,
      history: this.#history,
      symbol: this.symbol,
      exchange: this.exchange,
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

  async connect({ user, password, systemName, symbol, exchange, uri, gatewayName, heartbeat = true }) {
    if (!user || !password) throw new Error("user and password are required");
    if (!systemName || !symbol || !exchange) {
      throw new Error("systemName, symbol, and exchange are required");
    }

    this.symbol = symbol;
    this.exchange = exchange;

    const plants = await SessionGateway.openPlants({
      user,
      password,
      systemName,
      symbol,
      exchange,
      uri,
      gatewayName,
    });
    this.#ticker = plants.ticker;
    this.#history = plants.history;
    this.uri = plants.uri;

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

  async loadHistory(options = {}) {
    return TimeBarHistory.load(this.#ctx(), options);
  }

  async loadTickHistory(options = {}) {
    return TickBarHistory.load(this.#ctx(), options);
  }

  async startLive(options = {}) {
    return this.#live.start(this, this.#ctx(), options);
  }

  async stopLive() {
    return this.#live.stop(this, this.#ctx());
  }

  close() {
    this.#live.live = false;
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
