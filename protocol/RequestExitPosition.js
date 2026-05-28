import { Packet } from "./Packet.js";
import { ResponseExitPosition } from "./ResponseExitPosition.js";

export class RequestExitPosition extends Packet {
  static MESSAGE_NAME = "RequestExitPosition";
  static TEMPLATE_ID = 3504;
  static Response = ResponseExitPosition;

  constructor(data = {}) {
    super();
    this.template_id = 3504;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestExitPosition.register();
