#!/usr/bin/env node
/** Live 1m forming + closed candle OHLC (forming vs Rithmic TimeBar). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  init,
  ChartSession,
  wrapChartSession,
  FormingBarManager,
  bootstrapRithmicAccuracy,
  MarketUpdatePreset,
} from "../index.js";
import { ONE_MINUTE_PERIOD } from "../lib/forming/candle-layer.js";
import { bucketOpen } from "../lib/forming/forming-bar.js";
import { credentials, symbolPair } from "./env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(__dirname, "logs", "chartLive.txt");

const runSec = Number(process.env.RITHMIC_LIVE_SECONDS ?? 0);
const STALE_MS = Number(process.env.RITHMIC_STALE_MS ?? 45_000);
const WATCH_MS = Number(process.env.RITHMIC_WATCH_MS ?? 10_000);
const { symbol } = symbolPair();
const useCompat = Boolean(process.env.TRADESEA_ACCESS_TOKEN);

process.env.FORMING_1M_DEBUG = "1";

const TZ = "America/New_York";
const timeOpts = {
  timeZone: TZ,
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
};

const fmt = (n) => (n == null ? "—" : Number(n).toFixed(2));
const fmtWall = (ms = Date.now()) => new Date(ms).toLocaleString("en-US", timeOpts);
const fmtTime = (sec) => new Date(Number(sec) * 1000).toLocaleString("en-US", timeOpts);

const fmtOhlc = (bar) =>
  `O=${fmt(bar.open)} H=${fmt(bar.high)} L=${fmt(bar.low)} C=${fmt(bar.close)}`;

const fmtChg = (open, close) => {
  const o = Number(open);
  const c = Number(close);
  if (!Number.isFinite(o) || !Number.isFinite(c)) return "";
  const pts = c - o;
  const pct = o !== 0 ? (pts / o) * 100 : 0;
  const sign = pts >= 0 ? "+" : "";
  return ` ${sign}${pts.toFixed(2)} (${sign}${pct.toFixed(2)}%)`;
};

const fmtOhlcLive = (bar) => `${fmtOhlc(bar)}${fmtChg(bar.open, bar.close)}`;

const fmtTradeTime = (t) => {
  const ssboe = Number(t?.ssboe);
  return Number.isFinite(ssboe) && ssboe > 0 ? fmtTime(ssboe) : fmtWall();
};

const WS_STATES = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];

fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
const logStream = fs.createWriteStream(LOG_PATH, { flags: "w" });

function logFile(line) {
  logStream.write(`${line}\n`);
}

function logDetail(line) {
  logFile(`[${fmtWall()}] ${line}`);
}

function term(line) {
  console.log(line);
}

const origConsoleLog = console.log.bind(console);
let formingDebugBlock = false;
console.log = (...args) => {
  const line = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
  if (line.includes("[1m-forming]") || line.includes("[1m-open-audit]")) {
    formingDebugBlock = line.includes("[1m-open-audit]");
    logFile(`[${fmtWall()}] ${line}`);
    return;
  }
  if (line.includes("bucket=") && line.includes("forming=")) {
    logFile(`[${fmtWall()}] ${line.trim()}`);
    return;
  }
  if (formingDebugBlock && /^\s{2,}/.test(line)) {
    logFile(`[${fmtWall()}] ${line}`);
    return;
  }
  formingDebugBlock = false;
  origConsoleLog(...args);
};

function wsLabel(ws) {
  if (!ws) return "missing";
  return WS_STATES[ws.readyState] ?? String(ws.readyState);
}

function termLatest(bar) {
  if (!bar) return;
  term(`Latest candle: @ ${fmtTime(bar.marker)} ${fmtOhlc(bar)}`);
  logDetail(`Latest candle @ ${fmtTime(bar.marker)} ${fmtOhlc(bar)}`);
}

function termLive(bar) {
  if (!bar) return;
  term(`Live: @ ${fmtTime(bar.marker)} ${fmtOhlcLive(bar)}`);
  logDetail(`Live @ ${fmtTime(bar.marker)} ${fmtOhlcLive(bar)}`);
}

function termNewBar(bar) {
  if (!bar) return;
  term(`New Bar: @ ${fmtTime(bar.marker)} ${fmtOhlc(bar)}`);
  logDetail(`New Bar @ ${fmtTime(bar.marker)} ${fmtOhlc(bar)}`);
}

function termClosed(source, bar, chartOpenSec) {
  if (!bar) return;
  const t = chartOpenSec ?? Number(bar.marker);
  term(`Closed (${source}): @ ${fmtTime(t)} ${fmtOhlc(bar)}`);
  logDetail(`Closed (${source}) @ ${fmtTime(t)} ${fmtOhlc(bar)}`);
}

function wireWsClient(chart, name, client) {
  const ws = client?.ws;
  if (!ws || ws.__chartLiveWired) return;
  ws.__chartLiveWired = true;
  const msg = `WS connected (${name}): ${chart.uri}`;
  if (ws.readyState === 1) {
    term(msg);
    logDetail(msg);
  } else {
    ws.once("open", () => {
      term(msg);
      logDetail(msg);
    });
  }
  ws.on("close", (code, reason) => {
    const r = reason?.toString?.() || "";
    const line = `WS disconnected (${name}): code=${code}${r ? ` ${r}` : ""}`;
    term(`${line} @ ${fmtWall()}`);
    logDetail(line);
    ws.__chartLiveWired = false;
    scheduleEnsureLive(chart, { delayMs: 1500, reason: `ws-close:${name}` });
  });
  ws.on("error", (err) => {
    const line = `WS error (${name}): ${err?.message ?? err}`;
    term(`${line} @ ${fmtWall()}`);
    logDetail(line);
  });
}

function wireWsStatus(chart) {
  wireWsClient(chart, "ticker", chart.tickerClient);
  wireWsClient(chart, "history", chart.historyClient);
}

function touchActivity(state) {
  state.lastPacketAt = Date.now();
}

function current1mOpen() {
  return bucketOpen(Math.floor(Date.now() / 1000), ONE_MINUTE_PERIOD);
}

function resumeHistoryPump(chart) {
  chart.liveFeed?.resumeHistoryPump();
}

function plantsOpen(chart) {
  return (
    chart.tickerClient?.ws?.readyState === 1 &&
    chart.historyClient?.ws?.readyState === 1
  );
}

function plantNeedsReconnect(client) {
  const rs = client?.ws?.readyState;
  return rs == null || rs === 2 || rs === 3;
}

async function waitPlantsOpen(chart, maxMs = 20_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (plantsOpen(chart)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let ensureLiveChain = Promise.resolve();
let lastLiveStallAt = 0;

function scheduleEnsureLive(chart, { delayMs = 0, reason = "" } = {}) {
  ensureLiveChain = ensureLiveChain
    .then(async () => {
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      await ensureLive(chart, reason);
    })
    .catch((err) => {
      const line = `ensureLive chain failed: ${err?.message ?? err}`;
      term(`${line} @ ${fmtWall()}`);
      logDetail(line);
    });
  return ensureLiveChain;
}

async function ensureLive(chart, reason = "") {
  const feed = chart.liveFeed;
  if (feed?.live && feed.pumps?.length >= 2 && plantsOpen(chart)) {
    resumeHistoryPump(chart);
    return;
  }

  if (!plantsOpen(chart)) {
    const needsReconnect =
      plantNeedsReconnect(chart.tickerClient) ||
      plantNeedsReconnect(chart.historyClient);
    if (needsReconnect) {
      try {
        logDetail(`reconnecting plants${reason ? ` (${reason})` : ""}`);
        await chart.reconnectDataPlants();
        wireWsStatus(chart);
      } catch (err) {
        const line = `reconnect failed: ${err?.message ?? err}`;
        logDetail(line);
      }
    }
    if (!plantsOpen(chart)) {
      const ready = await waitPlantsOpen(chart, 10_000);
      if (!ready) {
        logDetail(`ensureLive skipped — WS timeout${reason ? ` (${reason})` : ""}`);
        return;
      }
    }
  }

  try {
    if (feed?.live) await chart.planets.live.stop();
  } catch {
    /* ignore */
  }

  try {
    await chart.planets.live.start({ updateBits: MarketUpdatePreset.CHART });
    logDetail(`live feed (re)started${reason ? ` (${reason})` : ""}`);
  } catch (err) {
    const line = `ensureLive failed: ${err?.message ?? err}`;
    term(`${line} @ ${fmtWall()}`);
    logDetail(line);
  }
}

