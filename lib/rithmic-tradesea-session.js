/**
 * Rithmic connection + TradeSea-accurate market data (forming, LTP, bid/ask).
 *
 * TradeSea charts use Rithmic underneath but apply session/calendar aggregation.
 * This session keeps Rithmic for the feed while TradeSea MDS keeps OHLC/book exact.
 *
 * ```javascript
 * const sess = await RithmicTradeSeaSession.open({
 *   user, password, symbol: "NQ", exchange: "CME",
 *   accessToken: process.env.TRADESEA_ACCESS_TOKEN,
 *   resolutions: [15, 60, 240, "1D", "1W", "1M"],
 * });
 * sess.getForming(15);   // matches TradeSea chart
 * sess.status;           // last, bid, ask — matches TradeSea DOM
 * ```
 */
import { ChartSession } from "../ChartSession.js";
import { FormingBarManager } from "./forming-bar-manager.js";
import { TradeseaMdsSync } from "./tradesea-forming-sync.js";
import { toTradeseaStreamSymbol } from "./tradesea-stream-symbol.js";
import { MarketUpdatePreset } from "./market-enums.js";

const DEFAULT_CONNECTION_USER_ID =
  "dDqVtke0T1bbMKI-g6JpZKpOT1FCUzI5NzQ2omV1q0xULTFYRDgxWjlEoWSDonNurEx1Y2lkVHJhZGluZ6NmY22sTHVjaWRUcmFkaW5nomlirEx1Y2lkVHJhZGluZw";
const DEFAULT_CONNECTION_GROUP_ID =
  "6c1e6cb7bff88283b854e92fcf5aa9eda70a33e728f6875015d2a8e36217b265";

export class RithmicTradeSeaSession {
  #chart;
  #mgr;
  #tsSync;
  #closed = false;

  constructor(chart, mgr, tsSync) {
    this.#chart = chart;
    this.#mgr = mgr;
    this.#tsSync = tsSync;
  }

  get chart() {
    return this.#chart;
  }

  get manager() {
    return this.#mgr;
  }

  get tradesea() {
    return this.#tsSync;
  }

  get symbol() {
    return this.#chart.symbol;
  }

  get exchange() {
    return this.#chart.exchange;
  }

  /** Rithmic raw status (may differ slightly from TradeSea). */
  get rithmicStatus() {
    return this.#chart.status;
  }

  /** TradeSea-accurate last/bid/ask (preferred for display). */
  get status() {
    return this.#tsSync.getStatus() ?? this.#chart.status;
  }

  get marketBook() {
    return this.#tsSync.marketBook;
  }

  getForming(resolution) {
    return this.#mgr.getForming(resolution);
  }

  getAllForming() {
    return this.#mgr.getAllForming();
  }

  on(event, handler) {
    if (event === "trade") this.#chart.on("trade", handler);
    else if (event === "quote") this.#chart.on("quote", handler);
    else if (event === "market") this.#tsSync.on("market", handler);
    else if (event === "candle") this.#tsSync.on("candle", handler);
    else if (event === "formingBar") this.#mgr.on("formingBar", handler);
    else this.#tsSync.on(event, handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    if (event === "trade") this.#chart.off("trade", handler);
    else if (event === "quote") this.#chart.off("quote", handler);
    else if (event === "market") this.#tsSync.off("market", handler);
    else if (event === "candle") this.#tsSync.off("candle", handler);
    else if (event === "formingBar") this.#mgr.off("formingBar", handler);
    else this.#tsSync.off(event, handler);
  }

