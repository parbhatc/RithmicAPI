import { Packet } from "./Packet.js";

export class ResponseMarketDataSubscribe extends Packet {
  static MESSAGE_NAME = "ResponseMarketDataSubscribe";
  static TEMPLATE_ID = 100001;

  constructor() {
    super();
    this.template_id = 100001;
  }
}

ResponseMarketDataSubscribe.register();
