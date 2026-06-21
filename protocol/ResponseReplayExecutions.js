import { Packet } from "./Packet.js";

export class ResponseReplayExecutions extends Packet {
  static MESSAGE_NAME = "ResponseReplayExecutions";
  static TEMPLATE_ID = 3507;

  constructor() {
    super();
    this.template_id = 3507;
  }
}

ResponseReplayExecutions.register();
