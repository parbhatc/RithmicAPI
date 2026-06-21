#!/usr/bin/env node
/** Tick-bar history replay. */
import { init, ChartSession } from "../index.js";
import { credentials, symbolPair } from "./env.mjs";

await init();
const chart = await ChartSession.open({
  ...credentials(),
  ...symbolPair(),
  gatewayName: process.env.RITHMIC_GATEWAY ?? "Chicago",
  plants: { ticker: false, history: true, order: false, pnl: false },
});

const bars = await chart.planets.history.loadTick({
  resolution: process.env.RITHMIC_TICK_RESOLUTION ?? "100T",
  countback: Number(process.env.RITHMIC_COUNTBACK ?? 50),
});

console.log(`tick bars: ${bars.length}`);
chart.close();