await init();
const chart = await ChartSession.open({
  ...credentials(),
  ...symbolPair(),
  gatewayName: process.env.RITHMIC_GATEWAY ?? "Chicago",
  plants: { ticker: true, history: true, order: false, pnl: false },
});
wireWsStatus(chart);

const mgr = new FormingBarManager(wrapChartSession(chart));

logDetail("bootstrap 1m start");
if (useCompat) {
  logDetail("bootstrap rithmic accuracy (compat, TradeSea open/close)");
  await bootstrapRithmicAccuracy(mgr, {
    resolutions: [1],
    skipAttachLive: true,
    prefetchQuote: false,
  });
} else {
  logDetail("bootstrap 1m shared");
  await mgr.bootstrap({ resolutions: [1] });
}
const forming0 = mgr.getForming(1);
logDetail(
  `bootstrap done closed=${mgr.closed1m?.length ?? 0} forming=${forming0 ? fmtTime(forming0.marker) : "none"}`,
);

const header = `Symbol: ${symbol}  Timeframe: 1 min  Compat: ${useCompat ? "Enabled" : "Disabled"}`;
term(header);
logDetail(header);
term(`Logging to ${path.relative(process.cwd(), LOG_PATH)}`);
logFile(`=== session ${new Date().toISOString()} ${symbol} ===`);

