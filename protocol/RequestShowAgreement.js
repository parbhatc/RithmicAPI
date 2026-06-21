import { Packet } from "./Packet.js";
import { ResponseShowAgreement } from "./ResponseShowAgreement.js";

export class RequestShowAgreement extends Packet {
  static MESSAGE_NAME = "RequestShowAgreement";
  static TEMPLATE_ID = 506;
  static Response = ResponseShowAgreement;

  constructor(data = {}) {
    super();
    this.template_id = 506;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestShowAgreement.register();
