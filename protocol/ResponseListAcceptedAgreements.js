import { Packet } from "./Packet.js";

export class ResponseListAcceptedAgreements extends Packet {
  static MESSAGE_NAME = "ResponseListAcceptedAgreements";
  static TEMPLATE_ID = 503;

  constructor() {
    super();
    this.template_id = 503;
  }
}

ResponseListAcceptedAgreements.register();
