import { Packet } from "./Packet.js";

export class ResponseLogin extends Packet {
  static MESSAGE_NAME = "ResponseLogin";
  static TEMPLATE_ID = 11;

  constructor() {
    super();
    this.template_id = 11;
    this.template_version = "";
    this.user_msg = [];
    this.rp_code = [];
    this.fcm_id = "";
    this.ib_id = "";
    this.country_code = "";
    this.state_code = "";
    this.unique_user_id = "";
    this.heartbeat_interval = 0;
  }

  get ok() {
    return this.rp_code?.[0] === "0";
  }
}

ResponseLogin.register();