  /**
   * @param {object} options
   * @param {string} options.user
   * @param {string} options.password
   * @param {string} [options.systemName='LucidTrading']
   * @param {string} options.symbol
   * @param {string} options.exchange
   * @param {string} [options.gatewayName]
   * @param {string} options.accessToken TradeSea access_token cookie
   * @param {string} [options.refreshToken]
   * @param {string} [options.connectionUserId]
   * @param {string} [options.connectionGroupId]
   * @param {string} [options.streamSymbol] e.g. CME:NQ (auto from symbol+exchange)
   * @param {(number|string)[]} options.resolutions
   * @param {boolean} [options.attachRithmicLive=true] Rithmic last trade for order flow
   * @param {boolean} [options.parallel=true] Bootstrap Rithmic + TradeSea in parallel
   * @param {number} [options.timeoutMs=120000]
   */
  static async open({
    user,
    password,
    systemName = "LucidTrading",
    symbol,
    exchange,
    gatewayName,
    accessToken = process.env.TRADESEA_ACCESS_TOKEN,
    refreshToken,
    connectionUserId = process.env.TRADESEA_CONNECTION_USER_ID ?? DEFAULT_CONNECTION_USER_ID,
    connectionGroupId = process.env.TRADESEA_CONNECTION_GROUP_ID ?? DEFAULT_CONNECTION_GROUP_ID,
    streamSymbol,
    resolutions = [15, 60, 240, "1D", "1W", "1M", 1],
    attachRithmicLive = true,
    parallel = true,
    timeoutMs = 120_000,
    tradeSeaWaitMs = 5000,
  } = {}) {
    if (!user || !password) throw new Error("RithmicTradeSeaSession.open: user and password required");
    if (!accessToken) {
      throw new Error(
        "RithmicTradeSeaSession.open: TRADESEA_ACCESS_TOKEN required for TradeSea-accurate data",
      );
    }
    if (!resolutions?.length) throw new Error("RithmicTradeSeaSession.open: resolutions required");

    const stream = streamSymbol ?? toTradeseaStreamSymbol(symbol, exchange);
    const allRes = [...new Set([...resolutions, 1])];

    const chart = await ChartSession.open({
      user,
      password,
      systemName,
      symbol,
      exchange,
      gatewayName,
    });

    const mgr = new FormingBarManager(chart);
    const tsSync = new TradeseaMdsSync(mgr, {
      accessToken,
      refreshToken,
      connectionUserId,
      connectionGroupId,
      streamSymbol: stream,
    });

    const nowSec = Math.floor(Date.now() / 1000);

    if (parallel) {
      await Promise.all([
        tsSync.start({
          resolutions: allRes,
          seedFromHistory: true,
          subscribeMarket: true,
          waitForWsMs: tradeSeaWaitMs,
          waitForMarketMs: tradeSeaWaitMs,
        }),
        mgr.bootstrap({
          resolutions: allRes,
          nowSec,
          timeoutMs,
          tradeSeaAccessToken: accessToken,
          fast: true,
          useCache: true,
        }),
      ]);
    } else {
      await mgr.bootstrap({
        resolutions: allRes,
        nowSec,
        timeoutMs,
        tradeSeaAccessToken: accessToken,
        fast: false,
        awaitSession: true,
        tickFallback: true,
      });
      await tsSync.start({
        resolutions: allRes,
        seedFromHistory: true,
        subscribeMarket: true,
        waitForWsMs: tradeSeaWaitMs,
        waitForMarketMs: tradeSeaWaitMs,
      });
    }

    if (attachRithmicLive) {
      await mgr.attachLive({ updateBits: MarketUpdatePreset.QUOTE });
    }

    return new RithmicTradeSeaSession(chart, mgr, tsSync);
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#mgr.detachLive?.();
    await this.#tsSync.stop();
    this.#chart.close?.();
  }
}

/**
 * Convenience: bootstrap FormingBarManager + start TradeSea MDS sync.
 * @returns {Promise<TradeseaMdsSync>}
 */
export async function attachTradeSeaSync(mgr, options = {}) {
  const {
    resolutions,
    accessToken = process.env.TRADESEA_ACCESS_TOKEN,
    refreshToken,
    connectionUserId = process.env.TRADESEA_CONNECTION_USER_ID ?? DEFAULT_CONNECTION_USER_ID,
    connectionGroupId = process.env.TRADESEA_CONNECTION_GROUP_ID ?? DEFAULT_CONNECTION_GROUP_ID,
    streamSymbol = "CME:NQ",
    ...startOpts
  } = options;

  if (!accessToken) throw new Error("attachTradeSeaSync: accessToken required");

  const tsSync = new TradeseaMdsSync(mgr, {
    accessToken,
    refreshToken,
    connectionUserId,
    connectionGroupId,
    streamSymbol,
  });

  await tsSync.start({
    resolutions: resolutions ?? [...mgr.resolutions, 1],
    seedFromHistory: true,
    subscribeMarket: true,
    ...startOpts,
  });

  return tsSync;
}
