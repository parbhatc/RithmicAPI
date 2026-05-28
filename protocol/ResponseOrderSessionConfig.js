import { Packet } from "./Packet.js";
import { TemplateId } from "../lib/templates.js";

export class ResponseOrderSessionConfig extends Packet {
  static MESSAGE_NAME = "ResponseOrderSessionConfig";
  static TEMPLATE_ID = TemplateId.RESPONSE_ORDER_SESSION_CONFIG;

  constructor() {
    super();
    this.template_id = TemplateId.RESPONSE_ORDER_SESSION_CONFIG;
    this.user_msg = [];
    this.rp_code = [];
  }

  get ok() {
    return !this.rp_code?.length || this.rp_code[0] === "0";
  }
}

ResponseOrderSessionConfig.register();
