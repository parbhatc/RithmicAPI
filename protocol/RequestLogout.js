import { Packet } from "./Packet.js";
import { ResponseLogout } from "./ResponseLogout.js";

export class RequestLogout extends Packet {
  static MESSAGE_NAME = "RequestLogout";
  static TEMPLATE_ID = 12;
  static Response = ResponseLogout;

  constructor(data = {}) {
    super();
    this.template_id = 12;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestLogout.register();