termLatest(mgr.closed1m?.at(-1));

const state = { lastPacketAt: Date.now(), refreshInflight: false };
let lastLiveSig = null;
let lastLiveBucket = null;
let lastTimeBarMarker = 0;
let lastReceiveErrLog = 0;
let lastStaleLogAt = 0;

function emitLive(bar) {
  if (!bar?.forming) return;
  if (Number(bar.marker) < current1mOpen()) return;
  const sig = `${bar.marker}:${bar.open}:${bar.high}:${bar.low}:${bar.close}`;
  if (sig === lastLiveSig) return;

  const bucket = Number(bar.marker);
  if (bucket !== lastLiveBucket) {
    lastLiveBucket = bucket;
    lastLiveSig = sig;
    termNewBar(bar);
    return;
  }

  lastLiveSig = sig;
  termLive(bar);
}

async function rollForming(endMarker, timebar) {
  if (state.refreshInflight) return;
  state.refreshInflight = true;
  const bucketOpenSec = endMarker - ONE_MINUTE_PERIOD;
  try {
    const formingClosed = mgr.getForming(1);
    if (formingClosed && Number(formingClosed.marker) === bucketOpenSec) {
      termClosed("forming", formingClosed, bucketOpenSec);
    }
    if (timebar) {
      termClosed("timebar", timebar, bucketOpenSec);
    }
    lastLiveSig = null;
    await Promise.race([
      mgr.refreshCurrent1m(Math.floor(Date.now() / 1000), 8000, {
        closedBucketOpen: bucketOpenSec,
        rollover: true,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("refresh timeout")), 12_000),
      ),
    ]);
  } catch (err) {
    const line = `Roll refresh failed: ${err?.message ?? err}`;
    term(`${line} @ ${fmtWall()}`);
    logDetail(line);
  } finally {
    resumeHistoryPump(chart);
    state.refreshInflight = false;
  }
  await ensureLive(chart);
  mgr.syncFromLastTrade();
  emitLive(mgr.getForming(1));
}

mgr.on("formingBar", ({ bar }) => {
  touchActivity(state);
  emitLive(bar);
});

chart.on("trade", (t) => {
  touchActivity(state);
  const size = t.size ?? t.volume ?? t.qty ?? 1;
  logFile(`[${fmtTradeTime(t)}] trade ${fmt(t.price)} ${size}`);
});

chart.on("quote", () => {
  touchActivity(state);
});

