import { Packet } from "./Packet.js";

export class ResponseRithmicSystemGatewayInfo extends Packet {
  static MESSAGE_NAME = "ResponseRithmicSystemGatewayInfo";
  static TEMPLATE_ID = 21;

  constructor() {
    super();
    this.template_id = 21;
    this.user_msg = [];
    this.rp_code = [];
    this.system_name = "";
    this.gateway_name = [];
    this.gateway_uri = [];
  }

  get ok() {
    return this.rp_code?.[0] === "0";
  }

  getGateways() {
    return this.gateway_name.map((name, i) => ({
      name,
      uri: this.gateway_uri[i] ?? null,
    }));
  }
}

ResponseRithmicSystemGatewayInfo.register();
