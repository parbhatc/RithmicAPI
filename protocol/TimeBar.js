import { Packet } from "./Packet.js";

export class TimeBar extends Packet {
  static MESSAGE_NAME = "TimeBar";
  static TEMPLATE_ID = 250;

  constructor() {
    super();
    this.template_id = 250;
  }
}

TimeBar.register();
