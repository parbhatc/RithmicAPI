import { Packet } from "./Packet.js";
import { ResponseTimeBarReplay } from "./ResponseTimeBarReplay.js";

export class RequestTimeBarReplay extends Packet {
  static MESSAGE_NAME = "RequestTimeBarReplay";
  static TEMPLATE_ID = 202;
  static Response = ResponseTimeBarReplay;

  constructor(data = {}) {
    super();
    this.template_id = 202;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestTimeBarReplay.register();
