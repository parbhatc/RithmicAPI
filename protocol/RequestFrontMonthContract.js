import { Packet } from "./Packet.js";
import { ResponseFrontMonthContract } from "./ResponseFrontMonthContract.js";

export class RequestFrontMonthContract extends Packet {
  static MESSAGE_NAME = "RequestFrontMonthContract";
  static TEMPLATE_ID = 113;
  static Response = ResponseFrontMonthContract;

  constructor(data = {}) {
    super();
    this.template_id = 113;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestFrontMonthContract.register();
