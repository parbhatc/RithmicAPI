import { Packet } from "./Packet.js";

export class ResponseUpdateStopBracketLevel extends Packet {
  static MESSAGE_NAME = "ResponseUpdateStopBracketLevel";
  static TEMPLATE_ID = 335;

  constructor() {
    super();
    this.template_id = 335;
  }
}

ResponseUpdateStopBracketLevel.register();
