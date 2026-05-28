import { Packet } from "./Packet.js";
import { ResponseRithmicSystemGatewayInfo } from "./ResponseRithmicSystemGatewayInfo.js";

export class RequestRithmicSystemGatewayInfo extends Packet {
  static MESSAGE_NAME = "RequestRithmicSystemGatewayInfo";
  static TEMPLATE_ID = 20;
  static Response = ResponseRithmicSystemGatewayInfo;

  /**
   * @param {object} data
   * @param {string} data.system_name
   * @param {string[]} [data.user_msg]
   */
  constructor(data = {}) {
    super();
    this.template_id = 20;
    this.system_name = data.system_name ?? "";
    this.user_msg = data.user_msg ?? (data.system_name ? [data.system_name] : []);
  }
}

RequestRithmicSystemGatewayInfo.register();
