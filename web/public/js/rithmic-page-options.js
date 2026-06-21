import { loadLastResolution } from "/js/ui/timeframe/favorites.js";
import { loadLastSymbol } from "/js/ui/chart/symbol/store.js";
import { loadThemePreference } from "/js/ui/theme/store.js";
import { normalizeRithmicSymbol, isTradingViewSymbol } from "./datafeed/rithmic/symbols.js";

/** @returns {object} Boot options for the Rithmic chart web app. */
export function readRithmicPageOptions(search = window.location.search) {
  const sp = new URLSearchParams(search);
  const defaultSymbol = "NQ";
  const urlSymbol = sp.get("symbol");
  let rawSymbol = urlSymbol;
  if (!rawSymbol) {
    const stored = loadLastSymbol(defaultSymbol);
    rawSymbol = isTradingViewSymbol(stored) ? defaultSymbol : stored;
  }
  rawSymbol = normalizeRithmicSymbol(rawSymbol);
  const resolution = sp.get("resolution") || loadLastResolution("1");
  const themeParam = sp.get("theme");
  const theme =
    themeParam === "light" ? "light" : themeParam === "dark" ? "dark" : loadThemePreference("dark");
  return {
    symbol: String(rawSymbol).toUpperCase(),
    theme,
    resolution,
    drawings: sp.get("drawings") !== "0",
    replay: sp.get("replay") !== "0",
    chrome: sp.get("chrome") !== "0",
    disabled_features: sp.get("disabled_features")
      ? sp.get("disabled_features").split(",").map((s) => s.trim()).filter(Boolean)
      : undefined,
    countBack: sp.get("countback") != null ? Number(sp.get("countback")) : 500,
    historyChunk: sp.get("historychunk") != null ? Number(sp.get("historychunk")) : 200,
    datafeedType: "rithmic",
    rithmic: true,
    // No /news/calendar on this server — opt in with ?news=1 when wired up.
    news: sp.get("news") === "1",
  };
}
