import { Packet } from "./Packet.js";

export class OrderBook extends Packet {
  static MESSAGE_NAME = "OrderBook";
  static TEMPLATE_ID = 156;

  constructor() {
    super();
    this.template_id = 156;
  }
}

OrderBook.register();
