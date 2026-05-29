import { Packet } from "./Packet.js";

export class BestBidOffer extends Packet {
  static MESSAGE_NAME = "BestBidOffer";
  static TEMPLATE_ID = 151;

  constructor() {
    super();
    this.template_id = 151;
    this.symbol = "";
    this.exchange = "";
    this.bid_price = 0;
    this.bid_size = 0;
    this.bid_orders = 0;
    this.bid_implicit_size = 0;
    this.ask_price = 0;
    this.ask_size = 0;
    this.ask_orders = 0;
    this.ask_implicit_size = 0;
    this.lean_price = 0;
  }
}

BestBidOffer.register();
