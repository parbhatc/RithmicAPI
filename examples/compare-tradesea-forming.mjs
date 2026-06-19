/**
 * Verify pure Rithmic forming + market data against TradeSea MDS (reference only).
 *
 * Rithmic builds all bars; TradeSea MDS is read-only for comparison.
 *
 *   node --env-file=.env examples/compare-tradesea-forming.mjs
 *   RITHMIC_ONLY=0 ...   # legacy: apply TradeSea MDS to Rithmic (not recommended)
 */
import {
  ChartSession,
  FormingBarManager,
  bootstrapRithmicAccuracy,
  fetchTradeSeaReference,
  toTradeseaResolution,
  chartBucketOpen,
  bucketOpen,
  parseResolution,
  MarketUpdatePreset,
} from "../index.js";

const RITHMIC_USER = process.env.RITHMIC_USER;
const RITHMIC_PASSWORD = process.env.RITHMIC_PASSWORD;
const TRADESEA_TOKEN = process.env.TRADESEA_ACCESS_TOKEN;
/** Pure Rithmic path (default). Set 0 to use legacy TS MDS overlay. */
const RITHMIC_ONLY = process.env.RITHMIC_ONLY !== "0";

if (!TRADESEA_TOKEN) {
  console.error("Set TRADESEA_ACCESS_TOKEN (used for verification reference only).");
  process.exit(1);
}
if (!RITHMIC_USER || !RITHMIC_PASSWORD) {
  console.error("Set RITHMIC_USER and RITHMIC_PASSWORD.");
  process.exit(1);
}

const CONNECTION_USER_ID =
  process.env.TRADESEA_CONNECTION_USER_ID ??
  "dDqVtke0T1bbMKI-g6JpZKpOT1FCUzI5NzQ2omV1q0xULTFYRDgxWjlEoWSDonNurEx1Y2lkVHJhZGluZ6NmY22sTHVjaWRUcmFkaW5nomlirEx1Y2lkVHJhZGluZw";
const CONNECTION_GROUP_ID =
  process.env.TRADESEA_CONNECTION_GROUP_ID ??
  "9ab078c1665d83855967508f934e74da32f1bc08e6b1ae93760db21324daca22";

const symbol = process.env.RITHMIC_SYMBOL ?? "NQ";
const exchange = process.env.RITHMIC_EXCHANGE ?? "CME";
const STREAM_SYMBOL = process.env.TRADESEA_STREAM_SYMBOL ?? "CME:NQ";

const RESOLUTIONS = [
  { ts: "15", ours: 15 },
  { ts: "60", ours: 60 },
  { ts: "240", ours: 240 },
  { ts: "1D", ours: "1D" },
  { ts: "1W", ours: "1W" },
  { ts: "1", ours: 1 }, // 1-minute (TradeSea MDS key "1" / sometimes labeled 1M)
];

const fmtPrice = (n) => (n == null ? "—" : Number(n).toFixed(2));
const fmtTime = (sec) => new Date(Number(sec) * 1000).toLocaleString();
const TOL = Number(process.env.COMPARE_TOL ?? "0.01");
const tol = (a, b, eps = TOL) =>
  a != null && b != null && Math.abs(Number(a) - Number(b)) <= eps;

function compare(label, ours, ref) {
  if (!ours) {
    console.log(`  ✗ ${label}  Rithmic=MISSING`);
    return false;
  }
  if (!ref) {
    console.log(`  ✗ ${label}  TradeSea ref=MISSING`);
    return false;
  }
  const okO = tol(ours.open, ref.open);
  const okH = tol(ours.high, ref.high);
  const okL = tol(ours.low, ref.low);
  const okC = tol(ours.close, ref.close);
  const ok = okO && okH && okL && okC;
  console.log(`  ${ok ? "✓" : "✗"} ${label}  [${ours.replaySource ?? "?"}]`);
  console.log(
    `       TradeSea t=${fmtTime(ref.marker)}  O ${fmtPrice(ref.open)}  H ${fmtPrice(ref.high)}  L ${fmtPrice(ref.low)}  C ${fmtPrice(ref.close)}`,
  );
  console.log(
    `       Rithmic  t=${fmtTime(ours.marker)}  O ${fmtPrice(ours.open)}  H ${fmtPrice(ours.high)}  L ${fmtPrice(ours.low)}  C ${fmtPrice(ours.close)}`,
  );
  if (!ok) {
    const d = [];
    if (!okO) d.push(`open Δ${(Number(ours.open) - ref.open).toFixed(2)}`);
    if (!okH) d.push(`high Δ${(Number(ours.high) - ref.high).toFixed(2)}`);
    if (!okL) d.push(`low Δ${(Number(ours.low) - ref.low).toFixed(2)}`);
    if (!okC) d.push(`close Δ${(Number(ours.close) - ref.close).toFixed(2)}`);
    console.log(`       delta: ${d.join(", ")}`);
  }
  return ok;
}

function compareField(label, ours, ref) {
  const ok = tol(ours, ref, 0.01);
  console.log(`  ${ok ? "✓" : "✗"} ${label.padEnd(20)} Rithmic=${fmtPrice(ours)}  TradeSea=${fmtPrice(ref)}`);
  if (!ok && ours != null && ref != null) {
    console.log(`       delta ${(Number(ours) - Number(ref)).toFixed(2)}`);
  }
  return ok;
}

const allResolutions = [...new Set(RESOLUTIONS.map((r) => r.ours))];
const tWall = performance.now();

