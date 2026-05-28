import { Packet } from "./Packet.js";

export class RequestPnLPositionSnapshot extends Packet {
  static MESSAGE_NAME = "RequestPnLPositionSnapshot";
  static TEMPLATE_ID = 100032;

  constructor(data = {}) {
    super();
    this.template_id = 100032;
    this.user_msg = data.user_msg ?? [];
    if (data) this.applyObject(data);
  }
}

RequestPnLPositionSnapshot.register();
