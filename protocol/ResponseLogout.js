import { Packet } from "./Packet.js";

export class ResponseLogout extends Packet {
  static MESSAGE_NAME = "ResponseLogout";
  static TEMPLATE_ID = 13;

  constructor() {
    super();
    this.template_id = 13;
  }
}

ResponseLogout.register();
