/**
 * Fast 1m-only parity check — prints connect time immediately, then each step.
 *
 *   node --env-file=.env examples/compare-1m-fast.mjs
 *   FORMING_1M_DEBUG=1 node --env-file=.env examples/compare-1m-fast.mjs
 *   node --env-file=.env examples/debug-1m-forming.mjs
 */
import {
  ChartSession,
  FormingBarManager,
  bootstrapRithmicAccuracy,
  fetchTradeSeaReference,
} from "../index.js";

const t0 = performance.now();
const step = (label) =>
  console.log(`+${((performance.now() - t0) / 1000).toFixed(1)}s  ${label}`);

step("connecting Rithmic…");
const chart = await ChartSession.open({
  user: process.env.RITHMIC_USER,
  password: process.env.RITHMIC_PASSWORD,
  systemName: process.env.RITHMIC_SYSTEM ?? "LucidTrading",
  symbol: process.env.RITHMIC_SYMBOL ?? "NQ",
  exchange: process.env.RITHMIC_EXCHANGE ?? "CME",
  uri: process.env.RITHMIC_URI,
});
step("Rithmic connected");

const mgr = new FormingBarManager(chart);
step("bootstrap 1m only…");
await bootstrapRithmicAccuracy(mgr, { resolutions: [1], timeoutMs: 30_000 });
step("bootstrap done");

const snapSec = Math.floor(Date.now() / 1000);
await mgr.refreshCurrent1m(snapSec);
mgr.syncFromLastTrade();
step("1m refresh done");

step("TradeSea ref…");
const ref = await fetchTradeSeaReference({
  accessToken: process.env.TRADESEA_ACCESS_TOKEN,
  refreshToken: process.env.TRADESEA_REFRESH_TOKEN,
  connectionUserId: process.env.TRADESEA_CONNECTION_USER_ID,
  connectionGroupId: process.env.TRADESEA_CONNECTION_GROUP_ID,
  streamSymbol: process.env.TRADESEA_STREAM_SYMBOL ?? "CME:NQ",
  resolutions: [1],
  waitForWsMs: 3000,
  waitForMarketMs: 2000,
});
step("TradeSea ref done");

const ours = mgr.getForming(1);
const ts = ref.forming.get("1") ?? ref.forming.get("1M");
const fmt = (n) => Number(n).toFixed(2);
const TOL = 0.01;
const ok = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= TOL;

console.log("\n=== 1m forming ===");
console.log(
  `TradeSea  t=${ts ? new Date(ts.marker * 1000).toLocaleTimeString() : "—"}  O ${fmt(ts?.open)} H ${fmt(ts?.high)} L ${fmt(ts?.low)} C ${fmt(ts?.close)}`,
);
console.log(
  `Rithmic   t=${ours ? new Date(ours.marker * 1000).toLocaleTimeString() : "—"}  O ${fmt(ours?.open)} H ${fmt(ours?.high)} L ${fmt(ours?.low)} C ${fmt(ours?.close)}  [${ours?.replaySource ?? "?"}]`,
);
if (ours && ts) {
  for (const k of ["open", "high", "low", "close"]) {
    if (!ok(ours[k], ts[k])) console.log(`  ${k} Δ${(Number(ours[k]) - Number(ts[k])).toFixed(2)}`);
  }
  if (ok(ours.open, ts.open) && ok(ours.high, ts.high) && ok(ours.low, ts.low) && ok(ours.close, ts.close)) {
    console.log("  ✓ exact match");
  }
}

step("total");
await ref.close();
await mgr.detachLive?.();
chart.close();
