/**
 * Multi-TF forming bootstrap — speed + OHLC vs reference values.
 *
 *   node --env-file=.env examples/test-forming-multi-tf.mjs
 */
import { ChartSession, FormingBarManager, bucketOpen, parseResolution } from "../index.js";

const user = process.env.RITHMIC_USER;
const password = process.env.RITHMIC_PASSWORD;
if (!user || !password) {
  console.error("Set RITHMIC_USER and RITHMIC_PASSWORD.");
  process.exit(1);
}

const symbol = process.env.RITHMIC_SYMBOL ?? "NQ";
const exchange = process.env.RITHMIC_EXCHANGE ?? "CME";

/** Reference forming OHLC from user @ ~8:30 PM */
const REF = {
  15: { open: 30646.75, high: 30662.25, low: 30644.25 },
  60: { open: 30690.0, high: 30694.25, low: 30628.0 },
  240: { open: 30740.0, high: 30777.75, low: 30628.0 },
  "1D": { open: 30740.0, high: 30770.75, low: 30628.0 },
  "1W": { open: 30740.0, high: 30770.75, low: 30628.0 },
  "1M": { open: 30717.5, high: 31109.75, low: 28529.75 },
};

const RESOLUTIONS = [15, 60, 240, "1D", "1W", "1M"];

const fmtPrice = (n) => (n == null ? "—" : Number(n).toFixed(2));
const fmtTime = (sec) => new Date(Number(sec) * 1000).toLocaleString();
const tol = (a, b, eps = 0.5) =>
  a == null || b == null ? false : Math.abs(Number(a) - Number(b)) <= eps;

function diffField(label, got, ref) {
  const ok =
    tol(got.open, ref.open) && tol(got.high, ref.high) && tol(got.low, ref.low);
  const flag = ok ? "✓" : "✗";
  console.log(
    `  ${flag} ${label.padEnd(5)}  O ${fmtPrice(got.open)} (ref ${fmtPrice(ref.open)})  H ${fmtPrice(got.high)} (ref ${fmtPrice(ref.high)})  L ${fmtPrice(got.low)} (ref ${fmtPrice(ref.low)})`,
  );
  if (!ok) {
    const miss = [];
    if (!tol(got.open, ref.open)) miss.push(`open Δ${(Number(got.open) - ref.open).toFixed(2)}`);
    if (!tol(got.high, ref.high)) miss.push(`high Δ${(Number(got.high) - ref.high).toFixed(2)}`);
    if (!tol(got.low, ref.low)) miss.push(`low Δ${(Number(got.low) - ref.low).toFixed(2)}`);
    console.log(`       mismatch: ${miss.join(", ")}`);
  }
  return ok;
}

const nowSec = Math.floor(Date.now() / 1000);
console.log("--- Multi-TF Forming Bootstrap ---");
console.log(`Now:     ${fmtTime(nowSec)}  (unix ${nowSec})`);
console.log(`Symbol:  ${symbol}@${exchange}\n`);

for (const r of RESOLUTIONS) {
  const ps = parseResolution(r).periodSeconds;
  console.log(`  ${String(r).padEnd(4)} bucket open: ${fmtTime(bucketOpen(nowSec, ps))}`);
}
console.log();

const tConnect = performance.now();
const chart = await ChartSession.open({
  user,
  password,
  systemName: process.env.RITHMIC_SYSTEM ?? "LucidTrading",
  symbol,
  exchange,
  gatewayName: process.env.RITHMIC_GATEWAY,
});
const connectMs = performance.now() - tConnect;

const mgr = new FormingBarManager(chart);
const tBoot = performance.now();
const { plan } = await mgr.bootstrap({
  resolutions: RESOLUTIONS,
  timeoutMs: 90_000,
  fast: true,
  useCache: true,
});
const bootMs = performance.now() - tBoot;

const tBoot2 = performance.now();
await mgr.bootstrap({
  resolutions: RESOLUTIONS,
  timeoutMs: 90_000,
  fast: true,
  useCache: true,
});
const bootCacheMs = performance.now() - tBoot2;
const totalMs = performance.now() - tConnect;

console.log(`Connect:   ${(connectMs / 1000).toFixed(2)} s  (${Math.round(connectMs)} ms)`);
console.log(`Bootstrap: ${(bootMs / 1000).toFixed(2)} s  (${Math.round(bootMs)} ms)`);
console.log(`Cached:    ${(bootCacheMs / 1000).toFixed(2)} s  (${Math.round(bootCacheMs)} ms)`);
console.log(`Total:     ${(totalMs / 1000).toFixed(2)} s  (${Math.round(totalMs)} ms)`);
console.log(`Requests:  ${plan.requestCount}`);
for (const req of plan.requests) {
  const extra =
    req.type === "1m-shared"
      ? ` countback=${req.countback}`
      : req.type === "native-partial"
        ? ` res=${req.resolution}`
        : "";
  console.log(`  · ${req.type}${extra} → ${req.serves.join(", ")}`);
}
console.log();

let pass = 0;
for (const r of RESOLUTIONS) {
  const key = String(r).toUpperCase() === "1D" ? "1D" : String(r).toUpperCase() === "1W" ? "1W" : String(r).toUpperCase() === "1M" ? "1M" : String(r);
  const refKey = r;
  const bar = mgr.getForming(r);
  const ref = REF[refKey];
  if (!bar) {
    console.log(`  ✗ ${key}  NO FORMING BAR`);
    continue;
  }
  if (diffField(key, bar, ref)) pass++;
  console.log(`       marker ${fmtTime(bar.marker)}  source ${bar.replaySource ?? "?"}`);
}
console.log(`\nMatch: ${pass}/${RESOLUTIONS.length} within 0.50 pts`);

chart.close();
process.exitCode = pass === RESOLUTIONS.length ? 0 : 1;
