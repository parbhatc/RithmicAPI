import { Packet } from "./Packet.js";

export class DepthByOrderEndEvent extends Packet {
  static MESSAGE_NAME = "DepthByOrderEndEvent";
  static TEMPLATE_ID = 161;

  constructor() {
    super();
    this.template_id = 161;
  }
}

DepthByOrderEndEvent.register();
