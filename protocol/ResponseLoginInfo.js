import { Packet } from "./Packet.js";
import { TemplateId } from "../lib/templates.js";

export class ResponseLoginInfo extends Packet {
  static MESSAGE_NAME = "ResponseLoginInfo";
  static TEMPLATE_ID = TemplateId.RESPONSE_LOGIN_INFO;

  constructor() {
    super();
    this.template_id = TemplateId.RESPONSE_LOGIN_INFO;
    this.user_msg = [];
    this.rp_code = [];
    this.fcm_id = "";
    this.ib_id = "";
    this.user_type = 0;
  }

  get ok() {
    return !this.rp_code?.length || this.rp_code[0] === "0";
  }
}

ResponseLoginInfo.register();
