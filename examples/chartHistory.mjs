#!/usr/bin/env node
/** Time-bar history via chart session (socket stays open for timeframe changes). */
import { init, ChartSession } from "../index.js";

await init();
const chart = await ChartSession.open({
  user: process.env.RITHMIC_USER,
  password: process.env.RITHMIC_PASSWORD,
  systemName: process.env.RITHMIC_SYSTEM ?? "LucidTrading",
  symbol: "NQ",
  exchange: "CME",
  gatewayName: process.env.RITHMIC_GATEWAY ?? "Chicago",
  plants: { ticker: true, history: true, order: false, pnl: false },
});

const bars = await chart.planets.history.load({
  countback: Number(process.env.RITHMIC_COUNTBACK ?? 50),
  resolution: process.env.RITHMIC_RESOLUTION ?? 1,
});

console.log(`bars: ${bars.length}`);
if (bars.length) {
  const last = bars[bars.length - 1];
  console.log("last bar:", last.marker, last.open, last.high, last.low, last.close);
}

chart.close();
