import { Packet } from "./Packet.js";
import { ResponseListExchangePermissions } from "./ResponseListExchangePermissions.js";

export class RequestListExchangePermissions extends Packet {
  static MESSAGE_NAME = "RequestListExchangePermissions";
  static TEMPLATE_ID = 342;
  static Response = ResponseListExchangePermissions;

  constructor(data = {}) {
    super();
    this.template_id = 342;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestListExchangePermissions.register();
