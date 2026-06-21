import { Packet } from "./Packet.js";
import { ResponseModifyOrder } from "./ResponseModifyOrder.js";

export class RequestModifyOrder extends Packet {
  static MESSAGE_NAME = "RequestModifyOrder";
  static TEMPLATE_ID = 314;
  static Response = ResponseModifyOrder;

  constructor(data = {}) {
    super();
    this.template_id = 314;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestModifyOrder.register();
