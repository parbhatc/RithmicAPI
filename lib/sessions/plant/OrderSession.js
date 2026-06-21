import { PlantSession } from "./PlantSession.js";
import { InfraType } from "../../../protocol/RequestLogin.js";
import {
  RequestAccountList,
  RequestTradeRoutes,
  RequestSubscribeForOrderUpdates,
  RequestSubscribeToBracketUpdates,
  RequestShowOrders,
  RequestNewOrder,
  RequestModifyOrder,
  RequestCancelOrder,
  RequestCancelAllOrders,
  RequestBracketOrder,
  RequestUpdateTargetBracketLevel,
  RequestUpdateStopBracketLevel,
  RequestShowBrackets,
  RequestShowBracketStops,
  RequestShowOrderHistoryDates,
  RequestShowOrderHistorySummary,
  RequestExitPosition,
  RequestShowFillHistory,
  RequestReplayExecutions,
  RequestProductRmsInfo,
  RequestAccountRmsInfo,
  RequestOrderSessionConfig,
  ResponseAccountList,
  ResponseLoginInfo,
  ResponseOrderSessionConfig,
  ResponseTradeRoute,
  ResponseShowOrders,
  RithmicOrderNotification,
  ExchangeOrderNotification,
  BracketUpdates,
  TradeRoute,
} from "../../../protocol/index.js";
import {
  buildLoginPress,
  buildLoginAccountWave,
} from "../../core/Session.js";
import { UserType } from "../../templates.js";

export class OrderSession extends PlantSession {
  loginInfo = null;
  accounts = [];
  tradeRoutes = [];

  constructor(opts) {
    super({ ...opts, infraType: InfraType.ORDER_PLANT, label: opts.label ?? "order" });
    this.mobileBootstrap = opts.mobileBootstrap ?? false;
  }

  async connect() {
    await super.connect();
    if (this.mobileBootstrap) {
      await this.#mobileBootstrap();
    } else {
      await this.bootstrap();
    }
    return this.login;
  }

  async #mobileBootstrap() {
    const config = await this.exchange(new RequestOrderSessionConfig());
    const serverTag = config.server_tag ?? config.user_msg?.[0];
    if (!serverTag) {
      throw new Error("ResponseOrderSessionConfig missing server_tag");
    }

    const press = buildLoginPress({
      fcm_id: this.login.fcm_id,
      ib_id: this.login.ib_id,
      server_tag: serverTag,
    });
    for (const packet of press) this.send(packet);

    const drained = await this.drain({ idleMs: 800, max: 40 });
    for (const packet of drained) this.#dispatch(packet);

    this.loginInfo = drained.find((p) => p instanceof ResponseLoginInfo) ?? null;
    this.accounts = this.#extractAccounts(drained);
    this.tradeRoutes = drained.filter(
      (p) => p instanceof ResponseTradeRoute || p instanceof TradeRoute,
    );

