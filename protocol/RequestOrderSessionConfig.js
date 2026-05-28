import { Packet } from "./Packet.js";
import { TemplateId } from "../lib/templates.js";

export class RequestOrderSessionConfig extends Packet {
  static MESSAGE_NAME = "RequestOrderSessionConfig";
  static TEMPLATE_ID = TemplateId.REQUEST_ORDER_SESSION_CONFIG;

  constructor({ user_msg = ["defer"], should_defer_request = true } = {}) {
    super();
    this.template_id = TemplateId.REQUEST_ORDER_SESSION_CONFIG;
    this.user_msg = user_msg;
    this.should_defer_request = should_defer_request;
  }
}

RequestOrderSessionConfig.register();
