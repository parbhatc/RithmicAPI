#!/usr/bin/env node
/** Order plant: accounts + trade routes (login only, no order placed). */
import { init, OrderSession } from "../index.js";
import { credentials } from "./env.mjs";

await init();
const order = await OrderSession.open({
  ...credentials(),
  gatewayName: process.env.RITHMIC_GATEWAY ?? "Chicago",
  mobileBootstrap: process.env.RITHMIC_MOBILE_ORDER === "1",
});

console.log("accounts:", order.accounts);
console.log(
  "trade routes:",
  order.tradeRoutes.map((r) => `${r.exchange} → ${r.trade_route}`),
);
await order.close();
