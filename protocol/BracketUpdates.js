import { Packet } from "./Packet.js";

export class BracketUpdates extends Packet {
  static MESSAGE_NAME = "BracketUpdates";
  static TEMPLATE_ID = 353;

  constructor() {
    super();
    this.template_id = 353;
  }
}

BracketUpdates.register();
