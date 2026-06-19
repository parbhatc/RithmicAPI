/**
 * Trace how the 1m forming candle is built (bootstrap → refresh → compare).
 *
 *   node --env-file=.env examples/debug-1m-forming.mjs
 *   FORMING_1M_DEBUG=1 node --env-file=.env examples/compare-1m-fast.mjs
 */
import {
  ChartSession,
  FormingBarManager,
  bootstrapRithmicAccuracy,
  fetchTradeSeaReference,
} from "../index.js";

process.env.FORMING_1M_DEBUG = "1";

console.log("=== 1m forming build trace (FORMING_1M_DEBUG=1) ===\n");

const chart = await ChartSession.open({
  user: process.env.RITHMIC_USER,
  password: process.env.RITHMIC_PASSWORD,
  systemName: process.env.RITHMIC_SYSTEM ?? "LucidTrading",
  symbol: process.env.RITHMIC_SYMBOL ?? "NQ",
  exchange: process.env.RITHMIC_EXCHANGE ?? "CME",
  uri: process.env.RITHMIC_URI,
});

const mgr = new FormingBarManager(chart);
console.log("\n── bootstrap [1] accuracy=tradesea ──");
await bootstrapRithmicAccuracy(mgr, { resolutions: [1], timeoutMs: 30_000 });

const snapSec = Math.floor(Date.now() / 1000);
console.log("\n── refreshCurrent1m ──");
await mgr.refreshCurrent1m(snapSec);
mgr.syncFromLastTrade();

console.log("\n── TradeSea reference ──");
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

const ours = mgr.getForming(1);
const ts = ref.forming.get("1") ?? ref.forming.get("1M");
const fmt = (n) => (n == null ? "—" : Number(n).toFixed(2));

console.log("\n── compare ──");
console.log(
  `TradeSea  t=${ts ? new Date(ts.marker * 1000).toLocaleString() : "—"}  O ${fmt(ts?.open)} H ${fmt(ts?.high)} L ${fmt(ts?.low)} C ${fmt(ts?.close)}`,
);
console.log(
  `Rithmic   t=${ours ? new Date(ours.marker * 1000).toLocaleString() : "—"}  O ${fmt(ours?.open)} H ${fmt(ours?.high)} L ${fmt(ours?.low)} C ${fmt(ours?.close)}  [${ours?.replaySource ?? "?"}]`,
);

await ref.close();
await mgr.detachLive?.();
chart.close();
