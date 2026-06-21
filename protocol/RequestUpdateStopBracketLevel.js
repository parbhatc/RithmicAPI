import { Packet } from "./Packet.js";
import { ResponseUpdateStopBracketLevel } from "./ResponseUpdateStopBracketLevel.js";

export class RequestUpdateStopBracketLevel extends Packet {
  static MESSAGE_NAME = "RequestUpdateStopBracketLevel";
  static TEMPLATE_ID = 334;
  static Response = ResponseUpdateStopBracketLevel;

  constructor(data = {}) {
    super();
    this.template_id = 334;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestUpdateStopBracketLevel.register();
