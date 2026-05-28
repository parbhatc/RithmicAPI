import { Packet } from "./Packet.js";

export class ForcedLogout extends Packet {
  static MESSAGE_NAME = "ForcedLogout";
  static TEMPLATE_ID = 77;

  constructor() {
    super();
    this.template_id = 77;
  }
}

ForcedLogout.register();
