import {
  RequestReferenceData,
  RequestMarketDataUpdate,
  RequestSearchSymbols,
  RequestFrontMonthContract,
  RequestDepthByOrderSnapshot,
  RequestDepthByOrderUpdates,
} from "../../../../protocol/index.js";
import { SubscribeRequest } from "../../../marketEnums.js";
import { SessionGateway } from "../SessionGateway.js";

export class TickerPlanet {
  #session;

  constructor(session) {
    this.#session = session;
  }

  #client() {
    const client = this.#session.tickerClient;
    if (!client) {
      throw new Error("Ticker plant is disabled. Pass plants: { ticker: true } to ChartSession.open()");
    }
    return client;
  }

  #sym(symbol, exchange) {
    const s = symbol ?? this.#session.symbol;
    const e = exchange ?? this.#session.exchange;
    if (!s || !e) throw new Error("symbol and exchange are required");
    return { symbol: s, exchange: e, msg: SessionGateway.userMsg(s, e) };
  }

  referenceData({ symbol, exchange, priceType = "final", referenceMode = "auto" } = {}) {
    const { symbol: s, exchange: e, msg } = this.#sym(symbol, exchange);
    return this.#client().exchange(
      new RequestReferenceData({
        symbol: s,
        exchange: e,
        user_msg: [msg, priceType, referenceMode],
      }),
    );
  }

  subscribe({ symbol, exchange, updateBits } = {}) {
    const { symbol: s, exchange: e, msg } = this.#sym(symbol, exchange);
    return this.#client().exchange(
      new RequestMarketDataUpdate({
        symbol: s,
        exchange: e,
        user_msg: [msg],
        request: SubscribeRequest.SUBSCRIBE,
        update_bits: updateBits,
      }),
    );
  }

  unsubscribe({ symbol, exchange, updateBits } = {}) {
    const { symbol: s, exchange: e, msg } = this.#sym(symbol, exchange);
    return this.#client().exchange(
      new RequestMarketDataUpdate({
        symbol: s,
        exchange: e,
        user_msg: [msg],
        request: SubscribeRequest.UNSUBSCRIBE,
        update_bits: updateBits,
      }),
    );
  }

  searchSymbols(data) {
    return this.#client().exchange(new RequestSearchSymbols(data));
  }

  frontMonthContract(data) {
    return this.#client().exchange(new RequestFrontMonthContract(data));
  }

  depthByOrderSnapshot(data) {
    return this.#client().exchange(new RequestDepthByOrderSnapshot(data));
  }

  subscribeDepthByOrder(data) {
    return this.#client().exchange(
      new RequestDepthByOrderUpdates({ ...data, request: SubscribeRequest.SUBSCRIBE }),
    );
  }

  unsubscribeDepthByOrder(data) {
    return this.#client().exchange(
      new RequestDepthByOrderUpdates({ ...data, request: SubscribeRequest.UNSUBSCRIBE }),
    );
  }
}
