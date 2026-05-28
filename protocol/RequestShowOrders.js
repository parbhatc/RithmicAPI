import { Packet } from "./Packet.js";
import { TemplateId } from "../lib/templates.js";

export class RequestShowOrders extends Packet {
  static MESSAGE_NAME = "RequestShowOrders";
  static TEMPLATE_ID = TemplateId.REQUEST_SHOW_ORDERS;

  constructor({ fcm_id, ib_id, account_id } = {}) {
    super();
    this.template_id = TemplateId.REQUEST_SHOW_ORDERS;
    this.user_msg = [];
    this.fcm_id = fcm_id;
    this.ib_id = ib_id;
    this.account_id = account_id;
  }
}

RequestShowOrders.register();
