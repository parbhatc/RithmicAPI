import { Packet } from "./Packet.js";

export class ResponseDepthByOrderUpdates extends Packet {
  static MESSAGE_NAME = "ResponseDepthByOrderUpdates";
  static TEMPLATE_ID = 118;

  constructor() {
    super();
    this.template_id = 118;
  }
}

ResponseDepthByOrderUpdates.register();
