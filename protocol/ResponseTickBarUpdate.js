import { Packet } from "./Packet.js";

export class ResponseTickBarUpdate extends Packet {
  static MESSAGE_NAME = "ResponseTickBarUpdate";
  static TEMPLATE_ID = 205;

  constructor() {
    super();
    this.template_id = 205;
  }
}

ResponseTickBarUpdate.register();
