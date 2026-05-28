import { Packet } from "./Packet.js";
import { ResponseNewOrder } from "./ResponseNewOrder.js";

export class RequestNewOrder extends Packet {
  static MESSAGE_NAME = "RequestNewOrder";
  static TEMPLATE_ID = 312;
  static Response = ResponseNewOrder;

  constructor(data = {}) {
    super();
    this.template_id = 312;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestNewOrder.register();
