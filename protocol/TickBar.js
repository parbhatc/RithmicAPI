import { Packet } from "./Packet.js";

export class TickBar extends Packet {
  static MESSAGE_NAME = "TickBar";
  static TEMPLATE_ID = 251;

  constructor() {
    super();
    this.template_id = 251;
  }
}

TickBar.register();
