/**
 * TradingView-style history via ChartSession.loadHistory (compat payload).
 *
 *   npm run example:tv-15m
 *   RITHMIC_COMPARE_API=1   — also fetch localhost:3000 and diff
 */
import {
  ChartSession,
  HistoryQuery,
  MarketUpdatePreset,
} from "../index.js";

const user = process.env.RITHMIC_USER;
const password = process.env.RITHMIC_PASSWORD;
if (!user || !password) {
  console.error("Set RITHMIC_USER and RITHMIC_PASSWORD in .env");
  process.exit(1);
}

const symbol = process.env.RITHMIC_SYMBOL ?? "NQ";
const exchange = process.env.RITHMIC_EXCHANGE ?? "CME";
const resolution = Number(process.env.RITHMIC_TIME_RESOLUTION ?? "15", 10);
const countback = Number(process.env.RITHMIC_COUNTBACK ?? "300", 10);
const compareApi = process.env.RITHMIC_COMPARE_API === "1";
const apiBase =
  process.env.RITHMIC_HISTORY_API_URL ??
  "http://localhost:3000/api/rithmic/history";
const startLive = process.env.RITHMIC_START_LIVE === "1";

const nowSec = Math.floor(Date.now() / 1000);
const to =
  process.env.RITHMIC_TO != null
    ? Math.floor(Number(process.env.RITHMIC_TO))
    : nowSec + 60;
const from =
  process.env.RITHMIC_FROM != null
    ? Math.floor(Number(process.env.RITHMIC_FROM))
    : to - countback * HistoryQuery.parseResolution(resolution).periodSeconds;

const fmtPrice = (n) => (n == null ? "—" : Number(n).toFixed(2));
const fmtVol = (n) => (n == null ? "—" : String(Math.round(n)));
const fmtTime = (sec) =>
  sec == null ? "—" : new Date(Number(sec) * 1000).toLocaleString();

function logBar(b, label) {
  console.log(
    `${label}  ${fmtTime(b.marker)}  O ${fmtPrice(b.open)}  H ${fmtPrice(b.high)}  L ${fmtPrice(b.low)}  C ${fmtPrice(b.close)}  V ${fmtVol(b.volume)}`,
  );
}

function buildQueryString() {
  return new URLSearchParams({
    symbol,
    exchange,
    resolution: String(resolution),
    from: String(from),
    to: String(to),
    countback: String(countback),
  }).toString();
}

function barAtTime(payload, marker) {
  const i = payload.t.findIndex((t) => Number(t) === Number(marker));
  if (i < 0) return null;
  return {
    t: payload.t[i],
    o: payload.o[i],
    h: payload.h[i],
    l: payload.l[i],
    c: payload.c[i],
    v: payload.v[i],
  };
}

console.log("TradingView history (ChartSession.loadHistory + compat:true)");
console.log(`  Now: ${fmtTime(nowSec)}`);
console.log(`  ?${buildQueryString()}\n`);

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
  let bars = await chart.loadHistory({ resolution, from, to, countback });
  if (bars.length > countback) {
    bars = HistoryQuery.trimCountbackBars(bars, countback, "to");
  }
  console.log(`Loaded ${bars.length} bar(s) in ${Math.round(performance.now() - t0)} ms\n`);

  const payload = HistoryQuery.barsToHistoryPayload(bars, { compat: true });

  console.log(`── Payload (${payload.t.length} bars, compat:true) ──`);
  if (payload.t.length) {
    const i = payload.t.length - 1;
    console.log(`  t[0]    ${payload.t[0]}  ${fmtTime(payload.t[0])}`);
    console.log(`  t[last] ${payload.t[i]}  ${fmtTime(payload.t[i])}`);
  }

  if (bars.length) logBar(bars.at(-1), `Latest ${resolution}m`);

  if (compareApi) {
    const url = `${apiBase}?${buildQueryString()}`;
    console.log(`\nGET ${url}`);
    try {
      const api = await fetch(url).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });
      const lastMarker = bars.at(-1)?.marker;
      const localBar = lastMarker != null ? barAtTime(payload, lastMarker) : null;
      const apiBar = lastMarker != null ? barAtTime(api, lastMarker) : null;
      if (localBar && apiBar) {
        const ok =
          Math.abs(localBar.o - apiBar.o) < 0.01 &&
          Math.abs(localBar.h - apiBar.h) < 0.01 &&
          Math.abs(localBar.l - apiBar.l) < 0.01 &&
          Math.abs(localBar.c - apiBar.c) < 0.01;
        console.log(ok ? "Last bar match: YES" : "Last bar match: NO");
      }
    } catch (e) {
      console.error(`API compare failed: ${e.message}`);
    }
  } else {
    console.log("\nSet RITHMIC_COMPARE_API=1 to diff against localhost:3000");
  }

  if (startLive) {
    chart.on("bar", (bar) => {
      logBar(bar, `Live ${resolution}m`);
      console.log();
    });
    console.log("\nLive on (Ctrl+C to stop)…\n");
    await chart.startLive({ updateBits: MarketUpdatePreset.QUOTE });
    await new Promise((resolve) => process.once("SIGINT", resolve));
  }
} finally {
  await chart.stopLive().catch(() => {});
  chart.close();
}
