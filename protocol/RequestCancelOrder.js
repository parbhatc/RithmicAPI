import { Packet } from "./Packet.js";
import { ResponseCancelOrder } from "./ResponseCancelOrder.js";

export class RequestCancelOrder extends Packet {
  static MESSAGE_NAME = "RequestCancelOrder";
  static TEMPLATE_ID = 316;
  static Response = ResponseCancelOrder;

  constructor(data = {}) {
    super();
    this.template_id = 316;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestCancelOrder.register();
