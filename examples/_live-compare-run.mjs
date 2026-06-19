/**
 * One-shot live compare (same logic as compare-tradesea-forming.mjs).
 *   node --env-file=.env examples/_live-compare-run.mjs
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
} from "../index.js";

const RESOLUTIONS = [
  { ts: "15", ours: 15 },
  { ts: "60", ours: 60 },
  { ts: "240", ours: 240 },
  { ts: "1D", ours: "1D" },
  { ts: "1W", ours: "1W" },
  { ts: "1", ours: 1 },
];

const fmtPrice = (n) => (n == null ? "—" : Number(n).toFixed(2));
const fmtTime = (sec) => new Date(Number(sec) * 1000).toLocaleString();
const TOL = 0.01;
const tol = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= TOL;

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

const allResolutions = [...new Set(RESOLUTIONS.map((r) => r.ours))];
const t0 = performance.now();

const chart = await ChartSession.open({
  user: process.env.RITHMIC_USER,
  password: process.env.RITHMIC_PASSWORD,
  systemName: process.env.RITHMIC_SYSTEM ?? "LucidTrading",
  symbol: process.env.RITHMIC_SYMBOL ?? "NQ",
  exchange: process.env.RITHMIC_EXCHANGE ?? "CME",
  uri: process.env.RITHMIC_URI,
});
console.log(`Rithmic connected +${((performance.now() - t0) / 1000).toFixed(1)}s`);

const mgr = new FormingBarManager(chart);
await bootstrapRithmicAccuracy(mgr, {
  resolutions: allResolutions,
  tradeSeaAccessToken: process.env.TRADESEA_ACCESS_TOKEN,
  timeoutMs: 120_000,
});
console.log(`Bootstrap done +${((performance.now() - t0) / 1000).toFixed(1)}s`);

const ref = await fetchTradeSeaReference({
  accessToken: process.env.TRADESEA_ACCESS_TOKEN,
  refreshToken: process.env.TRADESEA_REFRESH_TOKEN,
  connectionUserId: process.env.TRADESEA_CONNECTION_USER_ID,
  connectionGroupId: process.env.TRADESEA_CONNECTION_GROUP_ID,
  streamSymbol: process.env.TRADESEA_STREAM_SYMBOL ?? "CME:NQ",
  resolutions: allResolutions,
  waitForWsMs: 3000,
  waitForMarketMs: 2000,
});
console.log(`TradeSea ref +${((performance.now() - t0) / 1000).toFixed(1)}s\n`);

const snapSec = Math.floor(Date.now() / 1000);
await mgr.refreshCurrent1m(snapSec);
mgr.syncFromLastTrade();

console.log(`=== Forming @ ${fmtTime(snapSec)} ===`);
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
      ? chartBucketOpen(snapSec, ours)
      : bucketOpen(snapSec, ps);

  console.log(`${String(ts).padEnd(4)} bucket ${fmtTime(bucket)}`);
  if (compare(String(ts), ourBar, refBar)) pass++;
  console.log();
}

console.log(`Forming match: ${pass}/${RESOLUTIONS.length} (±${TOL} pt)`);
console.log(`Wall ${((performance.now() - t0) / 1000).toFixed(1)}s`);

await ref.close();
await mgr.detachLive?.();
chart.close();
