/**
 * TradeSea-accuracy settings for pure Rithmic (no runtime TradeSea MDS).
 * Use compare-tradesea-forming.mjs with RITHMIC_ONLY=1 to verify against TradeSea.
 */
import { MarketUpdatePreset } from "./market-enums.js";

/** Bootstrap options that maximize Rithmic → TradeSea alignment. */
export const TRADESEA_ACCURACY_BOOTSTRAP = {
  fast: false,
  tickFallback: true,
  awaitSession: true,
  useCache: true,
};

/**
 * Wire Rithmic live feed for TradeSea-style forming updates.
 * @param {import("./forming-bar-manager.js").FormingBarManager} mgr
 * @param {import("../ChartSession.js").ChartSession} chart
 */
export async function attachRithmicAccuracy(mgr, chart) {
  await mgr.attachLive({ updateBits: MarketUpdatePreset.CHART });

  const onTrade = (trade) => {
    mgr.onTrade(trade);
    mgr.syncFromLastTrade();
  };
  const onSession = () => {
    void mgr.applySessionOverlay();
  };

  chart.on("trade", onTrade);
  chart.on("latest_high_low", onSession);
  chart.on("latest_open", onSession);

  return () => {
    chart.off("trade", onTrade);
    chart.off("latest_high_low", onSession);
    chart.off("latest_open", onSession);
  };
}

/**
 * Full Rithmic bootstrap tuned for TradeSea parity (verify with TradeSea MDS separately).
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

  await attachRithmicAccuracy(mgr, mgr.session);
  mgr.syncFromLastTrade();

  return result;
}
