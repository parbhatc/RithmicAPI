import { Packet } from "./Packet.js";

export class LastTrade extends Packet {
  static MESSAGE_NAME = "LastTrade";
  static TEMPLATE_ID = 150;

  constructor() {
    super();
    this.template_id = 150;
  }
}

LastTrade.register();
