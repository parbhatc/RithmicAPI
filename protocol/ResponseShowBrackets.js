import { Packet } from "./Packet.js";

export class ResponseShowBrackets extends Packet {
  static MESSAGE_NAME = "ResponseShowBrackets";
  static TEMPLATE_ID = 339;

  constructor() {
    super();
    this.template_id = 339;
  }
}

ResponseShowBrackets.register();
