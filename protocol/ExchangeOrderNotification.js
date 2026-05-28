import { Packet } from "./Packet.js";

export class ExchangeOrderNotification extends Packet {
  static MESSAGE_NAME = "ExchangeOrderNotification";
  static TEMPLATE_ID = 352;

  constructor() {
    super();
    this.template_id = 352;
  }
}

ExchangeOrderNotification.register();
