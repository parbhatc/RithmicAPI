import { HistoryQuery } from "../../../../index.js";
import { CHART_RESOLUTIONS } from "../resolutions.mjs";
import { rithmicHub } from "./hub.mjs";
import { normalizeRithmicSymbol } from "./symbols.mjs";

export function rithmicDatafeedConfig() {
  return {
    supported_resolutions: CHART_RESOLUTIONS.map((r) => r.id),
    resolutions: CHART_RESOLUTIONS,
    default_symbol: (process.env.RITHMIC_SYMBOL ?? "NQ").toUpperCase(),
    default_resolution: "1",
    exchanges: [{ value: "CME", name: "CME", desc: "CME" }],
    symbols_types: [{ name: "Futures", value: "futures" }],
    supports_search: true,
    supports_group_request: false,
    supports_marks: false,
    supports_timescale_marks: false,
    supports_time: true,
    data_source: "rithmic",
  };
}

export function rithmicSearch(query, limit = 25) {
  const q = String(query || "").trim().toUpperCase();
  return rithmicHub
    .listSymbols()
    .filter((s) => !q || s.symbol.includes(q) || s.name.toUpperCase().includes(q))
    .slice(0, limit)
    .map((s) => ({
      symbol: s.symbol,
      full_name: `${s.exchange}:${s.symbol}`,
      description: s.name,
      exchange: s.exchange,
      ticker: s.symbol,
      type: s.type,
    }));
}

export function rithmicResolve(symbol) {
  const sym = normalizeRithmicSymbol(symbol);
  const info = rithmicHub.resolveSymbol(sym);
  if (!info) return { s: "error", errmsg: `Unknown symbol: ${symbol} (use NQ or ES)` };
  return info;
}

export async function rithmicHistory({ symbol, resolution, from, to, countback }) {
  try {
    const res = resolution ?? "1";
    const nowSec = Math.floor(Date.now() / 1000);
    const toSec = to != null ? Number(to) : nowSec;
    const isRecentTail = countback == null || toSec >= nowSec - 120;

    if (isRecentTail) {
      await rithmicHub.ensureLive(res);
    }

    const bars = await rithmicHub.loadHistory({
      symbol,
      resolution: res,
      from: from != null ? Number(from) : undefined,
      to: to != null ? Number(to) : undefined,
      countback: countback != null ? Number(countback) : 300,
    });

    if (!bars?.length) return { s: "no_data", meta: { source: "rithmic", resolution, symbol } };

    const payload = rithmicHub.historyPayload({ bars, resolution: res, mergeLive: isRecentTail });
    const fromSec = from != null ? Number(from) : null;
    const filterTo = to != null ? Number(to) : null;
    let { t, o, h, l, c, v } = payload;
    const isCalendar = HistoryQuery.isCalendarResolution(res);
    const hasCountback = countback != null;
    // BWC: countback + `to` defines the window (replay already anchored). Do not re-filter
    // intraday bars by from/to — chart time is compat open time, not a calendar slice.
    if (isCalendar && filterTo != null && hasCountback) {
      const keep = t.map((time) => time <= filterTo);
      t = t.filter((_, i) => keep[i]);
      o = o.filter((_, i) => keep[i]);
      h = h.filter((_, i) => keep[i]);
      l = l.filter((_, i) => keep[i]);
      c = c.filter((_, i) => keep[i]);
      v = v.filter((_, i) => keep[i]);
    } else if (!isCalendar && !hasCountback && (fromSec != null || filterTo != null)) {
      const keep = t.map((time) => {
        if (fromSec != null && time < fromSec) return false;
        if (filterTo != null && time > filterTo) return false;
        return true;
      });
      t = t.filter((_, i) => keep[i]);
      o = o.filter((_, i) => keep[i]);
      h = h.filter((_, i) => keep[i]);
      l = l.filter((_, i) => keep[i]);
      c = c.filter((_, i) => keep[i]);
      v = v.filter((_, i) => keep[i]);
    }
    if (!t.length) return { s: "no_data", meta: { source: "rithmic", resolution, symbol } };
    return {
      s: "ok",
      t,
      o,
      h,
      l,
      c,
      v: v ?? bars.map((b) => Number(b.volume ?? 0)),
      meta: { source: "rithmic", resolution, symbol },
    };
  } catch (err) {
    return { s: "error", errmsg: err?.message ?? String(err) };
  }
}

export function subscribeRithmicBars(symbol, resolution, onBar) {
  return rithmicHub.subscribe(symbol, resolution, onBar);
}
