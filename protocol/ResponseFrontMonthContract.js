import { Packet } from "./Packet.js";

export class ResponseFrontMonthContract extends Packet {
  static MESSAGE_NAME = "ResponseFrontMonthContract";
  static TEMPLATE_ID = 114;

  constructor() {
    super();
    this.template_id = 114;
  }
}

ResponseFrontMonthContract.register();
