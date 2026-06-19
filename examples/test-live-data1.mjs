/**
 * Live test: session snapshots (152/155) + TimeBar forming/closed for a resolution.
 *
 * Env: RITHMIC_USER, RITHMIC_PASSWORD (+ optional RITHMIC_* in .env)
 *   RITHMIC_RESOLUTION   Minutes for live bar subscribe (default 15)
 *   RITHMIC_TIMEOUT_MS   Listen duration (default 20000)
 */
import { ChartSession, MarketUpdatePreset, parseResolution, bucketOpen } from "../index.js";

const user = process.env.RITHMIC_USER;
const password = process.env.RITHMIC_PASSWORD;
const systemName = process.env.RITHMIC_SYSTEM ?? "LucidTrading";
const symbol = process.env.RITHMIC_SYMBOL ?? "NQ";
const exchange = process.env.RITHMIC_EXCHANGE ?? "CME";
const resolution = Number(process.env.RITHMIC_RESOLUTION ?? "15", 10);
const timeoutMs = Number(process.env.RITHMIC_TIMEOUT_MS ?? "20000", 10);

if (!user || !password) {
  console.error("Set RITHMIC_USER and RITHMIC_PASSWORD.");
  process.exit(1);
}

const { barType, barTypePeriod, periodSeconds } = parseResolution(resolution);
const fmtPrice = (n) => (n == null ? "—" : Number(n).toFixed(2));
const fmtTime = (sec) =>
  sec == null ? "—" : new Date(Number(sec) * 1000).toLocaleString();

const seen = { highLow: false, close: false, formingBar: false, closedBar: false };

const chart = await ChartSession.open({
  user,
  password,
  systemName,
  symbol,
  exchange,
  gatewayName: process.env.RITHMIC_GATEWAY,
});

chart.on("latest_high_low", (r) => {
  seen.highLow = true;
  console.log(
    `${r.symbol ?? symbol}  latest_high_low (152)  high ${fmtPrice(r.high_price)}  low ${fmtPrice(r.low_price)}`,
  );
});

chart.on("latest_close", (c) => {
  seen.close = true;
  console.log(
    `${c.symbol ?? symbol}  latest_close (155)  close ${fmtPrice(c.close_price)}  settlement ${fmtPrice(c.settlement_price)}`,
  );
});

chart.on("formingBar", (b) => {
  seen.formingBar = true;
  console.log(
    `${symbol}  formingBar (${resolution}m, template 250)  ${fmtTime(b.marker)}  O ${fmtPrice(b.open)}  H ${fmtPrice(b.high)}  L ${fmtPrice(b.low)}  C ${fmtPrice(b.close)}  V ${b.volume ?? "—"}`,
  );
});

chart.on("bar", (b) => {
  seen.closedBar = true;
  console.log(
    `${symbol}  bar closed (${resolution}m)  ${fmtTime(b.marker)}  close ${fmtPrice(b.close)}  V ${b.volume ?? "—"}`,
  );
});

try {
  const nowSec = Math.floor(Date.now() / 1000);
  const bucket = bucketOpen(nowSec, periodSeconds);

  console.log("--- subscribe ---");
  console.log(`Local time now:     ${new Date().toLocaleString()}  (unix ${nowSec})`);
  console.log(`Open ${resolution}m bucket: ${fmtTime(bucket)}  (unix ${bucket})`);
  console.log(`Symbol:             ${symbol}@${exchange}`);
  console.log(`Ticker bits:        MarketUpdatePreset.CHART (150–152, 155 incl. high-low/close)`);
  console.log(`History bar sub:    MINUTE_BAR period ${barTypePeriod}  (${periodSeconds}s buckets)\n`);

  const t0 = Date.now();
  await chart.startLive({
    updateBits: MarketUpdatePreset.CHART,
    barType,
    barPeriod: barTypePeriod,
    exactFormingBar: false,
  });
  console.log(`Subscribed at:        ${new Date(t0).toLocaleString()}  (+${Date.now() - t0} ms)\n`);

  await new Promise((resolve) => setTimeout(resolve, timeoutMs));

  console.log("\n--- summary ---");
  console.log(`HighPriceLowPrice (152): ${seen.highLow ? "received" : "NOT received"}`);
  console.log(`ClosePrice (155):        ${seen.close ? "received" : "NOT received"}`);
  console.log(`formingBar (250 open):   ${seen.formingBar ? "received" : "NOT received"}`);
  console.log(`bar (250 closed):        ${seen.closedBar ? "received (bucket rolled during wait)" : "none (normal unless bucket closes)"}`);
  if (chart.status.bar_close != null) {
    console.log(`Latest bar close:        ${fmtPrice(chart.status.bar_close)}  marker ${fmtTime(chart.status.bar_marker)}`);
  }
} finally {
  await chart.stopLive();
  chart.close();
}
