import { Packet } from "./Packet.js";
import { TemplateId } from "../lib/templates.js";

export class ResponseLoginInfo extends Packet {
  static MESSAGE_NAME = "ResponseLoginInfo";
  static TEMPLATE_ID = TemplateId.RESPONSE_LOGIN_INFO;

  constructor() {
    super();
    this.template_id = TemplateId.RESPONSE_LOGIN_INFO;
    this.user_msg = [];
    this.rp_code = [];
    this.fcm_id = "";
    this.ib_id = "";
    this.user = "";
    this.first_name = "";
    this.last_name = "";
    this.email_address = "";
    this.user_type = 0;
    this.order_copy_status = "";
    this.country_code = "";
    this.state_code = "";
    this.address_street_1 = "";
    this.address_street_2 = "";
    this.address_city = "";
    this.address_state = "";
    this.address_country = "";
    this.address_zip = "";
    this.phone_residence = "";
    this.phone_work = "";
    this.phone_mobile = "";
    this.tp_max_session_count = 0;
    this.op_max_session_count = 0;
  }

  get ok() {
    return !this.rp_code?.length || this.rp_code[0] === "0";
  }
}

ResponseLoginInfo.register();
