/**
 * CandleLayer — native completed HTF + tick-refined 1m tail + forming rollup.
 *
 *   npm run example:forming-15m
 *
 * Env:
 *   RITHMIC_TIME_RESOLUTION   Chart TF in minutes (default 15). Use 1 for 1m-only.
 *   RITHMIC_TIME_BAR_COUNT    Native HTF countback when resolution > 1 (default 25)
 *   RITHMIC_INCLUDE_FORMING   Set 0 for closed bars only (example opts in by default)
 *   RITHMIC_START_LIVE        Set 1 to stream trades and update forming bar
 *   RITHMIC_SYMBOL / RITHMIC_EXCHANGE / RITHMIC_SYSTEM / RITHMIC_GATEWAY
 */
import {
  ChartSession,
  CandleLayer,
  parseResolution,
  MarketUpdatePreset,
  bucketOpen,
} from "../index.js";

const user = process.env.RITHMIC_USER;
const password = process.env.RITHMIC_PASSWORD;
if (!user || !password) {
  console.error("Set RITHMIC_USER and RITHMIC_PASSWORD in .env");
  process.exit(1);
}

const symbol = process.env.RITHMIC_SYMBOL ?? "NQ";
const exchange = process.env.RITHMIC_EXCHANGE ?? "CME";
const resolution = Number(process.env.RITHMIC_TIME_RESOLUTION ?? "60", 10);
const includeForming = process.env.RITHMIC_INCLUDE_FORMING !== "0";
const startLive = process.env.RITHMIC_START_LIVE === "1";
const { barType, barTypePeriod, periodSeconds } = parseResolution(resolution);

const fmtPrice = (n) => (n == null ? "—" : Number(n).toFixed(2));
const fmtVol = (n) => (n == null ? "—" : String(Math.round(n)));
const fmtTime = (sec) =>
  sec == null ? "—" : new Date(Number(sec) * 1000).toLocaleString();

function logBar(b, label) {
  const tag = b.forming ? "forming" : "closed";
  const src = b.replaySource ? ` (${b.replaySource})` : "";
  console.log(
    `${label} [${tag}]${src}  ${fmtTime(b.marker)}  O ${fmtPrice(b.open)}  H ${fmtPrice(b.high)}  L ${fmtPrice(b.low)}  C ${fmtPrice(b.close)}  V ${fmtVol(b.volume)}`,
  );
}

const nowSec = Math.floor(Date.now() / 1000);
const currentOpen = bucketOpen(nowSec, periodSeconds);

console.log(`Current time: ${new Date().toLocaleString()}  (unix ${nowSec})`);
console.log(`Open ${resolution}m bucket: ${fmtTime(currentOpen)}`);
console.log(
  `${symbol}@${exchange}  resolution=${resolution}m  include_forming=${includeForming}  live=${startLive}\n`,
);

const tConnect = performance.now();
const chart = await ChartSession.open({
  user,
  password,
  systemName: process.env.RITHMIC_SYSTEM ?? "LucidTrading",
  uri: process.env.RITHMIC_URI,
  gatewayName: process.env.RITHMIC_GATEWAY,
  symbol,
  exchange,
});

const layer = new CandleLayer(chart);
const fmtMs = (n) => `${Math.round(Number(n))} ms`;

try {
  const result = await layer.load1m({
    alsoFor: [resolution],
    countback: Number(process.env.RITHMIC_TIME_BAR_COUNT ?? "25", 10),
    include_forming: includeForming,
    profile: true,
  });
  const { timings, useNativeHtf, tail1mFrom } = result;

  const tDerive = performance.now();
  const closed = layer.getClosed(resolution);
  const tClosedDone = performance.now();
  const forming = layer.getForming(resolution);
  const tFormingDone = performance.now();

  console.log("── Load summary ──");
  if (useNativeHtf) {
    const lastNative = layer.getLatestCompletedNative(resolution);
    console.log(
      `Native completed ${resolution}m: ${closed.length} bar(s)` +
        (lastNative ? ` (latest ${fmtTime(lastNative.marker)})` : ""),
    );
    console.log(
      `1m tail (open bucket): ${layer.closed1m.length} bar(s) from ${fmtTime(tail1mFrom)}`,
    );
  } else {
    console.log(`1m replay: ${layer.closed1m.length} closed bar(s)`);
  }
  console.log();

  if (timings) {
    console.log("── Timing ──");
    if (timings.loadHistoryHtfCompleted_ms != null) {
      console.log(`  native ${resolution}m completed     ${fmtMs(timings.loadHistoryHtfCompleted_ms)}`);
    }
    if (timings.loadHistory1mTail_ms != null) {
      console.log(
        `  1m tail replay                  ${fmtMs(timings.loadHistory1mTail_ms)}  (${timings.countback1mTail ?? "?"} bars)`,
      );
    }
    if (timings.loadHistory1m_ms != null) {
      console.log(`  1m full replay                  ${fmtMs(timings.loadHistory1m_ms)}`);
    }
    if (timings.refine1mTailFromTicks_ms != null) {
      console.log(`  1m tick OHLC refine             ${fmtMs(timings.refine1mTailFromTicks_ms)}`);
    }
    if (timings.seedForming1m_ms != null && timings.seedForming1m_ms > 0) {
      console.log(`  seed forming 1m                 ${fmtMs(timings.seedForming1m_ms)}`);
    }
    console.log(`  load1m total                    ${fmtMs(timings.load1m_total_ms)}`);
    console.log(`  derive ${resolution}m (memory)       ${fmtMs(tFormingDone - tDerive)}`);
    console.log(`  connect → ready                 ${fmtMs(tFormingDone - tConnect)}`);
    console.log();
  }

  const series = layer.getSeries(resolution);
  console.log(`── ${resolution}m series: ${series.length} bar(s) ──\n`);

  if (closed.length) logBar(closed.at(-1), `Latest closed ${resolution}m`);
  if (forming) {
    logBar(forming, `Forming ${resolution}m`);
  } else if (includeForming) {
    console.log(`Forming ${resolution}m: none`);
  }

  if (resolution > 1 && includeForming) {
    console.log("\n── Underlying 1m (same open bucket) ──");
    const closed1m = layer.getClosed(1);
    const forming1m = layer.getForming(1);
    if (closed1m.length) logBar(closed1m.at(-1), "Latest closed 1m");
    if (forming1m) logBar(forming1m, "Forming 1m");
  }

  console.log();

  if (startLive) {
    let lastKey;
    chart.on("trade", (trade) => {
      layer.onTrade(trade);
      const bar = layer.getForming(resolution);
      if (!bar) return;
      const key = `${bar.open}|${bar.high}|${bar.low}|${bar.close}`;
      if (key === lastKey) return;
      lastKey = key;
      logBar(bar, `Live forming ${resolution}m`);
      console.log();
    });

    console.log("Live on — ticks update forming 1m; higher TF from layer (Ctrl+C to stop)\n");
    await chart.startLive({
      updateBits: MarketUpdatePreset.QUOTE,
      barType,
      barPeriod: barTypePeriod,
      exactBar: layer.forming1m,
      exactFormingBar: false,
      seedFormingFrom: layer.forming1m,
    });

    await new Promise((resolve) => process.once("SIGINT", resolve));
  } else {
    console.log("Live off — set RITHMIC_START_LIVE=1 to subscribe.\n");
  }
} finally {
  await chart.stopLive();
  chart.close();
}
