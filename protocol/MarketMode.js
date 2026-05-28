import { Packet } from "./Packet.js";

export class MarketMode extends Packet {
  static MESSAGE_NAME = "MarketMode";
  static TEMPLATE_ID = 157;

  constructor() {
    super();
    this.template_id = 157;
  }
}

MarketMode.register();
