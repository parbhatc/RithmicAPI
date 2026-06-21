import { Packet } from "./Packet.js";

export class ResponseCancelOrder extends Packet {
  static MESSAGE_NAME = "ResponseCancelOrder";
  static TEMPLATE_ID = 317;

  constructor() {
    super();
    this.template_id = 317;
  }
}

ResponseCancelOrder.register();
