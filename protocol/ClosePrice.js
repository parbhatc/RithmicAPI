import { Packet } from "./Packet.js";

export class ClosePrice extends Packet {
  /** Wire template 155; schema is `rti.EndOfDayPrices` in end_of_day_prices.proto. */
  static MESSAGE_NAME = "EndOfDayPrices";
  static TEMPLATE_ID = 155;

  constructor() {
    super();
    this.template_id = 155;
  }
}

ClosePrice.register();
