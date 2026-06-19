/**
 * Live chart demo: history replay + last/bid/ask + forming bars.
 *
 * Env: RITHMIC_USER, RITHMIC_PASSWORD (+ optional RITHMIC_* in .env)
 */
import { ChartSession, MarketUpdatePreset } from "../index.js";

const user = process.env.RITHMIC_USER;
const password = process.env.RITHMIC_PASSWORD;
const systemName = process.env.RITHMIC_SYSTEM ?? "LucidTrading";
const symbol = process.env.RITHMIC_SYMBOL ?? "NQ";
const exchange = process.env.RITHMIC_EXCHANGE ?? "CME";
const barCount = Number(process.env.RITHMIC_BAR_COUNT ?? "60", 10);

if (!user || !password) {
  console.error("Set RITHMIC_USER and RITHMIC_PASSWORD.");
  process.exit(1);
}

const fmtPrice = (n) => (n == null ? "—" : Number(n).toFixed(2));
const fmtQty = (n) => (n == null ? "—" : String(n));
const fmtTime = (sec) =>
  sec == null ? "—" : new Date(Number(sec) * 1000).toLocaleString();

function logQuote(q) {
  const sym = q.symbol ?? symbol;
  console.log(
    `${sym}  Bid ${fmtPrice(q.bid)} x ${fmtQty(q.bid_size)}  |  Ask ${fmtPrice(q.ask)} x ${fmtQty(q.ask_size)}`,
  );
}

function logTrade(t) {
  const sym = t.symbol ?? symbol;
  const side =
    t.aggressor === 1 || t.aggressor === "BUY"
      ? "Buy"
      : t.aggressor === 2 || t.aggressor === "SELL"
        ? "Sell"
        : null;
  const sideLabel = side ? `  ${side}` : "";
  console.log(`${sym}  Last ${fmtPrice(t.price)} x ${fmtQty(t.size)}${sideLabel}`);
}

function logBar(b) {
  const sym = b.symbol ?? symbol;
  console.log(`${sym}  Bar ${fmtTime(b.marker)}  close ${fmtPrice(b.close)}  vol ${fmtQty(b.volume)}`);
}

function logLatestHighLow(r) {
  const sym = r.symbol ?? symbol;
  console.log(`${sym}  latest_high_low  high ${fmtPrice(r.high_price)}  low ${fmtPrice(r.low_price)}`);
}

function logLatestClose(c) {
  const sym = c.symbol ?? symbol;
  const closeLabel = c.close_date ? `${c.close_date} ${fmtPrice(c.close_price)}` : fmtPrice(c.close_price);
  const settleLabel =
    c.settlement_date != null
      ? `${c.settlement_date} ${fmtPrice(c.settlement_price)}`
      : fmtPrice(c.settlement_price);
  console.log(`${sym}  latest_close  ${closeLabel}  settlement ${settleLabel}  (${c.price_type ?? "n/a"})`);
}

const chart = await ChartSession.open({
  user,
  password,
  systemName,
  symbol,
  exchange,
  gatewayName: process.env.RITHMIC_GATEWAY,
});

// chart.on("trade", logTrade);
// chart.on("quote", logQuote);
chart.on("bar", logBar);
chart.on("latest_high_low", logLatestHighLow);
chart.on("latest_close", logLatestClose);
chart.on("status", (s) => {
  if (process.env.RITHMIC_VERBOSE === "1") console.log("[status]", s);
});

try {
  const history = await chart.loadHistory({ barCount });
  console.log(`History: ${history.length} bars`);
  if (history.length) {
    console.log("  first:", fmtTime(history[0].marker), history[0].close);
    console.log("  last: ", fmtTime(history[history.length - 1].marker), history[history.length - 1].close);
  }

  console.log("\nLive feed (Ctrl+C to stop)…\n");
  await chart.startLive({ updateBits: MarketUpdatePreset.CHART });

  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
  });
} finally {
  await chart.stopLive();
  chart.close();
}
