import { EventEmitter } from "node:events";
import { connect, init } from "../../core/init.js";
import { InfraType, RequestLogin } from "../../../protocol/RequestLogin.js";
import {
  RequestLoginInfo,
  RequestLogout,
  RequestHeartbeat,
} from "../../../protocol/index.js";
import { SessionGateway } from "../chart/SessionGateway.js";

export class PlantSession extends EventEmitter {
  constructor({
    uri,
    credentials,
    infraType,
    label,
    log = false,
    timeoutMs = 45_000,
    connectRetries = 3,
  }) {
    super();
    this.uri = uri;
    this.credentials = credentials;
    this.infraType = infraType;
    this.label = label ?? InfraType.nameFor?.(infraType) ?? `plant-${infraType}`;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.connectRetries = connectRetries;
    this.client = null;
    this.login = null;
  }

  static async open({
    systemName,
    user,
    password,
    uri,
    gatewayName,
    infraType,
    label,
    log,
    timeoutMs,
    connectRetries,
  }) {
    const resolvedUri =
      uri ?? (await SessionGateway.resolveUri({ systemName, gatewayName }));
    const session = new this({
      uri: resolvedUri,
      credentials: { user, password, systemName },
      infraType,
      label,
      log,
      timeoutMs,
      connectRetries,
    });
    await session.connect();
    return session;
  }

  async connect() {
    await init();
    this.client = await connect({
      uri: this.uri,
      label: this.label,
      log: this.log,
      timeoutMs: this.timeoutMs,
      connectRetries: this.connectRetries,
    });
    this.login = await this.client.exchange(
      new RequestLogin({
        user: this.credentials.user,
        password: this.credentials.password,
        system_name: this.credentials.systemName,
        infra_type: this.infraType,
        user_msg: ["new"],
        ...SessionGateway.WEB_APP,
      }),
    );
    if (!this.login.ok) {
      throw new Error(
        `${this.label} login failed: ${this.login.rp_code?.join(", ")}`,
      );
    }
    this.emit("login", this.login);
    return this.login;
  }

  /** Standard post-login info request (template 300). */
  async fetchLoginInfo(userMsg = ["hello"]) {
    const info = await this.exchange(
      new RequestLoginInfo(
        typeof userMsg === "string" ? userMsg : { user_msg: userMsg },
      ),
    );
    this.emit("loginInfo", info);
    return info;
  }

  send(packet) {
    return this.client.send(packet);
  }

  exchange(packet, opts) {
    return this.client.exchange(packet, opts);
  }

  receive() {
    return this.client.receive();
  }

  drain(opts) {
    return this.client.drain(opts);
  }

  async heartbeat() {
    return this.exchange(new RequestHeartbeat());
  }

  /**
   * Collect responses until `predicate` returns true, idle timeout, or `max` packets.
   */
  async collect({ predicate, idleMs = 500, max = 100, timeoutMs } = {}) {
    const saved = this.client.timeoutMs;
    this.client.timeoutMs = idleMs;
    const out = [];
    const deadline = timeoutMs ? Date.now() + timeoutMs : null;

    try {
      while (out.length < max) {
        if (deadline && Date.now() > deadline) break;
        try {
          const packet = await this.client.receive();
          out.push(packet);
          this.emit("message", packet);
          if (predicate?.(packet, out)) break;
        } catch {
          break;
        }
      }
    } finally {
      this.client.timeoutMs = saved;
    }
    return out;
  }

  async close() {
    if (!this.client) return;
    try {
      await this.exchange(new RequestLogout());
    } catch {
      /* ignore */
    }
    this.client.close();
    this.client = null;
    this.emit("close");
  }
}

InfraType.nameFor = (value) => {
  const entry = Object.entries(InfraType).find(([, v]) => v === value);
  return entry?.[0]?.toLowerCase().replace(/_plant$/, "") ?? String(value);
};
