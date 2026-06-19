/**
 * Live side-by-side: Rithmic forming vs TradeSea MDS candles (both WS open).
 *
 *   node --env-file=.env examples/compare-live-side-by-side.mjs
 *   COMPARE_DURATION_MS=60000 COMPARE_RESOLUTIONS=15,240 node --env-file=.env ...
 */
import {
  ChartSession,
  FormingBarManager,
  bootstrapRithmicAccuracy,
  TradeseaMdsClient,
  toTradeseaResolution,
  tradeseaBarUnix,
  bucketOpen,
} from "../index.js";

const DURATION_MS = Number(process.env.COMPARE_DURATION_MS ?? "60000");
const INTERVAL_MS = Number(process.env.COMPARE_INTERVAL_MS ?? "5000");
const TOL = Number(process.env.COMPARE_TOL ?? "0.01");
const RESOLUTIONS = (process.env.COMPARE_RESOLUTIONS ?? "15,240")
  .split(",")
  .map((s) => {
    const t = s.trim();
    const n = Number(t);
    return Number.isFinite(n) && t === String(n) ? n : t;
  });

const fmt = (n) => (n == null || !Number.isFinite(Number(n)) ? "—" : Number(n).toFixed(2));
const tol = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= TOL;

function wsBar(msg) {
  if (!msg) return null;
  return {
    marker: tradeseaBarUnix(msg.t),
    open: Number(msg.o),
    high: Number(msg.h),
    low: Number(msg.l),
    close: Number(msg.c),
  };
}

function row(label, r, ts) {
  const ok =
    r &&
    ts &&
    tol(r.open, ts.open) &&
    tol(r.high, ts.high) &&
    tol(r.low, ts.low) &&
    tol(r.close, ts.close);
  const deltas = [];
  if (r && ts) {
    for (const f of ["open", "high", "low", "close"]) {
      const d = Number(r[f]) - Number(ts[f]);
      if (Number.isFinite(d) && Math.abs(d) > TOL) deltas.push(`${f} ${d >= 0 ? "+" : ""}${d.toFixed(2)}`);
    }
  }
  console.log(`  ${String(label).padEnd(4)} ${ok ? "✓" : "✗"}  src=${r?.replaySource ?? "—"}`);
  console.log(
    `       TradeSea  O ${fmt(ts?.open)}  H ${fmt(ts?.high)}  L ${fmt(ts?.low)}  C ${fmt(ts?.close)}`,
  );
  console.log(
    `       Rithmic   O ${fmt(r?.open)}  H ${fmt(r?.high)}  L ${fmt(r?.low)}  C ${fmt(r?.close)}`,
  );
  if (deltas.length) console.log(`       delta: ${deltas.join(", ")}`);
  return ok;
}

const uri = process.env.RITHMIC_URI ?? "wss://rprotocol-mobile.rithmic.com/";
let chart;
for (let attempt = 1; attempt <= 6; attempt++) {
  try {
    chart = await ChartSession.open({
      user: process.env.RITHMIC_USER,
      password: process.env.RITHMIC_PASSWORD,
      systemName: process.env.RITHMIC_SYSTEM ?? "LucidTrading",
      symbol: process.env.RITHMIC_SYMBOL ?? "NQ",
      exchange: process.env.RITHMIC_EXCHANGE ?? "CME",
      uri,
    });
    break;
  } catch (e) {
    if (attempt === 6) throw e;
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
}

const mgr = new FormingBarManager(chart);
await bootstrapRithmicAccuracy(mgr, {
  resolutions: RESOLUTIONS,
  tradeSeaAccessToken: process.env.TRADESEA_ACCESS_TOKEN,
  timeoutMs: 120_000,
});

const tsRes = RESOLUTIONS.map((r) => toTradeseaResolution(r));
const tsBars = new Map();

const mds = new TradeseaMdsClient();
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("TradeSea MDS open timeout")), 20_000);
  mds.once("open", () => {
    clearTimeout(timer);
    resolve();
  });
  mds.once("error", (e) => {
    clearTimeout(timer);
    reject(e);
  });
  mds.connect({
    connectionUserId: process.env.TRADESEA_CONNECTION_USER_ID,
    connectionGroupId: process.env.TRADESEA_CONNECTION_GROUP_ID,
    accessToken: process.env.TRADESEA_ACCESS_TOKEN,
    refreshToken: process.env.TRADESEA_REFRESH_TOKEN,
  });
});

mds.on("candle", (msg) => {
  const r = String(msg.r ?? "");
  const bar = wsBar(msg);
  if (r && bar) tsBars.set(r, bar);
});

mds.subscribeCandles([process.env.TRADESEA_STREAM_SYMBOL ?? "CME:NQ"], tsRes);
await mds.waitForCandles(tsRes, 8000);

console.log(`\nLive compare ${DURATION_MS / 1000}s — resolutions: ${RESOLUTIONS.join(", ")}`);
console.log(`Both WS: Rithmic (ticker+history) + TradeSea MDS\n`);

const stats = { ticks: 0, tsUpdates: 0, snapshots: 0, match: 0, total: 0 };

chart.on("trade", () => {
  stats.ticks++;
});
mds.on("candle", () => {
  stats.tsUpdates++;
});

function snapshot(label) {
  const nowSec = Math.floor(Date.now() / 1000);
  void mgr.refreshCurrent1m(nowSec).then(() => mgr.syncFromLastTrade());

  console.log(`\n── ${label} ──`);
  for (const r of RESOLUTIONS) {
    const tsKey = toTradeseaResolution(r);
    const ours = mgr.getForming(r);
    const ts = tsBars.get(tsKey);
    const bucket = bucketOpen(nowSec, typeof r === "number" ? r * 60 : 86400);
    console.log(`  bucket ${new Date(bucket * 1000).toLocaleString()}`);
    if (row(String(r), ours, ts)) stats.match++;
    stats.total++;
  }

  const st = chart.status;
  const tsMkt = tsBars.get("_market");
  void tsMkt;
  console.log(
    `  market last=${fmt(st.last)} bid=${fmt(st.bid)} ask=${fmt(st.ask)}  (rithmic ticks=${stats.ticks} ts_candles=${stats.tsUpdates})`,
  );
  stats.snapshots++;
}

snapshot("initial");
const timer = setInterval(() => snapshot(new Date().toLocaleTimeString()), INTERVAL_MS);

await new Promise((r) => setTimeout(r, DURATION_MS));
clearInterval(timer);
snapshot("final");

console.log(
  `\nSummary: ${stats.match}/${stats.total} bar checks matched (±${TOL}) across ${stats.snapshots + 1} snapshots`,
);
console.log(`Rithmic trades: ${stats.ticks}  TradeSea candle msgs: ${stats.tsUpdates}`);

mds.close();
await mgr.detachLive?.();
chart.close();
