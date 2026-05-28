import { Packet } from "./Packet.js";
import { ResponseMarketDataSubscribe } from "./ResponseMarketDataSubscribe.js";

export class RequestSubscribeForUnderlying extends Packet {
  static MESSAGE_NAME = "RequestSubscribeForUnderlying";
  static TEMPLATE_ID = 100000;
  static Response = ResponseMarketDataSubscribe;

  constructor(data = {}) {
    super();
    this.template_id = 100000;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestSubscribeForUnderlying.register();
