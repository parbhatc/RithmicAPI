import { Packet } from "./Packet.js";
import { ResponseLoginInfo } from "./ResponseLoginInfo.js";
import { TemplateId } from "../lib/templates.js";

/** Assigns this connection to a backend server (user_msg = server tag). */
export class RequestLoginInfo extends Packet {
  static MESSAGE_NAME = "RequestLoginInfo";
  static TEMPLATE_ID = TemplateId.REQUEST_LOGIN_INFO;
  static Response = ResponseLoginInfo;

  /** @param {string | { user_msg?: string[] }} serverTagOrOpts */
  constructor(serverTagOrOpts) {
    super();
    this.template_id = TemplateId.REQUEST_LOGIN_INFO;
    if (typeof serverTagOrOpts === "string") {
      this.user_msg = [serverTagOrOpts];
    } else {
      this.user_msg = serverTagOrOpts?.user_msg ?? ["hello"];
    }
  }
}

RequestLoginInfo.register();
