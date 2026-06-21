import { Packet } from "./Packet.js";
import { ResponseBracketOrder } from "./ResponseBracketOrder.js";

export class RequestBracketOrder extends Packet {
  static MESSAGE_NAME = "RequestBracketOrder";
  static TEMPLATE_ID = 330;
  static Response = ResponseBracketOrder;

  constructor(data = {}) {
    super();
    this.template_id = 330;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestBracketOrder.register();
