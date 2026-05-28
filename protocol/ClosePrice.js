import { Packet } from "./Packet.js";

export class ClosePrice extends Packet {
  static MESSAGE_NAME = "ClosePrice";
  static TEMPLATE_ID = 155;

  constructor() {
    super();
    this.template_id = 155;
  }
}

ClosePrice.register();
