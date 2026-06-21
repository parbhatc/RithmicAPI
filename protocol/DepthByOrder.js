import { Packet } from "./Packet.js";

export class DepthByOrder extends Packet {
  static MESSAGE_NAME = "DepthByOrder";
  static TEMPLATE_ID = 160;

  constructor() {
    super();
    this.template_id = 160;
  }
}

DepthByOrder.register();
