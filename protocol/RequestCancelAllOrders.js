import { Packet } from "./Packet.js";
import { ResponseCancelAllOrders } from "./ResponseCancelAllOrders.js";

export class RequestCancelAllOrders extends Packet {
  static MESSAGE_NAME = "RequestCancelAllOrders";
  static TEMPLATE_ID = 346;
  static Response = ResponseCancelAllOrders;

  constructor(data = {}) {
    super();
    this.template_id = 346;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestCancelAllOrders.register();
