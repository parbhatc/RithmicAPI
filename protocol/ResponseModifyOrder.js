import { Packet } from "./Packet.js";

export class ResponseModifyOrder extends Packet {
  static MESSAGE_NAME = "ResponseModifyOrder";
  static TEMPLATE_ID = 315;

  constructor() {
    super();
    this.template_id = 315;
  }
}

ResponseModifyOrder.register();
