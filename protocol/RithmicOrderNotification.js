import { Packet } from "./Packet.js";

export class RithmicOrderNotification extends Packet {
  static MESSAGE_NAME = "RithmicOrderNotification";
  static TEMPLATE_ID = 351;

  constructor() {
    super();
    this.template_id = 351;
  }
}

RithmicOrderNotification.register();
