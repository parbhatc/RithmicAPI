/**
 * TradeSea Market Data Stream WebSocket — direct upstream (Auren wire protocol).
 *
 * f:1 bid/ask  f:2 LTP  f:4 depth  f:5 candles  f:6 quotes  f:7 TTV
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";

const F_ERROR = 0;
const F_BEST_BID_ASK = 1;
const F_LTP = 2;
const F_DEPTH = 4;
const F_CANDLES = 5;
const F_QUOTES = 6;
const F_TTV = 7;

export const MDS_BUCKET_LTP = "ltpDef";
export const MDS_BUCKET_BEST_BID_ASK = "bidAskDef";
export const MDS_BUCKET_TTV = "ttvDef";

const DEFAULT_MDS_BASE = "wss://prod-market-data.tradesea.ai/v1/wss";
const RESUBSCRIBE_DELAY_MS = 150;
const PING_INTERVAL_MS = 5000;

function buildCookie(accessToken, refreshToken) {
  const parts = [];
  if (accessToken) parts.push(`access_token=${accessToken}`);
  if (refreshToken) parts.push(`refresh_token=${refreshToken}`);
  return parts.join("; ");
}

function subscribeFrame(payload) {
  const lane = 0;
  switch (payload.kind) {
    case "candles":
      return {
        f: F_CANDLES,
        s: payload.symbols,
        u: [],
        sr: payload.resolutions,
        ur: [],
        l: lane,
      };
    case "ltp":
      return { f: F_LTP, b: payload.bucket, s: payload.symbols, u: [], l: lane };
    case "bestBidAsk":
      return { f: F_BEST_BID_ASK, b: payload.bucket, s: payload.symbols, u: [], l: lane };
    case "quotes":
      return { f: F_QUOTES, s: payload.symbols, u: [], l: lane };
    case "ttv":
      return { f: F_TTV, b: payload.bucket, s: payload.symbols, u: [], l: lane };
    default:
      return { f: F_CANDLES, s: [], u: [], sr: [], ur: [], l: lane };
  }
}

function unsubscribeFrame(payload) {
  const lane = 0;
  switch (payload.kind) {
    case "candles":
      return {
        f: F_CANDLES,
        s: [],
        u: payload.symbols,
        sr: [],
        ur: payload.resolutions,
        l: lane,
      };
    case "ltp":
      return { f: F_LTP, b: payload.bucket, s: [], u: payload.symbols, l: lane };
    case "bestBidAsk":
      return { f: F_BEST_BID_ASK, b: payload.bucket, s: [], u: payload.symbols, l: lane };
    case "quotes":
      return { f: F_QUOTES, s: [], u: payload.symbols, l: lane };
    case "ttv":
      return { f: F_TTV, b: payload.bucket, s: [], u: payload.symbols, l: lane };
    default:
      return { f: F_CANDLES, s: [], u: [], sr: [], ur: [], l: lane };
  }
}

function expandCandleSubscribe(symbols, resolutions) {
  const syms = symbols.map(String);
  const res = resolutions.map(String);
  if (syms.length === 1 && res.length > 1) {
    return { symbols: res.map(() => syms[0]), resolutions: res };
  }
  if (syms.length !== res.length) {
    throw new Error("subscribeCandles: symbols and resolutions must be same length (or one symbol + many resolutions)");
  }
  return { symbols: syms, resolutions: res };
}

export class TradeseaMdsClient extends EventEmitter {
  #ws = null;
  #pingTimer = null;
  #subscriptionId = 0;
  /** @type {Map<number, object>} */
  #subs = new Map();
  #connected = false;
  /** @type {Map<string, object>} */
  #candleCache = new Map();

  get connected() {
    return this.#connected && this.#ws?.readyState === WebSocket.OPEN;
  }

  connect({
    connectionUserId,
    connectionGroupId,
    accessToken,
    refreshToken,
    mdsBase = process.env.TRADESEA_MDS_BASE ?? DEFAULT_MDS_BASE,
  }) {
    if (!connectionUserId || !connectionGroupId || !accessToken) {
      throw new Error("TradeseaMdsClient.connect: connectionUserId, connectionGroupId, accessToken required");
    }

    this.close();

    const url =
      `${mdsBase}/${encodeURIComponent(connectionUserId)}/${encodeURIComponent(connectionGroupId)}`;

    const ws = new WebSocket(url, {
      headers: {
        Cookie: buildCookie(accessToken, refreshToken),
        Origin: "https://app.tradesea.ai",
      },
    });
    this.#ws = ws;

    ws.on("open", () => {
      this.#connected = true;
      this.#startPing();
      this.emit("open");
      setTimeout(() => {
        if (this.#ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        for (const payload of this.#subs.values()) {
          this.#send(subscribeFrame(payload));
        }
        this.emit("ready");
      }, RESUBSCRIBE_DELAY_MS);
    });

    ws.on("message", (data) => {
      const text = typeof data === "string" ? data : data.toString("utf8");
      if (!text || text === "pong") return;

      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }

      if (msg.f === F_ERROR) {
        this.emit("mdsError", new Error(msg.m || msg.c || "TradeSea MDS error"));
        return;
      }

      this.emit("message", msg);
      switch (msg.f) {
        case F_CANDLES:
          this.noteCandle(msg);
          this.emit("candle", msg);
          break;
        case F_LTP:
          this.emit("ltp", msg);
          break;
        case F_BEST_BID_ASK:
          this.emit("bestBidAsk", msg);
          break;
        case F_QUOTES:
          this.emit("quotes", msg);
          break;
        case F_TTV:
          this.emit("ttv", msg);
          break;
        default:
          break;
      }
    });

    ws.on("error", (err) => {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    });

    ws.on("close", (code, reason) => {
      this.#connected = false;
      this.#stopPing();
      if (this.#ws === ws) this.#ws = null;
      this.emit("close", { code, reason: reason?.toString() ?? "" });
    });
  }

  #addSub(payload) {
    const id = ++this.#subscriptionId;
    this.#subs.set(id, payload);
    if (this.connected) this.#send(subscribeFrame(payload));
    return id;
  }

  subscribeCandles(symbols, resolutions) {
    const expanded = expandCandleSubscribe(symbols, resolutions);
    if (symbols.length === 1 && resolutions.length > 1) {
      const ids = expanded.resolutions.map((r, i) =>
        this.#addSub({
          kind: "candles",
          symbols: [expanded.symbols[i]],
          resolutions: [r],
        }),
      );
      return ids.length === 1 ? ids[0] : ids;
    }
    return this.#addSub({ kind: "candles", ...expanded });
  }

  subscribeLtp(symbols, bucket = MDS_BUCKET_LTP) {
    return this.#addSub({ kind: "ltp", symbols: symbols.map(String), bucket });
  }

  subscribeBestBidAsk(symbols, bucket = MDS_BUCKET_BEST_BID_ASK) {
    return this.#addSub({ kind: "bestBidAsk", symbols: symbols.map(String), bucket });
  }

  subscribeQuotes(symbols) {
    return this.#addSub({ kind: "quotes", symbols: symbols.map(String) });
  }

  subscribeTtv(symbols, bucket = MDS_BUCKET_TTV) {
    return this.#addSub({ kind: "ttv", symbols: symbols.map(String), bucket });
  }

  /** Auren bootstrap: LTP + BBA + quotes + TTV for one stream symbol. */
  subscribeMarketBook(symbols) {
    const syms = symbols.map(String);
    return [
      this.subscribeLtp(syms),
      this.subscribeBestBidAsk(syms),
      this.subscribeQuotes(syms),
      this.subscribeTtv(syms),
    ];
  }

  unsubscribe(idOrIds) {
    const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
    for (const id of ids) {
      const payload = this.#subs.get(id);
      if (!payload) continue;
      this.#subs.delete(id);
      if (this.connected) this.#send(unsubscribeFrame(payload));
    }
  }

  waitForCandles(resolutions, timeoutMs = 8000) {
    const pending = new Set(resolutions.map(String));
    if (!pending.size) return Promise.resolve(new Map());

    const latest = new Map();

    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.off("candle", onCandle);
        resolve(latest);
      };

      const onCandle = (msg) => {
        const r = String(msg.r ?? "");
        if (!pending.has(r)) return;
        latest.set(r, msg);
        pending.delete(r);
        if (!pending.size) done();
      };

      this.on("candle", onCandle);
      const timer = setTimeout(done, timeoutMs);

      for (const [r, msg] of this.#candleCache) {
        if (pending.has(r)) {
          latest.set(r, msg);
          pending.delete(r);
        }
      }
      if (!pending.size) done();
    });
  }

  waitForMarket({ needLast = true, needBidAsk = true, timeoutMs = 5000 } = {}) {
    return new Promise((resolve) => {
      let last = !needLast;
      let bba = !needBidAsk;

      const check = () => {
        if (last && bba) done(true);
      };

      const done = (ok) => {
        clearTimeout(timer);
        this.off("ltp", onLtp);
        this.off("bestBidAsk", onBba);
        this.off("quotes", onQuotes);
        resolve(ok);
      };

      const onLtp = (msg) => {
        if (Number.isFinite(Number(msg.p))) {
          last = true;
          check();
        }
      };
      const onBba = (msg) => {
        if (Number.isFinite(Number(msg.bp)) || Number.isFinite(Number(msg.ap))) {
          bba = true;
          check();
        }
      };
      const onQuotes = (msg) => {
        if (Number.isFinite(Number(msg.p))) last = true;
        if (Number.isFinite(Number(msg.bp)) || Number.isFinite(Number(msg.ap))) bba = true;
        check();
      };

      this.on("ltp", onLtp);
      this.on("bestBidAsk", onBba);
      this.on("quotes", onQuotes);
      const timer = setTimeout(() => done(last && bba), timeoutMs);
    });
  }

  noteCandle(msg) {
    const r = String(msg.r ?? "");
    if (r) this.#candleCache.set(r, msg);
  }

  getLatestCandle(tsResolution) {
    return this.#candleCache.get(String(tsResolution)) ?? null;
  }

  close() {
    this.#stopPing();
    this.#subs.clear();
    this.#candleCache.clear();
    const ws = this.#ws;
    this.#ws = null;
    this.#connected = false;
    if (ws) {
      ws.removeAllListeners();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    }
  }

  #send(frame) {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return;
    this.#ws.send(JSON.stringify(frame));
  }

  #startPing() {
    this.#stopPing();
    const ws = this.#ws;
    this.#pingTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send("ping");
      } catch {
        /* ignore */
      }
    }, PING_INTERVAL_MS);
  }

  #stopPing() {
    if (this.#pingTimer) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
  }
}
