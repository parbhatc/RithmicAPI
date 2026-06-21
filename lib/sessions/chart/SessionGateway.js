import { connect, discover } from "../../core/init.js";
import { InfraType } from "../../../protocol/RequestLogin.js";
import { RequestLogin, RequestLoginInfo } from "../../../protocol/index.js";
import { resolvePlants } from "./plantDefaults.js";

export class SessionGateway {
  static WEB_APP = {
    template_version: "2.0",
    app_name: "Rithmic Trader Pro - Web",
    app_version: "2.8.0.0",
  };

  static userMsg(symbol, exchange) {
    return `${symbol}.${exchange}`;
  }

  static hasBit(bits, flag) {
    return ((bits ?? 0) & flag) !== 0;
  }

  static matchesUserMsg(packet, msg) {
    const um = packet.user_msg;
    if (um == null) return false;
    if (Array.isArray(um)) return um.includes(msg) || um[0] === msg;
    return um === msg;
  }

  static async resolveUri({ systemName, uri, gatewayName }) {
    if (uri) return uri;
    const { gateways } = await discover(systemName, { timeoutMs: 45_000, connectRetries: 3 });
    if (gatewayName) {
      const match = gateways.find((g) => g.name.includes(gatewayName));
      if (match) return match.uri;
    }
    const chicago = gateways.find((g) => /chicago/i.test(g.name));
    return (chicago ?? gateways[0]).uri;
  }

  static async loginPlant(client, credentials, infraType) {
    const login = await client.exchange(
      new RequestLogin({
        user: credentials.user,
        password: credentials.password,
        system_name: credentials.systemName,
        infra_type: infraType,
        user_msg: ["new"],
        ...this.WEB_APP,
      }),
    );
    if (!login.ok) {
      throw new Error(`${client.label} login failed: ${login.rp_code?.join(", ")}`);
    }
    await client.exchange(new RequestLoginInfo(login.unique_user_id));
    return login;
  }

  static async connectPlant({ uri, label, credentials, infraType, timeoutMs = 45_000 }) {
    const client = await connect({
      uri,
      label,
      log: false,
      timeoutMs,
      connectRetries: 3,
    });
    await this.loginPlant(client, credentials, infraType);
    return client;
  }

  static async openPlants({
    systemName,
    uri,
    gatewayName,
    user,
    password,
    plants: plantOpts,
  }) {
    const plants = resolvePlants(plantOpts);
    const resolvedUri = await this.resolveUri({ systemName, uri, gatewayName });
    const credentials = { user, password, systemName };
    const out = { uri: resolvedUri, credentials, plants };

    const tasks = [];

    if (plants.ticker) {
      tasks.push(
        this.connectPlant({
          uri: resolvedUri,
          label: "ticker",
          credentials,
          infraType: InfraType.TICKER_PLANT,
        }).then((c) => {
          out.ticker = c;
        }),
      );
    }
    if (plants.history) {
      tasks.push(
        this.connectPlant({
          uri: resolvedUri,
          label: "history",
          credentials,
          infraType: InfraType.HISTORY_PLANT,
          timeoutMs: 180_000,
        }).then((c) => {
          out.history = c;
        }),
      );
    }
    if (plants.order) {
      tasks.push(
        this.connectPlant({
          uri: resolvedUri,
          label: "order",
          credentials,
          infraType: InfraType.ORDER_PLANT,
        }).then((c) => {
          out.order = c;
        }),
      );
    }
    if (plants.pnl) {
      tasks.push(
        this.connectPlant({
          uri: resolvedUri,
          label: "pnl",
          credentials,
          infraType: InfraType.PNL_PLANT,
        }).then((c) => {
          out.pnl = c;
        }),
      );
    }

    await Promise.all(tasks);
    return out;
  }
}
