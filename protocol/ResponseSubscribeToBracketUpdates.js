import { Packet } from "./Packet.js";

export class ResponseSubscribeToBracketUpdates extends Packet {
  static MESSAGE_NAME = "ResponseSubscribeToBracketUpdates";
  static TEMPLATE_ID = 337;

  constructor() {
    super();
    this.template_id = 337;
  }
}

ResponseSubscribeToBracketUpdates.register();
