import { Packet } from "./Packet.js";
import { ResponseSubscribeToBracketUpdates } from "./ResponseSubscribeToBracketUpdates.js";

export class RequestSubscribeToBracketUpdates extends Packet {
  static MESSAGE_NAME = "RequestSubscribeToBracketUpdates";
  static TEMPLATE_ID = 336;
  static Response = ResponseSubscribeToBracketUpdates;

  constructor(data = {}) {
    super();
    this.template_id = 336;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestSubscribeToBracketUpdates.register();
