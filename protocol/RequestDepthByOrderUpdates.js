import { Packet } from "./Packet.js";
import { ResponseDepthByOrderUpdates } from "./ResponseDepthByOrderUpdates.js";

export class RequestDepthByOrderUpdates extends Packet {
  static MESSAGE_NAME = "RequestDepthByOrderUpdates";
  static TEMPLATE_ID = 117;
  static Response = ResponseDepthByOrderUpdates;

  constructor(data = {}) {
    super();
    this.template_id = 117;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestDepthByOrderUpdates.register();
