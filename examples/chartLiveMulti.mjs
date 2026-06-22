#!/usr/bin/env node
/** Live forming bars: NQ 1m + ES 30S on one market-data session. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { init, ChartLive, fmtBarTime, fmtOhlc, fmtOhlcChange } from "../index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await init();

const live = await ChartLive.open({
  user: process.env.RITHMIC_USER,
  password: process.env.RITHMIC_PASSWORD,
  systemName: process.env.RITHMIC_SYSTEM ?? "LucidTrading",
  gatewayName: process.env.RITHMIC_GATEWAY ?? "Chicago",
  logDir: path.join(__dirname, "logs"),
});

live.on("latest", ({ label, bar }) => {
  console.log(`${label} Latest: @ ${fmtBarTime(bar.marker)} ${fmtOhlc(bar)}`);
});

live.on("bar", ({ label, bar, marker }) => {
  console.log(`${label} Closed (timebar): @ ${fmtBarTime(marker)} ${fmtOhlc(bar)}`);
});

live.on("closed", ({ label, bar, source, marker }) => {
  if (source === "forming") {
    console.log(`${label} Closed (${source}): @ ${fmtBarTime(marker)} ${fmtOhlc(bar)}`);
  }
});

live.on("new_bar", ({ label, bar }) => {
  console.log(`${label} New Bar: @ ${fmtBarTime(bar.marker)} ${fmtOhlc(bar)}`);
});

live.on("live", ({ label, bar }) => {
  console.log(`${label} Live: @ ${fmtBarTime(bar.marker)} ${fmtOhlcChange(bar)}`);
});

live.on("timeframe_change", ({ label, previousResolution, resolution, bar }) => {
  const forming = bar ? ` forming=@ ${fmtBarTime(bar.marker)} ${fmtOhlc(bar)}` : "";
  console.log(`${label} Timeframe: ${previousResolution} → ${resolution}${forming}`);
});

live.on("line", (line) => {
  if (/^(bootstrap|Feeds:|Logging|Wire log|Streaming|shutdown|Stopped|live feed|unsubscribed|timeframe)/.test(line)) {
    console.log(line);
  }
});

await live.subscribe("NQ", "CME", 1, true);
await live.subscribe("ES", "CME", "30S", true);

await live.run();
await live.close();
