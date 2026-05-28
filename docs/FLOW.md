# Rithmic mobile wire flow

All traffic is `wss://rprotocol-mobile.rithmic.com/` (or regional gateway URLs after discovery).

## Phase A — startup (two sockets in parallel)

| Socket | Send | Receive |
|--------|------|---------|
| **1** | `RequestRithmicSystemGatewayInfo` (20) — `system_name: LucidTrading` | `ResponseRithmicSystemGatewayInfo` (21) — Chicago, Seoul, … |
| **2** | `RequestRithmicSystemInfo` (16) | `ResponseRithmicSystemInfo` (17) — all prop-firm systems |

User picks **LucidTrading** + **Chicago Area** (still the same host in many captures).

## Phase B — Login button (socket 1)

### Send burst (in order)

| # | template_id | Message |
|---|-------------|---------|
| 1 | 3502 | `RequestOrderSessionConfig` — `defer` |
| 2 | 300 | `RequestLoginInfo` — `user_msg` = server tag, e.g. `rproto_srvr_63_ritpz02015@rithmic_46_domain:34241` |
| 3 | 100030 | `RequestAccountList` |
| 4 | 304 | `RequestAccountRmsInfo` |
| 5 | 310 | `RequestTradeRoutes` |
| 6 | 100002 | `RequestMobileAppInfo` — Web / Rithmic Trader |

### Receive (async, many frames)

| template_id | Meaning |
|-------------|---------|
| 3503 | `ResponseOrderSessionConfig` — ack defer (`rp_code: 0`) |
| 100003 | `ResponseMobileAppConnect` — app version 2.8.0.0 |
| 311 | `ResponseTradeRoute` — one row per simulator (APEX, RITHMIC, RITHMO, RITHMO_TEST, …) |
| 100031 | `ResponseAccountRmsInfo` — large RMS snapshot for account |
| 19 | `ResponseHeartbeat` |
| 336–341 | Bracket subscribe + show brackets/stops (after account select) |
| 352 | `ExchangeOrderNotification` — order status / fill / cancel updates |
| 400–401 | PnL plant subscribe ack |
| 100032–100033 | PnL position snapshot request + instrument PnL update |

### Second send wave (account selected)

| template_id | Message |
|-------------|---------|
| 320 | `RequestShowOrders` (often repeated) |
| 308 | `RequestSubscribeForOrderUpdates` |
| 18 | `RequestHeartbeat` |

More `311` acks and RMS/account updates follow.

## Code

```js
import { discover, connect, buildLoginPress, buildLoginAccountWave } from "rithmic-api";

const { gateways } = await discover("LucidTrading");
const client = await connect({ uri: gateways[0].uri, log: true });

client.sendAll(
  buildLoginPress({
    fcm_id: "LucidTrading",
    ib_id: "LucidTrading",
    server_tag: "rproto_srvr_63_ritpz02015@rithmic_46_domain:34241",
  }),
);

const batch1 = await client.drain({ idleMs: 800, max: 50 });
// batch1: ResponseOrderSessionConfig, ResponseMobileAppConnect, ResponseTradeRoute×4, …

client.sendAll(
  buildLoginAccountWave({
    fcm_id: "LucidTrading",
    ib_id: "LucidTrading",
    account_id: "LFE025-I1DN5A30-TEST001",
  }),
);

const batch2 = await client.drain({ idleMs: 800, max: 50 });
```

Decode any frame: `npm run decode -- <base64>`
