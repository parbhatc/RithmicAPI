import { Packet } from "./Packet.js";
import { TemplateId } from "../lib/templates.js";

export class ResponseAccountRmsInfo extends Packet {
  static MESSAGE_NAME = "ResponseAccountRmsInfo";
  static TEMPLATE_ID = TemplateId.RESPONSE_ACCOUNT_RMS_INFO;

  constructor() {
    super();
    this.template_id = TemplateId.RESPONSE_ACCOUNT_RMS_INFO;
    this.user_msg = [];
    this.rq_handler_rp_code = [];
    this.rp_code = [];
    this.fcm_id = "";
    this.ib_id = "";
    this.account_id = "";
    this.account_name = "";
    this.account_currency = "";
    this.account_auto_liquidate = "";
    this.buy_qty = 0;
    this.sell_qty = 0;
    this.order_buy_qty = 0;
    this.order_sell_qty = 0;
    this.fill_buy_qty = 0;
    this.fill_sell_qty = 0;
    this.net_quantity = 0;
    this.open_position_pnl = "";
    this.open_position_quantity = 0;
    this.closed_position_pnl = "";
    this.closed_position_quantity = 0;
    this.open_long_options_value = "";
    this.open_short_options_value = "";
    this.closed_options_value = "";
    this.option_cash_reserved = "";
  }
}

ResponseAccountRmsInfo.register([TemplateId.RESPONSE_ACCOUNT_RMS_INFO_ALT]);
