import { Packet } from "./Packet.js";

export class ResponseNewOrder extends Packet {
  static MESSAGE_NAME = "ResponseNewOrder";
  static TEMPLATE_ID = 313;

  constructor() {
    super();
    this.template_id = 313;
  }
}

ResponseNewOrder.register();
