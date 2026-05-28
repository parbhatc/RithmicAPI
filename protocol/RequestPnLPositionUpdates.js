import { Packet } from "./Packet.js";
import { ResponsePnLPositionUpdates } from "./ResponsePnLPositionUpdates.js";

export class RequestPnLPositionUpdates extends Packet {
  static MESSAGE_NAME = "RequestPnLPositionUpdates";
  static TEMPLATE_ID = 400;
  static Response = ResponsePnLPositionUpdates;

  constructor(data = {}) {
    super();
    this.template_id = 400;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestPnLPositionUpdates.register();
