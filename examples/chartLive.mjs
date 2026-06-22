#!/usr/bin/env node
/** Live 1m forming bar OHLC vs Rithmic TimeBar. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { init, ChartLive, fmtBarTime, fmtOhlc, fmtOhlcChange } from "../index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await init();

const live = await ChartLive.open({
  user: process.env.RITHMIC_USER,
  password: process.env.RITHMIC_PASSWORD,
  systemName: process.env.RITHMIC_SYSTEM ?? "LucidTrading",
  symbol: "NQ",
  exchange: "CME",
  resolution: 1,
  forming: true,
  gatewayName: process.env.RITHMIC_GATEWAY ?? "Chicago",
  logDir: path.join(__dirname, "logs"),
});

// Last closed 1m bar loaded from history during bootstrap.
live.on("latest", ({ bar }) => {
  console.log(`Latest: @ ${fmtBarTime(bar.marker)} ${fmtOhlc(bar)}`);
});

// Rithmic TimeBar close from the history plant (official exchange bar).
live.on("bar", ({ bar, marker }) => {
  console.log(`Closed (timebar): @ ${fmtBarTime(marker)} ${fmtOhlc(bar)}`);
});

// Our forming bar when the minute rolls (compare open/high/low/close vs timebar above).
live.on("closed", ({ bar, source, marker }) => {
  if (source === "forming") {
    console.log(`Closed (${source}): @ ${fmtBarTime(marker)} ${fmtOhlc(bar)}`);
  }
});

// First tick of a new forming minute — open is set from the first trade.
live.on("new_bar", ({ bar }) => {
  console.log(`New Bar: @ ${fmtBarTime(bar.marker)} ${fmtOhlc(bar)}`);
});

// Forming bar updates on each trade (close/high/low change; open stays fixed).
live.on("live", ({ bar }) => {
  console.log(`Live: @ ${fmtBarTime(bar.marker)} ${fmtOhlcChange(bar)}`);
});

// Session status only (full detail still goes to examples/logs/chartLive.txt).
live.on("line", (line) => {
  if (/^(bootstrap|Symbol:|Logging|Wire log|Streaming|shutdown|Stopped)/.test(line)) {
    console.log(line);
  }
});

await live.run();
await live.close();
