import { Packet } from "./Packet.js";
import { TemplateId } from "../lib/templates.js";

export class RequestTradeRoutes extends Packet {
  static MESSAGE_NAME = "RequestTradeRoutes";
  static TEMPLATE_ID = TemplateId.REQUEST_TRADE_ROUTES;

  constructor({ subscribe_for_updates = false } = {}) {
    super();
    this.template_id = TemplateId.REQUEST_TRADE_ROUTES;
    this.user_msg = [];
    this.subscribe_for_updates = subscribe_for_updates;
  }
}

RequestTradeRoutes.register();
