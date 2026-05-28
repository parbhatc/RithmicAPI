import { Packet } from "./Packet.js";
import { TemplateId } from "../lib/templates.js";

export class RequestMobileAppInfo extends Packet {
  static MESSAGE_NAME = "RequestMobileAppInfo";
  static TEMPLATE_ID = TemplateId.REQUEST_MOBILE_APP_INFO;

  constructor({
    client_platform = "Web",
    app_name = "Rithmic Trader",
    user_msg = ["Web"],
  } = {}) {
    super();
    this.template_id = TemplateId.REQUEST_MOBILE_APP_INFO;
    this.client_platform = client_platform;
    this.app_name = app_name;
    this.user_msg = user_msg;
  }
}

RequestMobileAppInfo.register();
