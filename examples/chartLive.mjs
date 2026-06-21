#!/usr/bin/env node
/** Live quotes + closed bars for a short window. */
import { init, ChartSession, MarketUpdatePreset } from "../index.js";
import { credentials, symbolPair } from "./env.mjs";

const seconds = Number(process.env.RITHMIC_LIVE_SECONDS ?? 15);

await init();
const chart = await ChartSession.open({
  ...credentials(),
  ...symbolPair(),
  gatewayName: process.env.RITHMIC_GATEWAY ?? "Chicago",
  plants: { ticker: true, history: true, order: false, pnl: false },
});

await chart.planets.history.load({ countback: 10, resolution: 1 });

chart.on("trade", (t) => console.log("trade", t.price, t.size));
chart.on("quote", (q) => console.log("quote", q.bid, q.ask));
chart.on("bar", (b) => console.log("bar", b.marker, b.close));

await chart.planets.live.start({ updateBits: MarketUpdatePreset.CHART });
console.log(`live for ${seconds}s…`);
await new Promise((r) => setTimeout(r, seconds * 1000));

await chart.planets.live.stop();
chart.close();
