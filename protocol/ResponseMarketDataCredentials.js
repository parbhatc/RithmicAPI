import { Packet } from "./Packet.js";

export class ResponseMarketDataCredentials extends Packet {
  static MESSAGE_NAME = "ResponseMarketDataCredentials";
  static TEMPLATE_ID = 100005;

  constructor() {
    super();
    this.template_id = 100005;
  }
}

ResponseMarketDataCredentials.register();