console.log(`Mode: ${RITHMIC_ONLY ? "Rithmic-only (TradeSea = verify reference)" : "legacy TS MDS overlay"}\n`);

const tConnect = performance.now();
const chart = await ChartSession.open({
  user: RITHMIC_USER,
  password: RITHMIC_PASSWORD,
  systemName: process.env.RITHMIC_SYSTEM ?? "LucidTrading",
  symbol,
  exchange,
  uri: process.env.RITHMIC_URI,
  gatewayName: process.env.RITHMIC_URI ? undefined : process.env.RITHMIC_GATEWAY,
});
const connectMs = performance.now() - tConnect;

const mgr = new FormingBarManager(chart);
const tBoot = performance.now();

if (RITHMIC_ONLY) {
  await bootstrapRithmicAccuracy(mgr, {
    resolutions: allResolutions,
    tradeSeaAccessToken: TRADESEA_TOKEN,
    timeoutMs: 120_000,
  });
} else {
  const { TradeseaMdsSync } = await import("../index.js");
  const tsSync = new TradeseaMdsSync(mgr, {
    accessToken: TRADESEA_TOKEN,
    connectionUserId: CONNECTION_USER_ID,
    connectionGroupId: CONNECTION_GROUP_ID,
    streamSymbol: STREAM_SYMBOL,
  });
  await Promise.all([
    tsSync.start({ resolutions: allResolutions, subscribeMarket: true }),
    mgr.bootstrap({ resolutions: allResolutions, fast: true, tradeSeaAccessToken: TRADESEA_TOKEN }),
  ]);
  await mgr.attachLive({ updateBits: MarketUpdatePreset.QUOTE });
}

const bootMs = performance.now() - tBoot;

const tRef = performance.now();
const ref = await fetchTradeSeaReference({
  accessToken: TRADESEA_TOKEN,
  refreshToken: process.env.TRADESEA_REFRESH_TOKEN,
  connectionUserId: CONNECTION_USER_ID,
  connectionGroupId: CONNECTION_GROUP_ID,
  streamSymbol: STREAM_SYMBOL,
  resolutions: allResolutions,
});
const refMs = performance.now() - tRef;

// Tight snapshot: refresh 1m + sync last trade immediately before compare
const snapSec = Math.floor(Date.now() / 1000);
await mgr.refreshCurrent1m(snapSec);
mgr.syncFromLastTrade();

const compareSec = snapSec;
console.log(`Compare @ ${fmtTime(compareSec)}`);
console.log(
  `Speed: connect ${Math.round(connectMs)} ms | Rithmic bootstrap ${Math.round(bootMs)} ms | TradeSea ref ${Math.round(refMs)} ms | wall pending\n`,
);

// Market
console.log("=== Market (Rithmic vs TradeSea MDS) ===");
const rithmicSt = chart.status;
let marketPass = 0;
let marketTotal = 0;
if (ref.market) {
  for (const [label, key] of [
    ["last", "last"],
    ["bid", "bid"],
    ["ask", "ask"],
  ]) {
    marketTotal++;
    if (compareField(label, rithmicSt?.[key], ref.market[key])) marketPass++;
  }
}
console.log(`Market: ${marketPass}/${marketTotal}\n`);

// Forming
console.log("=== Forming (Rithmic vs TradeSea MDS) ===");
let pass = 0;
for (const { ts, ours } of RESOLUTIONS) {
  const tsKey = toTradeseaResolution(ours);
  let refBar = ref.forming.get(tsKey);
  if (ours === 1) refBar = ref.forming.get("1") ?? ref.forming.get("1M");

  let ourBar = mgr.getForming(ours);
  if (ours === 1) {
    await mgr.refreshCurrent1m(Math.floor(Date.now() / 1000));
    mgr.syncFromLastTrade();
    ourBar = mgr.getForming(1);
  }

  const ps = parseResolution(ours).periodSeconds;
  const bucket =
    typeof ours === "string" && /[DWM]/i.test(String(ours))
      ? chartBucketOpen(compareSec, ours)
      : bucketOpen(compareSec, ps);

  console.log(`${String(ts).padEnd(4)} bucket ${fmtTime(bucket)}`);
  if (compare(String(ts), ourBar, refBar)) pass++;
  console.log();
}

console.log(`Forming match: ${pass}/${RESOLUTIONS.length} (±${TOL} pt)`);
const wallMs = performance.now() - tWall;
console.log(`Wall ${(wallMs / 1000).toFixed(2)}s total`);
console.log(
  `\n── Speed summary ──\n` +
    `  Rithmic connect:    ${Math.round(connectMs).toLocaleString()} ms\n` +
    `  Rithmic bootstrap:  ${Math.round(bootMs).toLocaleString()} ms  (our implementation)\n` +
    `  TradeSea ref fetch: ${Math.round(refMs).toLocaleString()} ms  (verify only)\n` +
    `  Total wall:         ${Math.round(wallMs).toLocaleString()} ms\n`,
);

const allPass =
  pass === RESOLUTIONS.length && marketPass === marketTotal;

if (!allPass && pass === RESOLUTIONS.length) {
  console.log(`\nForming exact; market bid/ask can lag ~1 tick during fast tape.`);
}

if (pass < RESOLUTIONS.length) {
  console.log(`
Tips to improve Rithmic-only match:
  • Compare at same instant — intraday close drifts with live market
  • Run: accuracy:'tradesea' bootstrap + attachRithmicAccuracy (default in bootstrapRithmicAccuracy)
`);
}

await ref.close();
await mgr.detachLive?.();
chart.close();
process.exitCode = allPass ? 0 : 1;
