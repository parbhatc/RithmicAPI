import { Packet } from "./Packet.js";
import { ResponseSubscribeForOrderUpdates } from "./ResponseSubscribeForOrderUpdates.js";

export class RequestSubscribeForOrderUpdates extends Packet {
  static MESSAGE_NAME = "RequestSubscribeForOrderUpdates";
  static TEMPLATE_ID = 308;
  static Response = ResponseSubscribeForOrderUpdates;

  constructor(data = {}) {
    super();
    this.template_id = 308;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestSubscribeForOrderUpdates.register();
