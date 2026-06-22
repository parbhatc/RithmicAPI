import { connect, discover } from "../../core/init.js";
import { InfraType } from "../../../protocol/RequestLogin.js";
import { RequestLogin, RequestLoginInfo } from "../../../protocol/index.js";
import { resolvePlants } from "./plantDefaults.js";
import { resolveLog } from "../../util.js";

function isSessionLimitError(err) {
  const msg = String(err?.message ?? err);
  return /permission denied|\b13\b|1011/.test(msg);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

  static async resolveUri({ systemName, uri, gatewayName, log }) {
    if (uri) {
      if (log) console.log(`[gateway] ${uri}`);
      return uri;
    }
    const { gateways } = await discover(systemName, { timeoutMs: 45_000, connectRetries: 3 });
    let picked;
    if (gatewayName) {
      picked = gateways.find((g) => g.name.includes(gatewayName));
    }
    if (!picked) {
      picked = gateways.find((g) => /chicago/i.test(g.name)) ?? gateways[0];
    }
    if (log) console.log(`[gateway] ${picked.name} → ${picked.uri}`);
    return picked.uri;
  }

  static async loginPlant(client, credentials, infraType, debug) {
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
    if (debug) console.log(`[${client.label}] logged in`);
    await client.exchange(new RequestLoginInfo(login.unique_user_id));
    return login;
  }

  static async connectPlant({
    uri,
    label,
    credentials,
    infraType,
    timeoutMs = 45_000,
    debug,
    wireLog,
    wireSniffer,
  }) {
    const backoffMs = [0, 5_000, 10_000, 20_000];
    let lastErr;

    for (const delay of backoffMs) {
      if (delay > 0) {
        if (debug) {
          console.log(`[${label}] prior session still active, retry in ${delay}ms…`);
        }
        await sleep(delay);
      }

      let client;
      try {
        if (debug) console.log(`[${label}] connecting…`);
        client = await connect({
          uri,
          label,
          log: wireLog,
          wireSniffer,
          timeoutMs,
          connectRetries: 3,
        });
        if (debug) console.log(`[${label}] connected`);
        await this.loginPlant(client, credentials, infraType, debug);
        return client;
      } catch (err) {
        lastErr = err;
        client?.close();
        if (!isSessionLimitError(err)) throw err;
      }
    }

    throw lastErr;
  }

  static async openPlants({
    systemName,
    uri,
    gatewayName,
    user,
    password,
    plants: plantOpts,
    log: logOpt,
    wireLog,
    wireSniffer,
  }) {
    const plants = resolvePlants(plantOpts);
    const debug = resolveLog(logOpt);
    const resolvedUri = await this.resolveUri({ systemName, uri, gatewayName, log: debug });
    const credentials = { user, password, systemName };
    const out = { uri: resolvedUri, credentials, plants };

    if (debug) {
      const enabled = Object.entries(plants)
        .filter(([, on]) => on)
        .map(([name]) => name)
        .join(", ");
      console.log(`[gateway] plants: ${enabled}`);
    }

    const tasks = [];
    const connectOpts = { debug, wireLog, wireSniffer };

    if (plants.ticker) {
      tasks.push(
        this.connectPlant({
          uri: resolvedUri,
          label: "ticker",
          credentials,
          infraType: InfraType.TICKER_PLANT,
          ...connectOpts,
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
          ...connectOpts,
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
          ...connectOpts,
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
          ...connectOpts,
        }).then((c) => {
          out.pnl = c;
        }),
      );
    }

    await Promise.all(tasks);
    return out;
  }
}
