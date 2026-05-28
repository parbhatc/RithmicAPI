import { Packet } from "./Packet.js";

export class ResponseCancelAllOrders extends Packet {
  static MESSAGE_NAME = "ResponseCancelAllOrders";
  static TEMPLATE_ID = 347;

  constructor() {
    super();
    this.template_id = 347;
  }
}

ResponseCancelAllOrders.register();