chart.on("bar", (tb) => {
  touchActivity(state);
  const endMarker = Number(tb.marker);
  if (!endMarker || endMarker === lastTimeBarMarker) return;
  lastTimeBarMarker = endMarker;
  logDetail(`timebar close marker=${fmtTime(endMarker - ONE_MINUTE_PERIOD)} ${fmtOhlc(tb)}`);
  void rollForming(endMarker, tb);
});

chart.on("liveStall", ({ plant, readyState }) => {
  const now = Date.now();
  if (now - lastLiveStallAt < 2000) return;
  lastLiveStallAt = now;
  const line = `Live pump stopped (${plant}) ws=${WS_STATES[readyState] ?? readyState}`;
  term(`${line} @ ${fmtWall()}`);
  logDetail(line);
  scheduleEnsureLive(chart, { delayMs: 500, reason: `stall:${plant}` });
});

chart.on("liveReceiveError", ({ plant, error }) => {
  const now = Date.now();
  if (now - lastReceiveErrLog < 15_000) return;
  lastReceiveErrLog = now;
  const line = `Live receive error (${plant}): ${error?.message ?? error}`;
  term(`${line} @ ${fmtWall()}`);
  logDetail(line);
});

await ensureLive(chart);
logDetail("live feed started (CHART preset)");
await mgr.attachLive({ skipStartLive: true });
mgr.syncFromLastTrade();
emitLive(mgr.getForming(1));

const watch = setInterval(() => {
  const now = Date.now();
  const staleSec = (now - state.lastPacketAt) / 1000;
  const ticker = wsLabel(chart.tickerClient?.ws);
  const history = wsLabel(chart.historyClient?.ws);
  const pumpActive = chart.liveFeed?.live;

  if (chart.liveFeed?.historyPumpPaused) {
    resumeHistoryPump(chart);
    logDetail("history pump force-resumed");
  }

  if (ticker !== "OPEN" || history !== "OPEN" || !pumpActive) {
    const line = `WS status: ticker=${ticker} history=${history} livePump=${pumpActive ? "on" : "off"}`;
    term(`${line} @ ${fmtWall()}`);
    logDetail(line);
    scheduleEnsureLive(chart, { reason: "watch" });
  }

  if (staleSec * 1000 >= STALE_MS && now - lastStaleLogAt >= STALE_MS) {
    lastStaleLogAt = now;
    const line = `No market data for ${staleSec.toFixed(0)}s`;
    term(`${line} @ ${fmtWall()}`);
    logDetail(line);
    mgr.syncFromLastTrade();
    emitLive(mgr.getForming(1));
  }

  const nowSec = Math.floor(now / 1000);
  const curBucket = bucketOpen(nowSec, ONE_MINUTE_PERIOD);
  const forming = mgr.getForming(1);
  const formingBucket = forming ? Number(forming.marker) : null;
  if (
    formingBucket != null &&
    formingBucket < curBucket &&
    !state.refreshInflight &&
    nowSec >= curBucket + 3
  ) {
    const line = `Minute rolled without TimeBar (${fmtTime(formingBucket)} → ${fmtTime(curBucket)})`;
    term(`${line} @ ${fmtWall()}`);
    logDetail(line);
    const endMarker = formingBucket + ONE_MINUTE_PERIOD;
    if (endMarker > lastTimeBarMarker) lastTimeBarMarker = endMarker;
    void rollForming(endMarker, null);
  }
}, WATCH_MS);
watch.unref?.();

const runMsg =
  runSec > 0
    ? `Streaming for ${runSec}s (Ctrl+C to stop early)…`
    : `Streaming until Ctrl+C…`;
term(runMsg);
logDetail(runMsg);

await new Promise((resolve) => {
  if (runSec > 0) setTimeout(resolve, runSec * 1000);
  process.once("SIGINT", resolve);
});

clearInterval(watch);
await chart.planets.live.stop();
await mgr.detachLive();
chart.close();

await new Promise((resolve) => logStream.end(resolve));
term(`Stopped. Full log: ${path.relative(process.cwd(), LOG_PATH)}`);
