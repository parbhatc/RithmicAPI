import { Packet } from "./Packet.js";
import { TemplateId, UserType } from "../lib/templates.js";

export class RequestAccountList extends Packet {
  static MESSAGE_NAME = "RequestAccountList";
  static TEMPLATE_ID = TemplateId.REQUEST_ACCOUNT_LIST;

  constructor({ fcm_id, ib_id, user_type = UserType.TRADER }) {
    super();
    this.template_id = TemplateId.REQUEST_ACCOUNT_LIST;
    this.user_msg = [];
    this.fcm_id = fcm_id;
    this.ib_id = ib_id;
    this.user_type = user_type;
  }
}

RequestAccountList.register([TemplateId.REQUEST_ACCOUNT_LIST_ALT]);
