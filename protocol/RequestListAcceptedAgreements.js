import { Packet } from "./Packet.js";
import { ResponseListAcceptedAgreements } from "./ResponseListAcceptedAgreements.js";

export class RequestListAcceptedAgreements extends Packet {
  static MESSAGE_NAME = "RequestListAcceptedAgreements";
  static TEMPLATE_ID = 502;
  static Response = ResponseListAcceptedAgreements;

  constructor(data = {}) {
    super();
    this.template_id = 502;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestListAcceptedAgreements.register();
