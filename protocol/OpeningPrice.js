import { Packet } from "./Packet.js";

export class OpeningPrice extends Packet {
  static MESSAGE_NAME = "OpeningPrice";
  static TEMPLATE_ID = 153;

  constructor() {
    super();
    this.template_id = 153;
  }
}

OpeningPrice.register();
