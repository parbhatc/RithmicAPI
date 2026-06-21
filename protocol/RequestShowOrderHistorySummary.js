import { Packet } from "./Packet.js";
import { ResponseShowOrderHistorySummary } from "./ResponseShowOrderHistorySummary.js";

export class RequestShowOrderHistorySummary extends Packet {
  static MESSAGE_NAME = "RequestShowOrderHistorySummary";
  static TEMPLATE_ID = 324;
  static Response = ResponseShowOrderHistorySummary;

  constructor(data = {}) {
    super();
    this.template_id = 324;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestShowOrderHistorySummary.register();
