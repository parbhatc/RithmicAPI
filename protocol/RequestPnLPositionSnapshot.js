import { Packet } from "./Packet.js";
import { ResponsePnLPositionSnapshot } from "./ResponsePnLPositionSnapshot.js";

export class RequestPnLPositionSnapshot extends Packet {
  static MESSAGE_NAME = "RequestPnLPositionSnapshot";
  static TEMPLATE_ID = 402;
  static Response = ResponsePnLPositionSnapshot;

  constructor(data = {}) {
    super();
    this.template_id = 402;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestPnLPositionSnapshot.register([100032]);
