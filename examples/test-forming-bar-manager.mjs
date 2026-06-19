/**
 * FormingBarManager demo — mid-candle 15m chart at e.g. 8:20 PM.
 *
 *   node --env-file=.env examples/test-forming-bar-manager.mjs
 *
 * Env: RITHMIC_RESOLUTION (default 15), RITHMIC_LIVE=1 to stream ticks after bootstrap
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
const resolution = Number(process.env.RITHMIC_RESOLUTION ?? "15", 10);
const live = process.env.RITHMIC_LIVE === "1";
const { periodSeconds } = parseResolution(resolution);

const fmtPrice = (n) => (n == null ? "—" : Number(n).toFixed(2));
const fmtTime = (sec) => new Date(Number(sec) * 1000).toLocaleString();

const nowSec = Math.floor(Date.now() / 1000);
const htfOpen = bucketOpen(nowSec, periodSeconds);

console.log("--- Forming Bar Manager ---");
console.log(`Now:              ${fmtTime(nowSec)}`);
console.log(`Open ${resolution}m bucket: ${fmtTime(htfOpen)}`);
console.log(`Blind spot:       1m bars from ${fmtTime(htfOpen)} → now\n`);

const chart = await ChartSession.open({
  user,
  password,
  systemName: process.env.RITHMIC_SYSTEM ?? "LucidTrading",
  symbol,
  exchange,
  gatewayName: process.env.RITHMIC_GATEWAY,
});

const mgr = new FormingBarManager(chart);

try {
  const t0 = performance.now();
  const { plan, forming } = await mgr.bootstrap({ resolutions: [resolution] });
  console.log(`Bootstrap (+${Math.round(performance.now() - t0)} ms, ${plan.requestCount} history request(s))`);
  console.log(`  plan:`, plan.requests.map((r) => `${r.type} → ${r.serves.join(", ")}`).join("\n        "));

  const seeded = mgr.getForming(resolution);
  if (seeded) {
    console.log(`\nSeeded ${resolution}m forming candle (from 1m history, no template 250):`);
    console.log(
      `  O ${fmtPrice(seeded.open)}  H ${fmtPrice(seeded.high)}  L ${fmtPrice(seeded.low)}  C ${fmtPrice(seeded.close)}  V ${seeded.volume ?? 0}`,
    );
    console.log(`  source: ${seeded.replaySource}`);
  } else {
    console.log("\nNo forming bar seeded (empty bucket or no 1m data).");
  }

  if (!live) {
    console.log("\nSet RITHMIC_LIVE=1 to attach LastTrade stream and update H/L/C.\n");
  } else {
    let lastKey;
    mgr.on("formingBar", ({ resolution: res, bar }) => {
      const key = `${bar.open}|${bar.high}|${bar.low}|${bar.close}`;
      if (key === lastKey) return;
      lastKey = key;
      console.log(
        `Live ${res}m  O ${fmtPrice(bar.open)}  H ${fmtPrice(bar.high)}  L ${fmtPrice(bar.low)}  C ${fmtPrice(bar.close)}`,
      );
    });

    console.log("\nLive ticks (Ctrl+C to stop)…\n");
    await mgr.attachLive();

    await new Promise((resolve) => process.once("SIGINT", resolve));
  }
} finally {
  await mgr.detachLive();
  chart.close();
}
