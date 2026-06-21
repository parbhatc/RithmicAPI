import { connect, discover } from "../../init.js";
import { InfraType } from "../../protocol/RequestLogin.js";
import { RequestLogin, RequestLoginInfo } from "../../protocol/index.js";

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

  static async openPlants({ systemName, symbol, exchange, uri, gatewayName, user, password }) {
    const resolvedUri = await this.resolveUri({ systemName, uri, gatewayName });
    const credentials = { user, password, systemName };

    const ticker = await connect({
      uri: resolvedUri,
      label: "ticker",
      log: false,
      timeoutMs: 45_000,
      connectRetries: 3,
    });
    const history = await connect({
      uri: resolvedUri,
      label: "history",
      log: false,
      timeoutMs: 180_000,
    });

    await this.loginPlant(ticker, credentials, InfraType.TICKER_PLANT);
    await this.loginPlant(history, credentials, InfraType.HISTORY_PLANT);

    return { ticker, history, uri: resolvedUri, credentials };
  }
}
