import {
  ChartSession,
  HistoryQuery,
  MarketUpdatePreset,
} from "../../../../index.js";
import { loadRithmicEnv } from "./env.mjs";
import { toRithmicResolution } from "./resolutions.mjs";
import { resolutionSec, tickToMinmovPricescale } from "../resolutions.mjs";
import { normalizeRithmicSymbol, RITHMIC_SYMBOLS } from "./symbols.mjs";

function roundToTick(price, tick) {
  const p = Number(price);
  const t = Number(tick);
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return p;
  const n = Math.round(p / t);
  return Number((n * t).toFixed(12));
}

const HISTORY_CACHE_MS = 12_000;

export class RithmicHub {
  #chart = null;
  #sessionPromise = null;
  #livePromise = null;
  #liveResolution = null;
  #liveActive = false;
  /** @type {Map<string, Set<(bar: object) => void>>} */
  #listeners = new Map();
  /** @type {Map<string, string>} */
  #lastStreamSig = new Map();
  /** @type {Map<string, { at: number, bars: object[] }>} */
  #historyCache = new Map();
  /** @type {Map<string, Promise<object[]>>} */
  #historyInflight = new Map();
  #onClosedBar = null;

  async ensureSession() {
    if (this.#sessionPromise) return this.#sessionPromise;

    this.#sessionPromise = (async () => {
      loadRithmicEnv();
      const user = process.env.RITHMIC_USER;
      const password = process.env.RITHMIC_PASSWORD;
      if (!user || !password) {
        throw new Error("Set RITHMIC_USER and RITHMIC_PASSWORD in .env");
      }

      const symbol = normalizeRithmicSymbol(process.env.RITHMIC_SYMBOL ?? "NQ");
      const meta = RITHMIC_SYMBOLS[symbol] ?? {
        exchange: process.env.RITHMIC_EXCHANGE ?? "CME",
        tick: 0.25,
      };

      const t0 = performance.now();
      console.log(`[rithmic] connecting ${symbol}@${meta.exchange}…`);
      this.#chart = await ChartSession.open({
        user,
        password,
        systemName: process.env.RITHMIC_SYSTEM ?? "LucidTrading",
        symbol,
        exchange: meta.exchange,
        gatewayName: process.env.RITHMIC_GATEWAY,
      });
      console.log(`[rithmic] connected ${((performance.now() - t0) / 1000).toFixed(1)}s → ${this.#chart.uri}`);
    })();

    return this.#sessionPromise;
  }

  /** RequestTimeBarUpdate — closed TimeBar (250) only. */
  async ensureLive(resolution = "1") {
    await this.ensureSession();

    const udfRes = this.#udfResolution(String(resolution));
    if (this.#liveResolution === udfRes && this.#livePromise) {
      return this.#livePromise;
    }

    this.#livePromise = (async () => {
      const rithmicRes = toRithmicResolution(udfRes);
      const { barType, barTypePeriod } = HistoryQuery.parseResolution(rithmicRes);

      if (this.#liveActive) {
        await this.#chart.stopLive();
        this.#liveActive = false;
      }

      this.#wireLiveHandlers();

      await this.#chart.startLive({
        updateBits: MarketUpdatePreset.CHART,
        barType,
        barPeriod: barTypePeriod,
      });

      this.#liveActive = true;
      this.#liveResolution = udfRes;
      console.log(`[rithmic] TimeBar live ${udfRes} (closed bars only)`);
    })();

    return this.#livePromise;
  }

  warmup() {
    void this.ensureSession().catch((err) => console.error("[rithmic] warmup failed:", err?.message ?? err));
  }

  #wireLiveHandlers() {
    if (this.#onClosedBar) return;

    this.#onClosedBar = (bar) => {
      if (!this.#liveResolution) return;
      this.#emit(this.#liveResolution, bar);
    };

    this.#chart.on("bar", this.#onClosedBar);
  }

  #udfResolution(rithmicRes) {
    const s = String(rithmicRes);
    if (s === "1D") return "D";
    if (s === "1W") return "W";
    if (s === "1M") return "M";
    return s;
  }

  #emit(resolution, bar) {
    const key = `${this.symbol}:${resolution}`;
    const set = this.#listeners.get(key);
    if (!set?.size || !bar) return;
    const out = this.#closedBarToChart(bar, resolution);
    const sig = this.#streamSig(out);
    if (this.#lastStreamSig.get(resolution) === sig) return;
    this.#lastStreamSig.set(resolution, sig);
    for (const fn of set) fn(out);
  }

  get symbol() {
    return normalizeRithmicSymbol(process.env.RITHMIC_SYMBOL ?? "NQ");
  }

  listSymbols() {
    return Object.entries(RITHMIC_SYMBOLS).map(([symbol, m]) => ({
      symbol,
      name: m.name,
      exchange: m.exchange,
      type: "futures",
      tick: m.tick,
    }));
  }

  resolveSymbol(sym) {
    const s = normalizeRithmicSymbol(sym);
    const meta = RITHMIC_SYMBOLS[s];
    if (!meta) return null;
    const tick = meta.tick ?? 0.25;
    const { minmov, pricescale } = tickToMinmovPricescale(tick);
    return {
      name: s,
      ticker: s,
      description: meta.name,
      type: "futures",
      exchange: meta.exchange,
      listed_exchange: meta.exchange,
      session: "1700-1600",
      timezone: "America/Chicago",
      minmov,
      pricescale,
      tick,
      minTick: tick,
      has_intraday: true,
      has_daily: true,
      has_weekly_and_monthly: true,
      supported_resolutions: [
        "1", "3", "5", "15", "30", "45", "60", "120", "180", "240", "D", "W", "M",
      ],
      volume_precision: 0,
      data_status: "streaming",
      currency_code: "USD",
    };
  }

  #minTick(sym) {
    const s = normalizeRithmicSymbol(sym ?? this.symbol);
    return RITHMIC_SYMBOLS[s]?.tick ?? 0.25;
  }

  #normalizeOhlc(bar, tick) {
    return {
      ...bar,
      open: roundToTick(bar.open, tick),
      high: roundToTick(bar.high, tick),
      low: roundToTick(bar.low, tick),
      close: roundToTick(bar.close, tick),
    };
  }

  #fmtBarTime(sec) {
    return new Date(Number(sec) * 1000).toLocaleString("en-US", { timeZone: "America/New_York" });
  }

  #logHistoryResult({
    resolution,
    bars,
    fromSec,
    toSec,
    countback,
    nowSec,
    elapsedMs,
    cachedAt,
  }) {
    const fetchedAt = cachedAt ?? Date.now();
    const src = cachedAt != null ? "cache" : "replay";
    const last = bars.at(-1);
    const lastT = last ? this.#chartTimeFromBar(last, resolution) : null;
    const lastMarker = last ? Number(last.marker) : null;
    const toAgeMin = ((nowSec - toSec) / 60).toFixed(1);
    const lastLagMin = lastT != null ? ((nowSec - lastT) / 60).toFixed(1) : "—";

    console.log(
      `[rithmic] history ${resolution} ${bars.length} closed bars (${src}, ${(elapsedMs / 1000).toFixed(2)}s)\n` +
        `  fetched ${this.#fmtBarTime(Math.floor(fetchedAt / 1000))} ET  now ${this.#fmtBarTime(nowSec)} ET\n` +
        `  req from=${fromSec ?? "—"} to=${toSec} (to is ${toAgeMin}m behind now) countback=${countback ?? "—"}\n` +
        `  last bar ${lastT != null ? this.#fmtBarTime(lastT) : "—"} ET` +
        (lastMarker != null ? ` (marker ${this.#fmtBarTime(lastMarker)})` : "") +
        (last?.close != null ? ` C=${last.close}` : "") +
        ` (${lastLagMin}m before now, closed-only)`,
    );
  }

  /** Chart label — intraday: marker + period; calendar: Chicago midnight Unix. */
  #chartTimeFromBar(bar, resolution = "1") {
    if (HistoryQuery.isCalendarResolution(resolution)) {
      return HistoryQuery.chartBarTimeSec(bar);
    }
    return Number(bar.marker) + resolutionSec(resolution);
  }

  /** Closed live TimeBar — label = marker + period (Rithmic UI). */
  #closedBarToChart(bar, resolution, tick = this.#minTick(this.symbol)) {
    const ohlc = this.#normalizeOhlc(bar, tick);
    return {
      time: Number(bar.marker) + resolutionSec(resolution),
      open: ohlc.open,
      high: ohlc.high,
      low: ohlc.low,
      close: ohlc.close,
      volume: bar.volume != null ? Number(bar.volume) : undefined,
    };
  }

  #streamSig(out) {
    return `${out.time}|${out.open}|${out.high}|${out.low}|${out.close}`;
  }

  #historyCacheKey(sym, resolution, from, to, countback) {
    return `${sym}:${resolution}:${from ?? ""}:${to ?? ""}:${countback ?? ""}`;
  }

  async loadHistory({ symbol, resolution, from, to, countback }) {
    await this.ensureSession();

    const sym = normalizeRithmicSymbol(symbol);
    if (!RITHMIC_SYMBOLS[sym]) throw new Error(`Unknown symbol: ${sym}`);

    const rithmicRes = toRithmicResolution(resolution);
    const nowSec = Math.floor(Date.now() / 1000);
    const toSec = to != null ? Math.max(Number(to), nowSec) : nowSec;
    // TradeSea/TV: countback anchors on `to` — ignore chart `from` when countback is set.
    const cb =
      countback != null
        ? Number(countback)
        : HistoryQuery.effectiveHistoryCountback({
            from: from != null ? Number(from) : undefined,
            to: toSec,
            countback: 300,
            resolutionSec: resolutionSec(resolution),
          });
    const replayFrom = countback != null ? undefined : from != null ? Number(from) : undefined;
    const reqFrom = from != null ? Number(from) : undefined;

    const cacheKey = this.#historyCacheKey(sym, resolution, replayFrom, toSec, cb);
    const cached = this.#historyCache.get(cacheKey);
    if (cached && Date.now() - cached.at < HISTORY_CACHE_MS) {
      this.#logHistoryResult({
        resolution,
        bars: cached.bars,
        fromSec: reqFrom,
        toSec,
        countback: cb,
        nowSec,
        elapsedMs: 0,
        cachedAt: cached.at,
      });
      return cached.bars;
    }

    const inflight = this.#historyInflight.get(cacheKey);
    if (inflight) return inflight;

    const job = (async () => {
      const t0 = performance.now();
      let bars = await this.#chart.loadHistory({
        resolution: rithmicRes,
        from: replayFrom,
        to: toSec,
        countback: cb,
        compat: !HistoryQuery.isCalendarResolution(resolution),
        timeoutMs: 45_000,
      });

      const tick = this.#minTick(sym);
      bars = bars.map((b) => this.#normalizeOhlc(b, tick));

      this.#historyCache.set(cacheKey, { at: Date.now(), bars });
      this.#logHistoryResult({
        resolution,
        bars,
        fromSec: reqFrom,
        toSec,
        countback: cb,
        nowSec,
        elapsedMs: performance.now() - t0,
      });
      return bars;
    })();

    this.#historyInflight.set(cacheKey, job);
    try {
      return await job;
    } finally {
      this.#historyInflight.delete(cacheKey);
    }
  }

  historyPayload({ bars, resolution = "1" }) {
    const cal = HistoryQuery.isCalendarResolution(resolution);
    const period = resolutionSec(resolution);
    const timeOffset = cal ? 0 : period;
    return HistoryQuery.barsToHistoryPayload(bars, { timeOffset, compat: false, resolution });
  }

  subscribe(symbol, resolution, fn) {
    const sym = normalizeRithmicSymbol(symbol);
    const udfRes = this.#udfResolution(resolution);
    const key = `${sym}:${udfRes}`;
    if (!this.#listeners.has(key)) this.#listeners.set(key, new Set());
    this.#listeners.get(key).add(fn);

    void this.ensureLive(udfRes).catch((err) => {
      console.error(`[rithmic] live ${udfRes} failed:`, err?.message ?? err);
    });

    return () => {
      this.#listeners.get(key)?.delete(fn);
    };
  }
}

export const rithmicHub = new RithmicHub();
