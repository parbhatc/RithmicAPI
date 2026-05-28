import { Packet } from "./Packet.js";

export class ResponseShowOrders extends Packet {
  static MESSAGE_NAME = "ResponseShowOrders";
  static TEMPLATE_ID = 321;

  constructor() {
    super();
    this.template_id = 321;
  }
}

ResponseShowOrders.register();
