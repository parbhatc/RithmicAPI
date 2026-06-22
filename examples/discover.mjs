#!/usr/bin/env node
/** List systems and regional gateway URLs. */
import { init, discover } from "../index.js";

await init();
const systemName = process.env.RITHMIC_SYSTEM ?? "LucidTrading";
const { systems, gateways } = await discover(systemName);
console.log("systems:", systems.length);
console.log("gateways:", gateways.map((g) => `${g.name} → ${g.uri}`).join("\n"));
