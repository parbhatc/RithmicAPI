import { Packet } from "./Packet.js";
import { ResponseReplayExecutions } from "./ResponseReplayExecutions.js";

export class RequestReplayExecutions extends Packet {
  static MESSAGE_NAME = "RequestReplayExecutions";
  static TEMPLATE_ID = 3506;
  static Response = ResponseReplayExecutions;

  constructor(data = {}) {
    super();
    this.template_id = 3506;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestReplayExecutions.register();
