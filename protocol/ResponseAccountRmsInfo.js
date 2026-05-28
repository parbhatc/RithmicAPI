import { Packet } from "./Packet.js";
import { TemplateId } from "../lib/templates.js";

export class ResponseAccountRmsInfo extends Packet {
  static MESSAGE_NAME = "ResponseAccountRmsInfo";
  static TEMPLATE_ID = TemplateId.RESPONSE_ACCOUNT_RMS_INFO;

  constructor() {
    super();
    this.template_id = TemplateId.RESPONSE_ACCOUNT_RMS_INFO;
    this.user_msg = [];
    this.rq_handler_rp_code = [];
    this.rp_code = [];
  }
}

ResponseAccountRmsInfo.register([TemplateId.RESPONSE_ACCOUNT_RMS_INFO_ALT]);
