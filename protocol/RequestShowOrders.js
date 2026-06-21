import { Packet } from "./Packet.js";
import { ResponseShowOrders } from "./ResponseShowOrders.js";

export class RequestShowOrders extends Packet {
  static MESSAGE_NAME = "RequestShowOrders";
  static TEMPLATE_ID = 320;
  static Response = ResponseShowOrders;

  constructor(data = {}) {
    super();
    this.template_id = 320;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestShowOrders.register();
