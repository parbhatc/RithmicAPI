import { Packet } from "./Packet.js";

export class ResponseListExchangePermissions extends Packet {
  static MESSAGE_NAME = "ResponseListExchangePermissions";
  static TEMPLATE_ID = 343;

  constructor() {
    super();
    this.template_id = 343;
  }
}

ResponseListExchangePermissions.register();
