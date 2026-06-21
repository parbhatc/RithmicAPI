import {
  RequestOrderSessionConfig,
  RequestLoginInfo,
  RequestAccountList,
  RequestAccountRmsInfo,
  RequestTradeRoutes,
  RequestMobileAppInfo,
  RequestShowOrders,
  RequestSubscribeForOrderUpdates,
  RequestHeartbeat,
} from "../../protocol/index.js";

export function buildLoginPress({ fcm_id, ib_id, server_tag }) {
  if (!server_tag) {
    throw new Error("server_tag required (from ResponseOrderSessionConfig / login flow)");
  }

  return [
    new RequestOrderSessionConfig(),
    new RequestLoginInfo(server_tag),
    new RequestAccountList({ fcm_id, ib_id }),
    new RequestAccountRmsInfo({ fcm_id, ib_id }),
    new RequestTradeRoutes({ subscribe_for_updates: false }),
    new RequestMobileAppInfo(),
  ];
}

export function buildLoginAccountWave({ fcm_id, ib_id, account_id }) {
  return [
    new RequestShowOrders({ fcm_id, ib_id, account_id }),
    new RequestSubscribeForOrderUpdates({ fcm_id, ib_id, account_id }),
    new RequestShowOrders({ fcm_id, ib_id, account_id }),
    new RequestSubscribeForOrderUpdates({ fcm_id, ib_id, account_id }),
    new RequestHeartbeat(),
  ];
}

/** @deprecated use buildLoginPress */
export function buildOrderPlantHandshake(opts) {
  return [...buildLoginPress(opts), ...buildLoginAccountWave(opts)];
}

/** @deprecated */
export function buildOrderPlantSideChannel({ server_tag }) {
  return [new RequestLoginInfo(server_tag), new RequestHeartbeat()];
}
