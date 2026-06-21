import { Packet } from "./Packet.js";
import { TemplateId } from "../lib/templates.js";

/** One simulator / trade-route row (APEX, RITHMIC, RITHMO, …). */
export class ResponseTradeRoute extends Packet {
  static MESSAGE_NAME = "ResponseTradeRoutes";
  static TEMPLATE_ID = TemplateId.RESPONSE_TRADE_ROUTE;

  constructor() {
    super();
    this.template_id = TemplateId.RESPONSE_TRADE_ROUTE;
    this.exchange = "";
    this.trade_route = "";
    this.status = "";
    this.fcm_id = "";
    this.ib_id = "";
    this.route_id = 0;
    this.rp_code = [];
  }

  get ok() {
    return !this.rp_code?.length || this.rp_code[0] === "0";
  }
}

ResponseTradeRoute.register();
