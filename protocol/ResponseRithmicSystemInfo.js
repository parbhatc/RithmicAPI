import { Packet } from "./Packet.js";

export class ResponseRithmicSystemInfo extends Packet {
  static MESSAGE_NAME = "ResponseRithmicSystemInfo";
  static TEMPLATE_ID = 17;

  constructor() {
    super();
    this.template_id = 17;
    this.user_msg = [];
    this.rp_code = [];
    this.system_name = [];
    this.has_aggregated_quotes = [];
  }

  get ok() {
    return this.rp_code?.[0] === "0";
  }
}

ResponseRithmicSystemInfo.register();
