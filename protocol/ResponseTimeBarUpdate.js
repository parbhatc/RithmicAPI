import { Packet } from "./Packet.js";

export class ResponseTimeBarUpdate extends Packet {
  static MESSAGE_NAME = "ResponseTimeBarUpdate";
  static TEMPLATE_ID = 201;

  constructor() {
    super();
    this.template_id = 201;
  }
}

ResponseTimeBarUpdate.register();
