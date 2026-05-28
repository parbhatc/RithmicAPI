import { Packet } from "./Packet.js";
import { ResponseMarketDataCredentials } from "./ResponseMarketDataCredentials.js";

export class RequestMarketDataCredentials extends Packet {
  static MESSAGE_NAME = "RequestMarketDataCredentials";
  static TEMPLATE_ID = 100004;
  static Response = ResponseMarketDataCredentials;

  constructor(data = {}) {
    super();
    this.template_id = 100004;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestMarketDataCredentials.register();
