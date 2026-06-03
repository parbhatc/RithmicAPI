import { Packet } from "./Packet.js";
import { ResponseTickBarUpdate } from "./ResponseTickBarUpdate.js";

export class RequestTickBarUpdate extends Packet {
  static MESSAGE_NAME = "RequestTickBarUpdate";
  static TEMPLATE_ID = 204;
  static Response = ResponseTickBarUpdate;

  constructor(data = {}) {
    super();
    this.template_id = 204;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestTickBarUpdate.register();
