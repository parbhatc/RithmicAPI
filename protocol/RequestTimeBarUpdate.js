import { Packet } from "./Packet.js";
import { ResponseTimeBarUpdate } from "./ResponseTimeBarUpdate.js";

export class RequestTimeBarUpdate extends Packet {
  static MESSAGE_NAME = "RequestTimeBarUpdate";
  static TEMPLATE_ID = 200;
  static Response = ResponseTimeBarUpdate;

  constructor(data = {}) {
    super();
    this.template_id = 200;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestTimeBarUpdate.register();
