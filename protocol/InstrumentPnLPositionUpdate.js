import { Packet } from "./Packet.js";

export class InstrumentPnLPositionUpdate extends Packet {
  static MESSAGE_NAME = "InstrumentPnLPositionUpdate";
  static TEMPLATE_ID = 450;

  constructor() {
    super();
    this.template_id = 450;
  }
}

InstrumentPnLPositionUpdate.register([100033]);
