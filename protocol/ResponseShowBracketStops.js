import { Packet } from "./Packet.js";

export class ResponseShowBracketStops extends Packet {
  static MESSAGE_NAME = "ResponseShowBracketStops";
  static TEMPLATE_ID = 341;

  constructor() {
    super();
    this.template_id = 341;
  }
}

ResponseShowBracketStops.register();
