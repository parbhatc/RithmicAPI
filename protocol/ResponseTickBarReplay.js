import { Packet } from "./Packet.js";

export class ResponseTickBarReplay extends Packet {
  static MESSAGE_NAME = "ResponseTickBarReplay";
  static TEMPLATE_ID = 207;

  constructor() {
    super();
    this.template_id = 207;
  }
}

ResponseTickBarReplay.register();
