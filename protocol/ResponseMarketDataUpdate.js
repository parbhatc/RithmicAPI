import { Packet } from "./Packet.js";

export class ResponseMarketDataUpdate extends Packet {
  static MESSAGE_NAME = "ResponseMarketDataUpdate";
  static TEMPLATE_ID = 101;

  constructor() {
    super();
    this.template_id = 101;
  }
}

ResponseMarketDataUpdate.register();
