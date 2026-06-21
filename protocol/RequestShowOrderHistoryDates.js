import { Packet } from "./Packet.js";
import { ResponseShowOrderHistoryDates } from "./ResponseShowOrderHistoryDates.js";

export class RequestShowOrderHistoryDates extends Packet {
  static MESSAGE_NAME = "RequestShowOrderHistoryDates";
  static TEMPLATE_ID = 318;
  static Response = ResponseShowOrderHistoryDates;

  constructor(data = {}) {
    super();
    this.template_id = 318;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestShowOrderHistoryDates.register();
