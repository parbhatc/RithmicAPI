import { Packet } from "./Packet.js";
import { TemplateId } from "../lib/templates.js";

export class ResponseMobileAppConnect extends Packet {
  static MESSAGE_NAME = "ResponseMobileAppConnect";
  static TEMPLATE_ID = TemplateId.RESPONSE_MOBILE_APP_CONNECT;

  constructor() {
    super();
    this.template_id = TemplateId.RESPONSE_MOBILE_APP_CONNECT;
    this.app_name = "";
    this.client_platform = "";
    this.rq_handler_rp_code = [];
    this.app_version = "";
    this.user_msg = [];
  }
}

ResponseMobileAppConnect.register();
