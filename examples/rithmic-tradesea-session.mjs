/**
 * TradeSea-accurate chart session — Rithmic feed + TradeSea MDS sync.
 *
 *   node --env-file=.env examples/rithmic-tradesea-session.mjs
 */
import { RithmicTradeSeaSession } from "../index.js";

const user = process.env.RITHMIC_USER;
const password = process.env.RITHMIC_PASSWORD;
const token = process.env.TRADESEA_ACCESS_TOKEN;

if (!user || !password || !token) {
  console.error("Set RITHMIC_USER, RITHMIC_PASSWORD, TRADESEA_ACCESS_TOKEN");
  process.exit(1);
}

const RESOLUTIONS = [15, 60, 240, "1D", "1W", "1M"];
const fmt = (n) => (n == null ? "—" : Number(n).toFixed(2));

const t0 = performance.now();
const sess = await RithmicTradeSeaSession.open({
  user,
  password,
  systemName: process.env.RITHMIC_SYSTEM ?? "LucidTrading",
  symbol: process.env.RITHMIC_SYMBOL ?? "NQ",
  exchange: process.env.RITHMIC_EXCHANGE ?? "CME",
  gatewayName: process.env.RITHMIC_GATEWAY,
  accessToken: token,
  resolutions: RESOLUTIONS,
});
console.log(`Ready in ${((performance.now() - t0) / 1000).toFixed(2)}s\n`);

const st = sess.status;
console.log("=== TradeSea-accurate market ===");
console.log(`  last ${fmt(st?.last)}  bid ${fmt(st?.bid)} x ${st?.bid_size ?? "—"}  ask ${fmt(st?.ask)} x ${st?.ask_size ?? "—"}`);

console.log("\n=== Forming candles (matches TradeSea chart) ===");
for (const r of RESOLUTIONS) {
  const bar = sess.getForming(r);
  if (!bar) {
    console.log(`  ${String(r).padEnd(4)} —`);
    continue;
  }
  console.log(
    `  ${String(r).padEnd(4)} O ${fmt(bar.open)} H ${fmt(bar.high)} L ${fmt(bar.low)} C ${fmt(bar.close)}  [${bar.replaySource}]`,
  );
}

console.log("\nListening 5s for live updates…");
sess.on("market", (s) => {
  process.stdout.write(`\r  live last ${fmt(s?.last)}  bid ${fmt(s?.bid)}  ask ${fmt(s?.ask)}   `);
});
await new Promise((r) => setTimeout(r, 5000));
console.log("\n");

await sess.close();
