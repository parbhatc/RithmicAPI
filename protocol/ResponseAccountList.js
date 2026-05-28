import { Packet } from "./Packet.js";

export class ResponseAccountList extends Packet {
  static MESSAGE_NAME = "ResponseAccountList";
  static TEMPLATE_ID = 303;

  constructor() {
    super();
    this.template_id = 303;
  }
}

ResponseAccountList.register();
