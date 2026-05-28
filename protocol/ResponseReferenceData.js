import { Packet } from "./Packet.js";

export class ResponseReferenceData extends Packet {
  static MESSAGE_NAME = "ResponseReferenceData";
  static TEMPLATE_ID = 15;

  constructor() {
    super();
    this.template_id = 15;
  }
}

ResponseReferenceData.register();
