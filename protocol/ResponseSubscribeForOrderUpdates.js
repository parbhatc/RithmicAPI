import { Packet } from "./Packet.js";

export class ResponseSubscribeForOrderUpdates extends Packet {
  static MESSAGE_NAME = "ResponseSubscribeForOrderUpdates";
  static TEMPLATE_ID = 309;

  constructor() {
    super();
    this.template_id = 309;
  }
}

ResponseSubscribeForOrderUpdates.register();
