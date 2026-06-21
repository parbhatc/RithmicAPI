import { PlantSession } from "./PlantSession.js";
import { InfraType } from "../../../protocol/RequestLogin.js";
import {
  RequestPnLPositionUpdates,
  RequestPnLPositionSnapshot,
  InstrumentPnLPositionUpdate,
  AccountPnLPositionUpdate,
} from "../../../protocol/index.js";

export class PnLSession extends PlantSession {
  constructor(opts) {
    super({ ...opts, infraType: InfraType.PNL_PLANT, label: opts.label ?? "pnl" });
  }

  async connect() {
    await super.connect();
    await this.fetchLoginInfo();
    this.#startPump();
    return this.login;
  }

  async subscribeUpdates({ accountId, fcm_id, ib_id } = {}) {
    return this.exchange(
      new RequestPnLPositionUpdates({
        request: 1,
        fcm_id: fcm_id ?? this.login.fcm_id,
        ib_id: ib_id ?? this.login.ib_id,
        account_id: accountId,
      }),
    );
  }

  async unsubscribeUpdates({ accountId, fcm_id, ib_id } = {}) {
    return this.exchange(
      new RequestPnLPositionUpdates({
        request: 2,
        fcm_id: fcm_id ?? this.login.fcm_id,
        ib_id: ib_id ?? this.login.ib_id,
        account_id: accountId,
      }),
    );
  }

  async snapshot({ accountId, fcm_id, ib_id } = {}) {
    return this.exchange(
      new RequestPnLPositionSnapshot({
        fcm_id: fcm_id ?? this.login.fcm_id,
        ib_id: ib_id ?? this.login.ib_id,
        account_id: accountId,
      }),
    );
  }

  #pump = null;

  #startPump() {
    if (this.#pump) return;
    this.#pump = this.#runPump();
  }

  async #runPump() {
    while (this.client?.ws?.readyState === 1) {
      let packet;
      try {
        packet = await this.receive();
      } catch {
        break;
      }
      if (packet instanceof InstrumentPnLPositionUpdate) {
        this.emit("instrument", packet);
        this.emit("position", packet);
      } else if (packet instanceof AccountPnLPositionUpdate) {
        this.emit("account", packet);
        this.emit("position", packet);
      } else {
        this.emit("message", packet);
      }
    }
  }
}
