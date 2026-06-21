import { Packet } from "./Packet.js";

export class ResponseHeartbeat extends Packet {
  static MESSAGE_NAME = "ResponseHeartbeat";
  static TEMPLATE_ID = 19;

  constructor() {
    super();
    this.template_id = 19;
  }
}

ResponseHeartbeat.register();
