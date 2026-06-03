/**
 * Replay 100-tick NQ bars with the same chart query shape as Lucid/TradingView:
 *   symbol=CME:NQ&resolution=100T&from=...&to=...&countback=301
 *
 * Run: npm run example:match-100t
 */
import { fetchTickHistory } from "../index.js";

const user = process.env.RITHMIC_USER;
const password = process.env.RITHMIC_PASSWORD;
if (!user || !password) {
  console.error("Set RITHMIC_USER and RITHMIC_PASSWORD in .env");
  process.exit(1);
}

const FROM = 1780479674.3031738;
const TO = 1780510978.652;
const COUNTBACK = 301;
const RESOLUTION = "100T";

const countbackAnchor = process.env.COUNTBACK_ANCHOR ?? "to";

const payload = await fetchTickHistory({
  user,
  password,
  systemName: process.env.RITHMIC_SYSTEM ?? "LucidTrading",
  uri: process.env.RITHMIC_URI,
  gatewayName: process.env.RITHMIC_GATEWAY,
  symbol: process.env.RITHMIC_SYMBOL ?? "NQ",
  exchange: process.env.RITHMIC_EXCHANGE ?? "CME",
  resolution: RESOLUTION,
  from: FROM,
  to: TO,
  countback: COUNTBACK,
  countbackAnchor,
  compat: false,
  timeoutMs: 300_000,
});

console.log("countbackAnchor:", countbackAnchor);

console.log("status:", payload.s);
console.log("bars:", payload.t.length, "(expected", COUNTBACK, ")");
console.log("first t:", payload.t[0]);
console.log("last t:", payload.t[payload.t.length - 1]);
console.log(
  "first OHLC:",
  payload.o[0],
  payload.h[0],
  payload.l[0],
  payload.c[0],
  "v:",
  payload.v[0],
);
console.log(
  "last OHLC:",
  payload.o.at(-1),
  payload.h.at(-1),
  payload.l.at(-1),
  payload.c.at(-1),
  "v:",
  payload.v.at(-1),
);

// Reference from external chart API (first/last for quick diff)
const refFirstT = 1780479756.332;
const refLastT = 1780510972.267;
const refFirstO = 30757;
console.log("\nreference first t:", refFirstT, "delta:", payload.t[0] - refFirstT);
console.log("reference last t:", refLastT, "delta:", payload.t.at(-1) - refLastT);
console.log("reference first o:", refFirstO, "delta:", payload.o[0] - refFirstO);

if (payload.t.length !== COUNTBACK) {
  process.exitCode = 1;
}
