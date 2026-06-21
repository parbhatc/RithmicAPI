import { Packet } from "./Packet.js";

export class TradeRoute extends Packet {
  static MESSAGE_NAME = "TradeRoute";
  static TEMPLATE_ID = 350;

  constructor() {
    super();
    this.template_id = 350;
  }
}

TradeRoute.register();
