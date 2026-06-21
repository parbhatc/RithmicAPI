import { Packet } from "./Packet.js";
import { ResponseSearchSymbols } from "./ResponseSearchSymbols.js";

export class RequestSearchSymbols extends Packet {
  static MESSAGE_NAME = "RequestSearchSymbols";
  static TEMPLATE_ID = 109;
  static Response = ResponseSearchSymbols;

  constructor(data = {}) {
    super();
    this.template_id = 109;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestSearchSymbols.register();
