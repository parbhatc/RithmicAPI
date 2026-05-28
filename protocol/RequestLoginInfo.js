import { Packet } from "./Packet.js";
import { ResponseLoginInfo } from "./ResponseLoginInfo.js";
import { TemplateId } from "../lib/templates.js";

/** Assigns this connection to a backend server (user_msg = server tag). */
export class RequestLoginInfo extends Packet {
  static MESSAGE_NAME = "RequestLoginInfo";
  static TEMPLATE_ID = TemplateId.REQUEST_LOGIN_INFO;
  static Response = ResponseLoginInfo;

  /** @param {string} serverTag e.g. rproto_srvr_24_...@rithmic_46_domain:4928 */
  constructor(serverTag) {
    super();
    this.template_id = TemplateId.REQUEST_LOGIN_INFO;
    this.user_msg = [serverTag];
  }
}

RequestLoginInfo.register();
