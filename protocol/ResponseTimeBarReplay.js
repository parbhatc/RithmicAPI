import { Packet } from "./Packet.js";

export class ResponseTimeBarReplay extends Packet {
  static MESSAGE_NAME = "ResponseTimeBarReplay";
  static TEMPLATE_ID = 203;

  constructor() {
    super();
    this.template_id = 203;
  }
}

ResponseTimeBarReplay.register();
