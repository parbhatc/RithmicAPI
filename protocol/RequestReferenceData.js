import { Packet } from "./Packet.js";
import { ResponseReferenceData } from "./ResponseReferenceData.js";

export class RequestReferenceData extends Packet {
  static MESSAGE_NAME = "RequestReferenceData";
  static TEMPLATE_ID = 14;
  static Response = ResponseReferenceData;

  constructor(data = {}) {
    super();
    this.template_id = 14;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestReferenceData.register();
