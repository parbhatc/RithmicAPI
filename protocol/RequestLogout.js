import { Packet } from "./Packet.js";

export class RequestLogout extends Packet {
  static MESSAGE_NAME = "RequestLogout";
  static TEMPLATE_ID = 12;

  constructor(data = {}) {
    super();
    this.template_id = 12;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestLogout.register();
