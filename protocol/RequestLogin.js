import { Packet } from "./Packet.js";
import { ResponseLogin } from "./ResponseLogin.js";

/** infra_type values for RequestLogin */
export const InfraType = {
  TICKER_PLANT: 1,
  ORDER_PLANT: 2,
  HISTORY_PLANT: 3,
  PNL_PLANT: 4,
};

export class RequestLogin extends Packet {
  static MESSAGE_NAME = "RequestLogin";
  static TEMPLATE_ID = 10;
  static Response = ResponseLogin;

  /**
   * @param {object} data
   * @param {string} data.user
   * @param {string} data.password
   * @param {string} data.system_name
   * @param {number} data.infra_type
   * @param {string} [data.template_version]
   * @param {string} [data.app_name]
   * @param {string} [data.app_version]
   * @param {string[]} [data.user_msg]
   */
  constructor(data) {
    super();
    this.template_id = 10;
    this.user_msg = data.user_msg ?? [];
    this.template_version = data.template_version ?? "3.9";
    this.user = data.user;
    this.password = data.password;
    this.app_name = data.app_name ?? "RithmicAPI";
    this.app_version = data.app_version ?? "1.0.0";
    this.system_name = data.system_name;
    this.infra_type = data.infra_type;
  }
}

RequestLogin.register();
