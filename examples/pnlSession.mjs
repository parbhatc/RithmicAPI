#!/usr/bin/env node
/** PnL plant: position snapshot. */
import { init, PnLSession } from "../index.js";
import { credentials } from "./env.mjs";

await init();
const pnl = await PnLSession.open({
  ...credentials(),
  gatewayName: process.env.RITHMIC_GATEWAY ?? "Chicago",
});

await pnl.fetchLoginInfo();
const snap = await pnl.snapshot();
console.log("snapshot:", snap.constructor.MESSAGE_NAME, snap.rp_code);
await pnl.close();
