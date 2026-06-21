import { Packet } from "./Packet.js";
import { ResponseListUnacceptedAgreements } from "./ResponseListUnacceptedAgreements.js";

export class RequestListUnacceptedAgreements extends Packet {
  static MESSAGE_NAME = "RequestListUnacceptedAgreements";
  static TEMPLATE_ID = 500;
  static Response = ResponseListUnacceptedAgreements;

  constructor(data = {}) {
    super();
    this.template_id = 500;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestListUnacceptedAgreements.register();
