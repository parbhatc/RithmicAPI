import { Packet } from "./Packet.js";

export class ResponseProductRmsInfo extends Packet {
  static MESSAGE_NAME = "ResponseProductRmsInfo";
  static TEMPLATE_ID = 307;

  constructor() {
    super();
    this.template_id = 307;
  }
}

ResponseProductRmsInfo.register();
