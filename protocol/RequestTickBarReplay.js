import { Packet } from "./Packet.js";
import { ResponseTickBarReplay } from "./ResponseTickBarReplay.js";

export class RequestTickBarReplay extends Packet {
  static MESSAGE_NAME = "RequestTickBarReplay";
  static TEMPLATE_ID = 206;
  static Response = ResponseTickBarReplay;

  constructor(data = {}) {
    super();
    this.template_id = 206;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestTickBarReplay.register();
