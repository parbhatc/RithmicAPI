import { Packet } from "./Packet.js";
import { ResponseShowFillHistory } from "./ResponseShowFillHistory.js";

export class RequestShowFillHistory extends Packet {
  static MESSAGE_NAME = "RequestShowFillHistory";
  static TEMPLATE_ID = 3512;
  static Response = ResponseShowFillHistory;

  constructor(data = {}) {
    super();
    this.template_id = 3512;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestShowFillHistory.register();
