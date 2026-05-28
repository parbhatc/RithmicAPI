import { Packet } from "./Packet.js";
import { TemplateId } from "../lib/templates.js";

export class RequestSubscribeForOrderUpdates extends Packet {
  static MESSAGE_NAME = "RequestSubscribeForOrderUpdates";
  static TEMPLATE_ID = TemplateId.REQUEST_SUBSCRIBE_ORDER_UPDATES;

  constructor({ fcm_id, ib_id, account_id } = {}) {
    super();
    this.template_id = TemplateId.REQUEST_SUBSCRIBE_ORDER_UPDATES;
    this.user_msg = [];
    this.fcm_id = fcm_id;
    this.ib_id = ib_id;
    this.account_id = account_id;
  }
}

RequestSubscribeForOrderUpdates.register();
