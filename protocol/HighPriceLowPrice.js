import { Packet } from "./Packet.js";

export class HighPriceLowPrice extends Packet {
  static MESSAGE_NAME = "HighPriceLowPrice";
  static TEMPLATE_ID = 152;

  constructor() {
    super();
    this.template_id = 152;
  }
}

HighPriceLowPrice.register();
