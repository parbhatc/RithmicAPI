/**
 * TradeSea-accuracy bootstrap + live trade wiring for FormingBarManager.
 */
import { MarketUpdatePreset } from "./market-enums.js";

export const TRADESEA_ACCURACY_BOOTSTRAP = {
  fast: false,
  tickFallback: true,
  useCache: true,
};

/**
 * Wire LastTrade → forming updates (no second live.start).
 * @param {import("./forming-bar-manager.js").FormingBarManager} mgr
 * @param {{ on: Function, off: Function }} session
 */
export function attachFormingLiveTrades(mgr, session) {
  const handler = (trade) => {
    mgr.onTrade(trade);
    mgr.syncFromLastTrade();
  };
  session.on("trade", handler);
  return () => session.off("trade", handler);
}

/**
 * Bootstrap with TradeSea-parity settings and attach live trade handler.
 * @param {import("./forming-bar-manager.js").FormingBarManager} mgr
 * @param {object} options
 */
export async function bootstrapRithmicAccuracy(mgr, options = {}) {
  const {
    resolutions,
    tradeSeaAccessToken = process.env.TRADESEA_ACCESS_TOKEN,
    weeklyPriceAdjust = process.env.TRADESEA_WEEKLY_ADJUST != null
      ? Number(process.env.TRADESEA_WEEKLY_ADJUST)
      : null,
    timeoutMs = 120_000,
    nowSec = Math.floor(Date.now() / 1000),
    skipAttachLive = false,
    skipAttachTrades = false,
    prefetchQuote = false,
    ...rest
  } = options;

  const result = await mgr.bootstrap({
    resolutions,
    nowSec,
    timeoutMs,
    tradeSeaAccessToken,
    weeklyPriceAdjust,
    accuracy: "tradesea",
    ...TRADESEA_ACCURACY_BOOTSTRAP,
    ...rest,
  });

  if (!skipAttachLive) {
    await mgr.attachLive({ updateBits: MarketUpdatePreset.QUOTE });
  } else if (!skipAttachTrades) {
    attachFormingLiveTrades(mgr, mgr.session);
  } else if (prefetchQuote) {
    await mgr.session.startLive({ updateBits: MarketUpdatePreset.QUOTE }).catch(() => {});
  }

  mgr.syncFromLastTrade();
  return result;
}
