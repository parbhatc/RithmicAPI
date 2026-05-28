import { Packet } from "./Packet.js";

export class Reject extends Packet {
  static MESSAGE_NAME = "Reject";
  static TEMPLATE_ID = 75;

  constructor() {
    super();
    this.template_id = 75;
  }
}

Reject.register();
