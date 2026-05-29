import { Packet } from "./Packet.js";

export class LastTrade extends Packet {
  static MESSAGE_NAME = "LastTrade";
  static TEMPLATE_ID = 150;

  constructor() {
    super();
    this.template_id = 150;
    this.symbol = "";
    this.exchange = "";
    this.trade_price = 0;
    this.trade_size = 0;
    this.volume = 0;
    this.net_change = 0;
    this.percent_change = 0;
    this.vwap = 0;
    this.ssboe = 0;
    this.usecs = 0;
    this.source_ssboe = 0;
    this.source_usecs = 0;
    this.source_nsecs = 0;
    this.jop_ssboe = 0;
    this.jop_nsecs = 0;
  }
}

LastTrade.register();
