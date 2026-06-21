import { Packet } from "./Packet.js";

export class ResponseShowOrderHistoryDates extends Packet {
  static MESSAGE_NAME = "ResponseShowOrderHistoryDates";
  static TEMPLATE_ID = 319;

  constructor() {
    super();
    this.template_id = 319;
  }
}

ResponseShowOrderHistoryDates.register();
