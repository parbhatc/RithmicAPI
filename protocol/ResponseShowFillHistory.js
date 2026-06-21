import { Packet } from "./Packet.js";

export class ResponseShowFillHistory extends Packet {
  static MESSAGE_NAME = "ResponseShowFillHistory";
  static TEMPLATE_ID = 3513;

  constructor() {
    super();
    this.template_id = 3513;
  }
}

ResponseShowFillHistory.register();
