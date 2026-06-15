/**
 * TradingView-style history — same path as Auren GET /api/rithmic/history (CandleLayer + compat).
 *
 *   npm run example:tv-15m
 *   RITHMIC_COMPARE_API=1   — also fetch localhost:3000 and diff the 6:15 bar
 */
import {
  ChartSession,
  CandleLayer,
  parseResolution,
  barsToHistoryPayload,
  trimCountbackBars,
  bucketOpen,
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
const includeForming = process.env.RITHMIC_INCLUDE_FORMING !== "0";
const compareApi = process.env.RITHMIC_COMPARE_API === "1";
const apiBase =
  process.env.RITHMIC_HISTORY_API_URL ??
  "http://localhost:3000/api/rithmic/history";
const startLive = process.env.RITHMIC_START_LIVE === "1";

const { periodSeconds, barType, barTypePeriod } = parseResolution(resolution);
const nowSec = Math.floor(Date.now() / 1000);
const to =
  process.env.RITHMIC_TO != null
    ? Math.floor(Number(process.env.RITHMIC_TO))
    : nowSec + 60;
const from =
  process.env.RITHMIC_FROM != null
    ? Math.floor(Number(process.env.RITHMIC_FROM))
    : to - countback * periodSeconds;
const currentBucket = bucketOpen(nowSec, periodSeconds);

const fmtPrice = (n) => (n == null ? "—" : Number(n).toFixed(2));
const fmtVol = (n) => (n == null ? "—" : String(Math.round(n)));
const fmtTime = (sec) =>
  sec == null ? "—" : new Date(Number(sec) * 1000).toLocaleString();

function logBar(b, label) {
  const tag = b.forming ? "forming" : "closed";
  const src = b.replaySource ? ` (${b.replaySource})` : "";
  console.log(
    `${label} [${tag}]${src}  ${fmtTime(b.marker)}  O ${fmtPrice(b.open)}  H ${fmtPrice(b.high)}  L ${fmtPrice(b.low)}  C ${fmtPrice(b.close)}  V ${fmtVol(b.volume)}`,
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
    include_forming: includeForming ? "true" : "false",
  }).toString();
}

function barAtMarker(payload, marker) {
  const i = payload.t.findIndex((t) => Number(t) === Number(marker));
  if (i < 0) return null;
  return {
    t: payload.t[i],
    o: payload.o[i],
    h: payload.h[i],
    l: payload.l[i],
    c: payload.c[i],
    v: payload.v[i],
    i,
  };
}

function compareAtBucket(label, a, b, marker) {
  console.log(`\n── Compare @ ${fmtTime(marker)} (${label}) ──`);
  if (!a) {
    console.log("  CandleLayer: (no bar at this marker in payload)");
  } else {
    console.log(
      `  CandleLayer   O ${fmtPrice(a.o)}  H ${fmtPrice(a.h)}  L ${fmtPrice(a.l)}  C ${fmtPrice(a.c)}  t=${a.t}`,
    );
  }
  if (!b) {
    console.log("  API:         (no bar at this marker — may use compat shift or old replay path)");
  } else {
    console.log(
      `  API           O ${fmtPrice(b.o)}  H ${fmtPrice(b.h)}  L ${fmtPrice(b.l)}  C ${fmtPrice(b.c)}  t=${b.t}`,
    );
  }
  if (a && b) {
    const ok =
      Math.abs(a.o - b.o) < 0.01 &&
      Math.abs(a.h - b.h) < 0.01 &&
      Math.abs(a.l - b.l) < 0.01 &&
      Math.abs(a.c - b.c) < 0.01;
    console.log(ok ? "  Match: YES" : "  Match: NO (restart Auren server after rithmic-api update)");
  }
}

console.log("TradingView history (CandleLayer + compat:true, same as Auren API)");
console.log(`  Now: ${fmtTime(nowSec)}  |  open ${resolution}m bucket: ${fmtTime(currentBucket)}`);
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

const layer = new CandleLayer(chart);

try {
  const t0 = performance.now();
  await layer.load1m({
    alsoFor: [resolution],
    countback,
    include_forming: includeForming,
  });
  console.log(`Loaded in ${Math.round(performance.now() - t0)} ms\n`);

  const closed = layer.getClosed(resolution);
  const forming = layer.getForming(resolution);
  let series = layer.getSeries(resolution);
  if (series.length > countback) {
    series = trimCountbackBars(series, countback, "to");
  }
  const payload = barsToHistoryPayload(series, { compat: true }); // same as Auren API

  console.log(`── Payload (${payload.t.length} bars, compat:true) ──`);
  if (payload.t.length) {
    const i = payload.t.length - 1;
    console.log(`  t[0]    ${payload.t[0]}  ${fmtTime(payload.t[0])}`);
    console.log(`  t[last] ${payload.t[i]}  ${fmtTime(payload.t[i])}`);
  }

  console.log(`\n── ${resolution}m candles ──`);
  if (closed.length) logBar(closed.at(-1), `Latest closed ${resolution}m`);
  if (forming) {
    logBar(forming, `Current ${resolution}m (forming)`);
  }

  const layerBar = barAtMarker(payload, currentBucket);
  if (compareApi) {
    const url = `${apiBase}?${buildQueryString()}`;
    console.log(`\nGET ${url}`);
    try {
      const api = await fetch(url).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });
      const apiBar = barAtMarker(api, currentBucket);
      const apiLast =
        api.t?.length > 0
          ? {
              t: api.t.at(-1),
              o: api.o.at(-1),
              h: api.h.at(-1),
              l: api.l.at(-1),
              c: api.c.at(-1),
            }
          : null;
      compareAtBucket("marker", layerBar ?? forming, apiBar, currentBucket);
      if (apiLast && (!apiBar || apiLast.t !== apiBar.t)) {
        console.log("\n── API payload last bar (often ≠ forming marker with compat) ──");
        console.log(
          `  t=${apiLast.t}  ${fmtTime(apiLast.t)}  O ${fmtPrice(apiLast.o)}  H ${fmtPrice(apiLast.h)}  L ${fmtPrice(apiLast.l)}  C ${fmtPrice(apiLast.c)}`,
        );
      }
    } catch (e) {
      console.error(`API compare failed: ${e.message}`);
    }
  } else {
    console.log(
      `\nForming bar marker=${currentBucket} in payload:`,
      layerBar
        ? `O ${fmtPrice(layerBar.o)} H ${fmtPrice(layerBar.h)} L ${fmtPrice(layerBar.l)} C ${fmtPrice(layerBar.c)}`
        : "not found (check compat shift)",
    );
    console.log("Set RITHMIC_COMPARE_API=1 to diff against localhost:3000");
  }

  if (startLive) {
    let lastKey;
    chart.on("trade", (trade) => {
      layer.onTrade(trade);
      const bar = layer.getForming(resolution);
      if (!bar) return;
      const key = `${bar.open}|${bar.high}|${bar.low}|${bar.close}`;
      if (key === lastKey) return;
      lastKey = key;
      logBar(bar, `Live forming ${resolution}m`);
      console.log();
    });

    console.log("\nLive on (Ctrl+C to stop)…\n");
    await chart.startLive({
      updateBits: MarketUpdatePreset.QUOTE,
      barType,
      barPeriod: barTypePeriod,
      exactBar: layer.forming1m,
      exactFormingBar: false,
      seedFormingFrom: layer.forming1m,
    });
    await new Promise((resolve) => process.once("SIGINT", resolve));
  }
} finally {
  await chart.stopLive().catch(() => {});
  chart.close();
}
