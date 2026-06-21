import { Packet } from "./Packet.js";

export class ResponsePnLPositionSnapshot extends Packet {
  static MESSAGE_NAME = "ResponsePnLPositionSnapshot";
  static TEMPLATE_ID = 403;

  constructor() {
    super();
    this.template_id = 403;
  }
}

ResponsePnLPositionSnapshot.register();
