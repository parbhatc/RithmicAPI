import { Packet } from "./Packet.js";

export class ResponseListUnacceptedAgreements extends Packet {
  static MESSAGE_NAME = "ResponseListUnacceptedAgreements";
  static TEMPLATE_ID = 501;

  constructor() {
    super();
    this.template_id = 501;
  }
}

ResponseListUnacceptedAgreements.register();
