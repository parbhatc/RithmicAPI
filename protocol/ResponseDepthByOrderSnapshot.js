import { Packet } from "./Packet.js";

export class ResponseDepthByOrderSnapshot extends Packet {
  static MESSAGE_NAME = "ResponseDepthByOrderSnapshot";
  static TEMPLATE_ID = 116;

  constructor() {
    super();
    this.template_id = 116;
  }
}

ResponseDepthByOrderSnapshot.register();
