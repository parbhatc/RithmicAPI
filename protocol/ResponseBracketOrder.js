import { Packet } from "./Packet.js";

export class ResponseBracketOrder extends Packet {
  static MESSAGE_NAME = "ResponseBracketOrder";
  static TEMPLATE_ID = 331;

  constructor() {
    super();
    this.template_id = 331;
  }
}

ResponseBracketOrder.register();
