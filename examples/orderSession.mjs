#!/usr/bin/env node
/** Order plant: accounts + trade routes (login only, no order placed). */
import { init, OrderSession } from "../index.js";

await init();
const order = await OrderSession.open({
  user: process.env.RITHMIC_USER,
  password: process.env.RITHMIC_PASSWORD,
  systemName: process.env.RITHMIC_SYSTEM ?? "LucidTrading",
  gatewayName: process.env.RITHMIC_GATEWAY ?? "Chicago",
  mobileBootstrap: process.env.RITHMIC_MOBILE_ORDER === "1",
});

console.log("accounts:", order.accounts);
console.log(
  "trade routes:",
  order.tradeRoutes.map((r) => `${r.exchange} → ${r.trade_route}`),
);
await order.close();
