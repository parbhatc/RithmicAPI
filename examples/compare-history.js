/**
 * Compare fetchHistory (Rithmic) vs external /v1/history for the same query params.
 *
 * Usage:
 *   node --env-file=.env examples/compare-history.js [path-to-history.json]
 *
 * If no file path is provided, set HISTORY_COMPARE_URL to fetch remote JSON.
 */
import { readFile } from "node:fs/promises";
import { fetchHistory } from "../index.js";

const params = {
  resolution: 1,
  from: 1779788481,
  to: 1779929351,
  countback: 300,
};

const historyUrl = process.env.HISTORY_COMPARE_URL;

async function loadExternalHistory(pathArg) {
  if (pathArg) {
    return JSON.parse(await readFile(pathArg, "utf8"));
  }
  if (!historyUrl) {
    throw new Error("Set HISTORY_COMPARE_URL or pass a local JSON path");
  }
  const res = await fetch(historyUrl);
  if (!res.ok) throw new Error(`History HTTP ${res.status}`);
  return res.json();
}

function indexByTime(payload) {
  const map = new Map();
  for (let i = 0; i < payload.t.length; i++) {
    map.set(payload.t[i], i);
  }
  return map;
}

function comparePayloads(a, b, labelA, labelB) {
  const eq = (x, y) => x === y || (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 1e-9);
  const bMap = indexByTime(b);
  let matched = 0;
  let ohlcMismatch = 0;
  let missingInB = 0;
  const samples = [];

  for (let i = 0; i < a.t.length; i++) {
    const t = a.t[i];
    const j = bMap.get(t);
    if (j == null) {
      missingInB++;
      continue;
    }
    matched++;
    const ok =
      eq(a.o[i], b.o[j]) && eq(a.h[i], b.h[j]) && eq(a.l[i], b.l[j]) && eq(a.c[i], b.c[j]);
    if (!ok) {
      ohlcMismatch++;
      if (samples.length < 3) {
        samples.push({
          t,
          a: { o: a.o[i], h: a.h[i], l: a.l[i], c: a.c[i] },
          b: { o: b.o[j], h: b.h[j], l: b.l[j], c: b.c[j] },
        });
      }
    }
  }

  console.log(`\n${labelA} vs ${labelB}`);
  console.log(`  bars A: ${a.t.length}, bars B: ${b.t.length}`);
  console.log(`  shared timestamps: ${matched}`);
  console.log(`  OHLC exact match on shared t: ${matched - ohlcMismatch}`);
  console.log(`  OHLC mismatch: ${ohlcMismatch}`);
  console.log(`  in A but not B: ${missingInB}`);
  if (samples.length) console.log("  sample mismatches:", samples);
}

const user = process.env.RITHMIC_USER;
const password = process.env.RITHMIC_PASSWORD;
if (!user || !password) {
  console.error("Set RITHMIC_USER and RITHMIC_PASSWORD");
  process.exit(1);
}

const externalHistory = await loadExternalHistory(process.argv[2]);

const rithmicMarker = await fetchHistory({
  user,
  password,
  systemName: process.env.RITHMIC_SYSTEM ?? "LucidTrading",
  symbol: "NQ",
  exchange: "CME",
  uri: process.env.RITHMIC_URI,
  gatewayName: process.env.RITHMIC_GATEWAY,
  ...params,
  timeOffset: 0,
});

const rithmicOffsetT = await fetchHistory({
  user,
  password,
  systemName: process.env.RITHMIC_SYSTEM ?? "LucidTrading",
  symbol: "NQ",
  exchange: "CME",
  uri: process.env.RITHMIC_URI,
  gatewayName: process.env.RITHMIC_GATEWAY,
  ...params,
  timeOffset: -60,
});

console.log(
  "External:",
  externalHistory.t?.length,
  "bars",
  "t[0]",
  externalHistory.t?.[0],
  "t[last]",
  externalHistory.t?.at(-1),
);
console.log("Rithmic marker as t:", rithmicMarker.t.length, rithmicMarker.t[0], rithmicMarker.t.at(-1));
console.log("Rithmic marker-60:", rithmicOffsetT.t.length, rithmicOffsetT.t[0], rithmicOffsetT.t.at(-1));

comparePayloads(externalHistory, rithmicOffsetT, "External", "Rithmic (timeOffset -60)");
comparePayloads(externalHistory, rithmicMarker, "External", "Rithmic (marker as t)");
