import { Packet } from "./Packet.js";
import { ResponseProductRmsInfo } from "./ResponseProductRmsInfo.js";

export class RequestProductRmsInfo extends Packet {
  static MESSAGE_NAME = "RequestProductRmsInfo";
  static TEMPLATE_ID = 306;
  static Response = ResponseProductRmsInfo;

  constructor(data = {}) {
    super();
    this.template_id = 306;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestProductRmsInfo.register();
