import { Packet } from "./Packet.js";

export class AccountPnLPositionUpdate extends Packet {
  static MESSAGE_NAME = "AccountPnLPositionUpdate";
  static TEMPLATE_ID = 451;

  constructor() {
    super();
    this.template_id = 451;
  }
}

AccountPnLPositionUpdate.register();
