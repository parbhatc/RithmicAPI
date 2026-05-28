import { Packet } from "./Packet.js";
import { ResponseShowBrackets } from "./ResponseShowBrackets.js";

export class RequestShowBrackets extends Packet {
  static MESSAGE_NAME = "RequestShowBrackets";
  static TEMPLATE_ID = 338;
  static Response = ResponseShowBrackets;

  constructor(data = {}) {
    super();
    this.template_id = 338;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestShowBrackets.register();
