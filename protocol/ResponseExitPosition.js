import { Packet } from "./Packet.js";

export class ResponseExitPosition extends Packet {
  static MESSAGE_NAME = "ResponseExitPosition";
  static TEMPLATE_ID = 3505;

  constructor() {
    super();
    this.template_id = 3505;
  }
}

ResponseExitPosition.register();
