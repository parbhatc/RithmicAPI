import { Packet } from "./Packet.js";
import { ResponseHeartbeat } from "./ResponseHeartbeat.js";
import { TemplateId } from "../lib/templates.js";

export class RequestHeartbeat extends Packet {
  static MESSAGE_NAME = "RequestHeartbeat";
  static TEMPLATE_ID = TemplateId.REQUEST_HEARTBEAT;
  static Response = ResponseHeartbeat;

  constructor({ user_msg } = {}) {
    super();
    this.template_id = TemplateId.REQUEST_HEARTBEAT;
    this.user_msg = user_msg ?? [String(Math.floor(Date.now() / 1000))];
  }
}

RequestHeartbeat.register();
