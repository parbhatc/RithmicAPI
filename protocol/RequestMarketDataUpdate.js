import { Packet } from "./Packet.js";
import { ResponseMarketDataUpdate } from "./ResponseMarketDataUpdate.js";

export class RequestMarketDataUpdate extends Packet {
  static MESSAGE_NAME = "RequestMarketDataUpdate";
  static TEMPLATE_ID = 100;
  static Response = ResponseMarketDataUpdate;

  constructor(data = {}) {
    super();
    this.template_id = 100;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestMarketDataUpdate.register();