    for (const account of this.accounts) {
      const wave = buildLoginAccountWave({
        fcm_id: this.login.fcm_id,
        ib_id: this.login.ib_id,
        account_id: account.account_id,
      });
      for (const packet of wave) this.send(packet);
      const more = await this.drain({ idleMs: 400, max: 20 });
      for (const packet of more) this.#dispatch(packet);
    }
    this.#startPump();
  }

  async bootstrap() {
    this.loginInfo = await this.fetchLoginInfo();
    if (this.loginInfo.rp_code?.[0] !== "0") {
      throw new Error(`login info failed: ${this.loginInfo.rp_code?.join(", ")}`);
    }

    this.accounts = await this.listAccounts();
    this.tradeRoutes = await this.listTradeRoutes();
    await this.subscribeOrderUpdates();
    await this.subscribeBracketUpdates();
    this.#startPump();
    return { loginInfo: this.loginInfo, accounts: this.accounts, tradeRoutes: this.tradeRoutes };
  }

  async listAccounts() {
    const userType = this.loginInfo?.user_type ?? UserType.TRADER;
    this.send(
      new RequestAccountList({
        fcm_id: this.login.fcm_id,
        ib_id: this.login.ib_id,
        user_type: userType,
      }),
    );
    const responses = await this.collect({
      idleMs: 600,
      max: 20,
    });
    return this.#extractAccounts(responses);
  }

  #extractAccounts(packets) {
    const accounts = [];
    for (const packet of packets) {
      if (!(packet instanceof ResponseAccountList)) continue;
      const ids = packet.account_id ?? [];
      const names = packet.account_name ?? [];
      for (let i = 0; i < ids.length; i++) {
        accounts.push({
          account_id: ids[i],
          account_name: names[i] ?? ids[i],
          fcm_id: packet.fcm_id ?? this.login.fcm_id,
          ib_id: packet.ib_id ?? this.login.ib_id,
        });
      }
    }
    return accounts;
  }

  async listTradeRoutes({ subscribeForUpdates = true } = {}) {
    await this.exchange(
      new RequestTradeRoutes({ subscribe_for_updates: subscribeForUpdates }),
    );
    const routes = await this.collect({
      idleMs: 600,
      max: 30,
    });
    return routes.filter((p) => p instanceof ResponseTradeRoute || p instanceof TradeRoute);
  }

  async subscribeOrderUpdates({ accountId } = {}) {
    const targets = accountId
      ? this.accounts.filter((a) => a.account_id === accountId)
      : this.accounts;
    for (const account of targets) {
      await this.exchange(
        new RequestSubscribeForOrderUpdates({
          fcm_id: account.fcm_id ?? this.login.fcm_id,
          ib_id: account.ib_id ?? this.login.ib_id,
          account_id: account.account_id,
        }),
      );
    }
  }

  async subscribeBracketUpdates({ accountId } = {}) {
    const targets = accountId
      ? this.accounts.filter((a) => a.account_id === accountId)
      : this.accounts;
    for (const account of targets) {
      await this.exchange(
        new RequestSubscribeToBracketUpdates({
          fcm_id: account.fcm_id ?? this.login.fcm_id,
          ib_id: account.ib_id ?? this.login.ib_id,
          account_id: account.account_id,
        }),
      );
    }
  }

  resolveTradeRoute(exchange) {
    const route = this.tradeRoutes.find((r) => r.exchange === exchange);
    if (!route) throw new Error(`No trade route for exchange ${exchange}`);
    return route.trade_route;
  }

  async listOrders({ accountId, fcm_id, ib_id } = {}) {
    const account_id = accountId ?? this.accounts[0]?.account_id;
    await this.exchange(
      new RequestShowOrders({
        fcm_id: fcm_id ?? this.login.fcm_id,
        ib_id: ib_id ?? this.login.ib_id,
        account_id,
      }),
    );
    return this.collect({
      predicate: (p) => p instanceof ResponseShowOrders,
      idleMs: 800,
      max: 50,
    });
  }

  async placeOrder(data) {
    const trade_route =
      data.trade_route ?? this.resolveTradeRoute(data.exchange);
    return this.exchange(
      new RequestNewOrder({
        fcm_id: data.fcm_id ?? this.login.fcm_id,
        ib_id: data.ib_id ?? this.login.ib_id,
        user_type: data.user_type ?? this.loginInfo?.user_type ?? UserType.TRADER,
        trade_route,
        ...data,
      }),
    );
  }

  async placeBracketOrder(data) {
    const trade_route =
      data.trade_route ?? this.resolveTradeRoute(data.exchange);
    return this.exchange(
      new RequestBracketOrder({
        fcm_id: data.fcm_id ?? this.login.fcm_id,
        ib_id: data.ib_id ?? this.login.ib_id,
        user_type: data.user_type ?? this.loginInfo?.user_type ?? UserType.TRADER,
        trade_route,
        ...data,
      }),
    );
  }

  async modifyOrder(data) {
    return this.exchange(new RequestModifyOrder(data));
  }

  async cancelOrder(data) {
    return this.exchange(new RequestCancelOrder(data));
  }

  async cancelAllOrders({ accountId, manual_or_auto } = {}) {
    return this.exchange(
      new RequestCancelAllOrders({
        account_id: accountId ?? this.accounts[0]?.account_id,
        manual_or_auto,
      }),
    );
  }

  async updateTargetBracket(data) {
    return this.exchange(new RequestUpdateTargetBracketLevel(data));
  }

  async updateStopBracket(data) {
    return this.exchange(new RequestUpdateStopBracketLevel(data));
  }

  async showBrackets(data) {
    return this.exchange(new RequestShowBrackets(data));
  }

  async showBracketStops(data) {
    return this.exchange(new RequestShowBracketStops(data));
  }

  async showOrderHistoryDates() {
    return this.exchange(new RequestShowOrderHistoryDates());
  }

  async showOrderHistorySummary({ date, accountId } = {}) {
    return this.exchange(
      new RequestShowOrderHistorySummary({
        date,
        account_id: accountId ?? this.accounts[0]?.account_id,
      }),
    );
  }

  async exitPosition(data = {}) {
    return this.exchange(
      new RequestExitPosition({
        account_id: data.account_id ?? this.accounts[0]?.account_id,
        ...data,
      }),
    );
  }

  async showFillHistory(data) {
    return this.exchange(new RequestShowFillHistory(data));
  }

  async replayExecutions(data) {
    await this.send(new RequestReplayExecutions(data));
    return this.collect({ idleMs: 800, max: 200, timeoutMs: 30_000 });
  }

  async getAccountRms(data = {}) {
    return this.exchange(
      new RequestAccountRmsInfo({
        fcm_id: data.fcm_id ?? this.login.fcm_id,
        ib_id: data.ib_id ?? this.login.ib_id,
        ...data,
      }),
    );
  }

  async getProductRms(data) {
    return this.exchange(new RequestProductRmsInfo(data));
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
      this.#dispatch(packet);
    }
  }

  #dispatch(packet) {
    if (packet instanceof RithmicOrderNotification) {
      this.emit("rithmicOrder", packet);
      this.emit("order", packet);
      return;
    }
    if (packet instanceof ExchangeOrderNotification) {
      this.emit("exchangeOrder", packet);
      this.emit("order", packet);
      return;
    }
    if (packet instanceof BracketUpdates) {
      this.emit("bracket", packet);
      return;
    }
    if (packet instanceof TradeRoute || packet instanceof ResponseTradeRoute) {
      this.emit("tradeRoute", packet);
      return;
    }
    this.emit("message", packet);
  }
}
