import { Packet } from "./Packet.js";

export class ResponseUpdateTargetBracketLevel extends Packet {
  static MESSAGE_NAME = "ResponseUpdateTargetBracketLevel";
  static TEMPLATE_ID = 333;

  constructor() {
    super();
    this.template_id = 333;
  }
}

ResponseUpdateTargetBracketLevel.register();
