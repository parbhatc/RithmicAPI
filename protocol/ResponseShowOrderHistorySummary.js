import { Packet } from "./Packet.js";

export class ResponseShowOrderHistorySummary extends Packet {
  static MESSAGE_NAME = "ResponseShowOrderHistorySummary";
  static TEMPLATE_ID = 325;

  constructor() {
    super();
    this.template_id = 325;
  }
}

ResponseShowOrderHistorySummary.register();
