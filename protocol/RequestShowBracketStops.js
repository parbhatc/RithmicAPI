import { Packet } from "./Packet.js";
import { ResponseShowBracketStops } from "./ResponseShowBracketStops.js";

export class RequestShowBracketStops extends Packet {
  static MESSAGE_NAME = "RequestShowBracketStops";
  static TEMPLATE_ID = 340;
  static Response = ResponseShowBracketStops;

  constructor(data = {}) {
    super();
    this.template_id = 340;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestShowBracketStops.register();
