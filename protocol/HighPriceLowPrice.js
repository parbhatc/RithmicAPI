import { Packet } from "./Packet.js";

export class HighPriceLowPrice extends Packet {
  /** Wire template 152; schema is `rti.TradeStatistics` in trade_statistics.proto. */
  static MESSAGE_NAME = "TradeStatistics";
  static TEMPLATE_ID = 152;

  constructor() {
    super();
    this.template_id = 152;
  }
}

HighPriceLowPrice.register();
