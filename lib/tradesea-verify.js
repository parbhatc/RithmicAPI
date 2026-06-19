/**
 * Read-only TradeSea MDS snapshot for verification (does not modify Rithmic data).
 */
import { TradeseaMdsClient } from "./tradesea-mds-client.js";
import { TradeseaMarketBookStore, tradeseaBookToStatus } from "./tradesea-market-book.js";
import { toTradeseaResolution, tradeseaBarUnix } from "./tradesea-resolutions.js";
import { fetchTradeseaHistory, lastTradeseaBar } from "./tradesea-history.js";

const DEFAULT_CONNECTION_USER_ID =
  "dDqVtke0T1bbMKI-g6JpZKpOT1FCUzI5NzQ2omV1q0xULTFYRDgxWjlEoWSDonNurEx1Y2lkVHJhZGluZ6NmY22sTHVjaWRUcmFkaW5nomlirEx1Y2lkVHJhZGluZw";
const DEFAULT_CONNECTION_GROUP_ID =
  "9ab078c1665d83855967508f934e74da32f1bc08e6b1ae93760db21324daca22";

function wsBar(msg) {
  if (!msg) return null;
  return {
    marker: tradeseaBarUnix(msg.t),
    open: Number(msg.o),
    high: Number(msg.h),
    low: Number(msg.l),
    close: Number(msg.c),
    volume: msg.v != null ? Number(msg.v) : undefined,
  };
}

/**
 * Connect TradeSea MDS briefly and collect reference forming + market snapshots.
 * @returns {Promise<{ forming: Map<string, object>, market: object|null, close: () => Promise<void> }>}
 */
export async function fetchTradeSeaReference({
  accessToken,
  refreshToken,
  connectionUserId = process.env.TRADESEA_CONNECTION_USER_ID ?? DEFAULT_CONNECTION_USER_ID,
  connectionGroupId = process.env.TRADESEA_CONNECTION_GROUP_ID ?? DEFAULT_CONNECTION_GROUP_ID,
  streamSymbol = "CME:NQ",
  resolutions,
  waitForWsMs = 5000,
  waitForMarketMs = 4000,
  seedFromHistory = true,
} = {}) {
  if (!accessToken) throw new Error("fetchTradeSeaReference: accessToken required");
  if (!resolutions?.length) throw new Error("fetchTradeSeaReference: resolutions required");

  const mds = new TradeseaMdsClient();
  const book = new TradeseaMarketBookStore();
  const forming = new Map();

  const tsRes = [...new Set(resolutions.map((r) => toTradeseaResolution(r)))];

  if (seedFromHistory) {
    const nowSec = Math.floor(Date.now() / 1000);
    await Promise.all(
      tsRes.map(async (r) => {
        try {
          const payload = await fetchTradeseaHistory({
            accessToken,
            refreshToken,
            connectionUserId,
            connectionGroupId,
            streamSymbol,
            resolution: r,
            fromSec: nowSec - 3 * 86_400,
            toSec: nowSec + 60,
            countback: 3,
          });
          const bar = lastTradeseaBar(payload);
          if (bar) forming.set(r, { ...bar, marker: tradeseaBarUnix(bar.marker) ?? bar.marker });
        } catch {
          /* ignore */
        }
      }),
    );
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("TradeSea reference MDS timeout"));
    }, 20_000);
    const cleanup = () => {
      clearTimeout(timer);
      mds.off("open", onOpen);
      mds.off("error", onErr);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onErr = (e) => {
      cleanup();
      reject(e);
    };
    mds.once("open", onOpen);
    mds.once("error", onErr);
    mds.connect({ connectionUserId, connectionGroupId, accessToken, refreshToken });
  });

  mds.on("candle", (msg) => {
    const r = String(msg.r ?? "");
    const bar = wsBar(msg);
    if (r && bar) forming.set(r, bar);
  });
  mds.on("ltp", (msg) => {
    if (Number.isFinite(Number(msg.p))) {
      book.applyLtp(String(msg.id || streamSymbol), Number(msg.p));
    }
  });
  mds.on("bestBidAsk", (msg) => {
    book.applyBestBidAsk(String(msg.id || streamSymbol), msg);
  });
  mds.on("quotes", (msg) => {
    book.applyQuotes(String(msg.id || streamSymbol), msg);
  });

  const candleSub = mds.subscribeCandles([streamSymbol], tsRes);
  const marketSubs = mds.subscribeMarketBook([streamSymbol]);

  const waitCandles = tsRes.filter((r) => r.toUpperCase() !== "1M");
  await Promise.all([
    waitCandles.length ? mds.waitForCandles(waitCandles, waitForWsMs) : Promise.resolve(),
    mds.waitForMarket({ timeoutMs: waitForMarketMs }),
  ]);

  for (const r of tsRes) {
    const fromWs = wsBar(mds.getLatestCandle(r));
    if (fromWs) forming.set(r, fromWs);
    if (r.toUpperCase() === "1M") {
      const from1 = wsBar(mds.getLatestCandle("1"));
      if (from1) forming.set("1M", from1);
    }
  }

  const market = tradeseaBookToStatus(book.get(streamSymbol), {});

  async function close() {
    mds.unsubscribe(candleSub);
    mds.unsubscribe(marketSubs);
    mds.close();
  }

  return { forming, market, close };
}

/** Compare Rithmic forming bar vs TradeSea reference bar. */
export function compareFormingBar(ours, ref, eps = 1) {
  if (!ours || !ref) return { ok: false, fields: {} };
  const fields = {
    open: Math.abs(Number(ours.open) - Number(ref.open)) <= eps,
    high: Math.abs(Number(ours.high) - Number(ref.high)) <= eps,
    low: Math.abs(Number(ours.low) - Number(ref.low)) <= eps,
    close: Math.abs(Number(ours.close) - Number(ref.close)) <= eps,
  };
  return { ok: Object.values(fields).every(Boolean), fields };
}

export function compareMarket(ours, ref, eps = 0.01) {
  if (!ours || !ref) return { ok: false };
  const ok =
    Math.abs(Number(ours.last) - Number(ref.last)) <= eps &&
    Math.abs(Number(ours.bid) - Number(ref.bid)) <= eps &&
    Math.abs(Number(ours.ask) - Number(ref.ask)) <= eps;
  return { ok };
}
