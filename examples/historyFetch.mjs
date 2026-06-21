#!/usr/bin/env node
/** One-shot history without keeping a session open. */
import { init, HistoryFetch } from "../index.js";
import { credentials, symbolPair } from "./env.mjs";

await init();
const payload = await HistoryFetch.history({
  ...credentials(),
  ...symbolPair(),
  gatewayName: process.env.RITHMIC_GATEWAY ?? "Chicago",
  resolution: process.env.RITHMIC_RESOLUTION ?? 1,
  countback: Number(process.env.RITHMIC_COUNTBACK ?? 50),
});

console.log("status:", payload.s);
console.log("bars:", payload.t?.length ?? 0);
if (payload.t?.length) {
  const i = payload.t.length - 1;
  console.log("last t/o/h/l/c:", payload.t[i], payload.o[i], payload.h[i], payload.l[i], payload.c[i]);
}
