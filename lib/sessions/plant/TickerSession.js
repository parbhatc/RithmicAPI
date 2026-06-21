import { PlantSession } from "./PlantSession.js";
import { InfraType } from "../../../protocol/RequestLogin.js";
import {
  RequestLoginInfo,
  RequestMarketDataUpdate,
  RequestSearchSymbols,
  RequestFrontMonthContract,
  RequestDepthByOrderSnapshot,
  RequestDepthByOrderUpdates,
  RequestReferenceData,
} from "../../../protocol/index.js";
import { SubscribeRequest } from "../../marketEnums.js";
import { SessionGateway } from "../chart/SessionGateway.js";

export class TickerSession extends PlantSession {
  constructor(opts) {
    super({ ...opts, infraType: InfraType.TICKER_PLANT, label: opts.label ?? "ticker" });
  }

  async connect() {
    await super.connect();
    await this.client.exchange(new RequestLoginInfo(this.login.unique_user_id));
    return this.login;
  }

  userMsg(symbol, exchange) {
    return SessionGateway.userMsg(symbol, exchange);
  }

  async referenceData({ symbol, exchange, priceType = "final", referenceMode = "auto" }) {
    const msg = this.userMsg(symbol, exchange);
    return this.exchange(
      new RequestReferenceData({
        symbol,
        exchange,
        user_msg: [msg, priceType, referenceMode],
      }),
    );
  }

  async subscribeMarketData({ symbol, exchange, updateBits }) {
    const msg = this.userMsg(symbol, exchange);
    return this.exchange(
      new RequestMarketDataUpdate({
        symbol,
        exchange,
        user_msg: [msg],
        request: SubscribeRequest.SUBSCRIBE,
        update_bits: updateBits,
      }),
    );
  }

  async unsubscribeMarketData({ symbol, exchange, updateBits }) {
    const msg = this.userMsg(symbol, exchange);
    return this.exchange(
      new RequestMarketDataUpdate({
        symbol,
        exchange,
        user_msg: [msg],
        request: SubscribeRequest.UNSUBSCRIBE,
        update_bits: updateBits,
      }),
    );
  }

  async searchSymbols(data) {
    return this.exchange(new RequestSearchSymbols(data));
  }

  async frontMonthContract(data) {
    return this.exchange(new RequestFrontMonthContract(data));
  }

  async depthByOrderSnapshot(data) {
    return this.exchange(new RequestDepthByOrderSnapshot(data));
  }

  async subscribeDepthByOrder(data) {
    return this.exchange(
      new RequestDepthByOrderUpdates({
        ...data,
        request: SubscribeRequest.SUBSCRIBE,
      }),
    );
  }

  async unsubscribeDepthByOrder(data) {
    return this.exchange(
      new RequestDepthByOrderUpdates({
        ...data,
        request: SubscribeRequest.UNSUBSCRIBE,
      }),
    );
  }
}
