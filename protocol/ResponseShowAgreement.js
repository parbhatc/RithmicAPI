import { Packet } from "./Packet.js";

export class ResponseShowAgreement extends Packet {
  static MESSAGE_NAME = "ResponseShowAgreement";
  static TEMPLATE_ID = 507;

  constructor() {
    super();
    this.template_id = 507;
  }
}

ResponseShowAgreement.register();
