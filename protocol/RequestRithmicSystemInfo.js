import { Packet } from "./Packet.js";
import { ResponseRithmicSystemInfo } from "./ResponseRithmicSystemInfo.js";

export class RequestRithmicSystemInfo extends Packet {
  static MESSAGE_NAME = "RequestRithmicSystemInfo";
  static TEMPLATE_ID = 16;
  static Response = ResponseRithmicSystemInfo;

  /** @param {{ user_msg?: string[] }} [data] */
  constructor(data = {}) {
    super();
    this.template_id = 16;
    this.user_msg = data.user_msg ?? [];
  }
}

RequestRithmicSystemInfo.register();
