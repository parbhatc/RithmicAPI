import { Packet } from "./Packet.js";

export class ResponsePnLPositionUpdates extends Packet {
  static MESSAGE_NAME = "ResponsePnLPositionUpdates";
  static TEMPLATE_ID = 401;

  constructor() {
    super();
    this.template_id = 401;
  }
}

ResponsePnLPositionUpdates.register();
