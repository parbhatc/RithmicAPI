import { Packet } from "./Packet.js";
import { ResponseUpdateTargetBracketLevel } from "./ResponseUpdateTargetBracketLevel.js";

export class RequestUpdateTargetBracketLevel extends Packet {
  static MESSAGE_NAME = "RequestUpdateTargetBracketLevel";
  static TEMPLATE_ID = 332;
  static Response = ResponseUpdateTargetBracketLevel;

  constructor(data = {}) {
    super();
    this.template_id = 332;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestUpdateTargetBracketLevel.register();
