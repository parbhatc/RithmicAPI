import { Packet } from "./Packet.js";

export class ResponseSearchSymbols extends Packet {
  static MESSAGE_NAME = "ResponseSearchSymbols";
  static TEMPLATE_ID = 110;

  constructor() {
    super();
    this.template_id = 110;
  }
}

ResponseSearchSymbols.register();
