import { Packet } from "./Packet.js";

export class BestBidOffer extends Packet {
  static MESSAGE_NAME = "BestBidOffer";
  static TEMPLATE_ID = 151;

  constructor() {
    super();
    this.template_id = 151;
  }
}

BestBidOffer.register();
