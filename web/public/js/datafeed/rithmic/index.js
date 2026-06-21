/**
 * Rithmic datafeed — closed TimeBar history via RequestTimeBarReplay.
 */
import { normalizeBar } from "/js/datafeed/custom.js";
import { normalizeRithmicSymbol } from "./symbols.js";

/** @typedef {import("/js/datafeed/types.js").Bar} Bar */

/**
 * @param {string} [baseUrl]
 */
export function createRithmicDatafeed(baseUrl = "/datafeed/rithmic") {
  const root = baseUrl.replace(/\/$/, "");
  /** @type {Promise<object> | null} */
  let readyPromise = null;
  /** @type {Map<string, EventSource>} */
  const streams = new Map();

  async function getJson(path) {
    const res = await fetch(`${root}${path}`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }
    return res.json();
  }

  return {
    onReady() {
      if (!readyPromise) readyPromise = getJson("/config");
      return readyPromise;
    },

    async searchSymbols(userInput, _exchange = "", _symbolType = "", limit = 25) {
      const q = new URLSearchParams({ query: userInput || "", limit: String(limit) });
      return getJson(`/search?${q}`);
    },

    async resolveSymbol(symbolName) {
      const sym = normalizeRithmicSymbol(symbolName);
      const info = await getJson(`/symbols?symbol=${encodeURIComponent(sym)}`);
      if (info.s === "error") throw new Error(info.errmsg || "Unknown symbol");
      return info;
    },

    async getBars(symbolInfo, resolution, periodParams = {}) {
      const sym = normalizeRithmicSymbol(symbolInfo.ticker || symbolInfo.name);
      const q = new URLSearchParams({
        symbol: sym,
        resolution,
      });
      if (periodParams.to != null) q.set("to", String(periodParams.to));
      if (periodParams.from != null) q.set("from", String(periodParams.from));
      if (periodParams.countBack != null) q.set("countback", String(periodParams.countBack));

      const data = await getJson(`/history?${q}`);
      if (data.s === "no_data") return { bars: [], noData: true, meta: data.meta };
      if (data.s === "error") throw new Error(data.errmsg || "Rithmic history failed");

      /** @type {Bar[]} */
      const bars = data.t
        .map((time, i) =>
          normalizeBar({
            time,
            open: data.o[i],
            high: data.h[i],
            low: data.l[i],
            close: data.c[i],
            volume: data.v?.[i],
          }),
        )
        .sort((a, b) => a.time - b.time);

      return { bars, meta: data.meta, noData: Boolean(data.meta?.noData) };
    },

    subscribeBars(symbolInfo, resolution, onTick, subscriberUID) {
      const sym = normalizeRithmicSymbol(symbolInfo.ticker || symbolInfo.name);
      const q = new URLSearchParams({ symbol: sym, resolution });
      const es = new EventSource(`${root}/stream?${q}`);
      es.onmessage = (ev) => {
        try {
          const raw = JSON.parse(ev.data);
          if (raw?.error) return;
          const bar = normalizeBar(raw);
          if (!Number.isFinite(bar.time) || !Number.isFinite(bar.close)) return;
          onTick(bar);
        } catch {
          // ignore heartbeats / parse errors
        }
      };
      streams.set(subscriberUID, es);
    },

    unsubscribeBars(subscriberUID) {
      const es = streams.get(subscriberUID);
      if (es) {
        es.close();
        streams.delete(subscriberUID);
      }
    },
  };
}
