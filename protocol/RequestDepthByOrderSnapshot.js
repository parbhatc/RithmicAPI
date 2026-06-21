import { Packet } from "./Packet.js";
import { ResponseDepthByOrderSnapshot } from "./ResponseDepthByOrderSnapshot.js";

export class RequestDepthByOrderSnapshot extends Packet {
  static MESSAGE_NAME = "RequestDepthByOrderSnapshot";
  static TEMPLATE_ID = 115;
  static Response = ResponseDepthByOrderSnapshot;

  constructor(data = {}) {
    super();
    this.template_id = 115;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestDepthByOrderSnapshot.register();
