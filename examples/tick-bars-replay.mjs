/**
 * Fetch latest tick bars and print first / last OHLC (compat mode).
 *
 *   node --env-file=.env examples/tick-bars-replay.mjs
 *
 * Env: RITHMIC_BAR_COUNT (default 300), RITHMIC_TICK_SIZE (default "1" = 1-tick bars)
 * Optional: RITHMIC_SYMBOL, RITHMIC_EXCHANGE, RITHMIC_SYSTEM, RITHMIC_GATEWAY
 */
import { ChartSession, TickBarType, TickBarSubType } from "../index.js";

const user = process.env.RITHMIC_USER;
const password = process.env.RITHMIC_PASSWORD;
if (!user || !password) {
  console.error("Set RITHMIC_USER and RITHMIC_PASSWORD in .env");
  process.exit(1);
}

const symbol = process.env.RITHMIC_SYMBOL ?? "NQ";
const exchange = process.env.RITHMIC_EXCHANGE ?? "CME";
const countback = Number(process.env.RITHMIC_BAR_COUNT ?? "300", 10);
const barTypeSpecifier = process.env.RITHMIC_TICK_SIZE ?? "1";

const fmtPrice = (n) => (n == null ? "—" : Number(n).toFixed(2));
const fmtVol = (n) => (n == null ? "—" : String(Math.round(n)));
const fmtTime = (sec) =>
  sec == null ? "—" : new Date(Number(sec) * 1000).toLocaleString();

const printBarLine = (payload, i) =>
  `  ${fmtTime(payload.t[i])}  O ${fmtPrice(payload.o[i])}  H ${fmtPrice(payload.h[i])}  L ${fmtPrice(payload.l[i])}  C ${fmtPrice(payload.c[i])}  V ${fmtVol(payload.v[i])}`;

const printBar = (payload, i, label) => {
  console.log(`${label}:`);
  console.log(printBarLine(payload, i));
};

console.log(
  `${symbol}@${exchange}  tick bars  specifier=${barTypeSpecifier}  countback ${countback}\n`,
);

const chart = await ChartSession.open({
  user,
  password,
  systemName: process.env.RITHMIC_SYSTEM ?? "LucidTrading",
  uri: process.env.RITHMIC_URI,
  gatewayName: process.env.RITHMIC_GATEWAY,
  symbol,
  exchange,
});

try {
  const t0 = performance.now();
  const payload = await chart.loadTickHistory({
    countback,
    barType: TickBarType.TICK_BAR,
    barSubType: TickBarSubType.REGULAR,
    barTypeSpecifier,
    payload: true,
    compat: true,
  });
  const ms = Math.round(performance.now() - t0);
  const n = payload.t.length;

  console.log(`Fetched ${n} tick bar(s) in ${ms} ms (compat mode)\n`);

  if (!n) {
    console.log("No bars returned.");
    process.exit(0);
  }

  const headLabels = ["First bar", "Second bar", "Third bar"];
  for (let i = 0; i < Math.min(3, n); i++) {
    if (i > 0) console.log();
    printBar(payload, i, headLabels[i]);
  }

  console.log("\nLatest OHLC:");
  console.log(printBarLine(payload, n - 1));
} finally {
  chart.close();
}
