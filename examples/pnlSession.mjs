#!/usr/bin/env node
/** PnL plant: position snapshot. */
import { init, PnLSession } from "../index.js";

await init();
const pnl = await PnLSession.open({
  user: process.env.RITHMIC_USER,
  password: process.env.RITHMIC_PASSWORD,
  systemName: process.env.RITHMIC_SYSTEM ?? "LucidTrading",
  gatewayName: process.env.RITHMIC_GATEWAY ?? "Chicago",
});

await pnl.fetchLoginInfo();
const snap = await pnl.snapshot();
console.log("snapshot:", snap.constructor.MESSAGE_NAME, snap.rp_code);
await pnl.close();
