import { Packet } from "./Packet.js";
import { TemplateId } from "../lib/templates.js";

export class ResponseHeartbeat extends Packet {
  static MESSAGE_NAME = "ResponseHeartbeat";
  static TEMPLATE_ID = TemplateId.RESPONSE_HEARTBEAT;

  constructor() {
    super();
    this.template_id = TemplateId.RESPONSE_HEARTBEAT;
    this.user_msg = [];
    this.rp_code = [];
  }

  get ok() {
    return !this.rp_code?.length || this.rp_code[0] === "0";
  }
}

ResponseHeartbeat.register();
