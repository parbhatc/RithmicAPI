/**
 * Compare RProtocol tick replay modes (see request_tick_bar_replay.proto).
 *
 *   node --env-file=.env examples/probe-tick-replay-modes.mjs
 */
import { HistoryFetch } from "../index.js";

const user = process.env.RITHMIC_USER;
const password = process.env.RITHMIC_PASSWORD;
if (!user || !password) {
  console.error("Set RITHMIC_USER and RITHMIC_PASSWORD");
  process.exit(1);
}

const FROM = 1780479674.3031738;
const TO = 1780510978.652;
const COUNTBACK = 301;
const refFirstT = 1780479756.332;
const refLastT = 1780510972.267;
const refFirstO = 30757;

const base = {
  user,
  password,
  systemName: process.env.RITHMIC_SYSTEM ?? "LucidTrading",
  uri: process.env.RITHMIC_URI,
  gatewayName: process.env.RITHMIC_GATEWAY,
  symbol: "NQ",
  exchange: "CME",
  resolution: "100T",
  from: FROM,
  to: TO,
  countback: COUNTBACK,
  compat: false,
  timeoutMs: 300_000,
};

const modes = ["to", "from", "spread"];

for (const countbackAnchor of modes) {
  const payload = await HistoryFetch.tickHistory({ ...base, countbackAnchor });
  const n = payload.t.length;
  const dFirst = payload.t[0] - refFirstT;
  const dLast = payload.t.at(-1) - refLastT;
  const dO = payload.o[0] - refFirstO;
  console.log(
    `${countbackAnchor.padEnd(6)} n=${n} firstT d=${dFirst.toFixed(1)} lastT d=${dLast.toFixed(1)} firstO d=${dO.toFixed(1)}`,
  );
}
