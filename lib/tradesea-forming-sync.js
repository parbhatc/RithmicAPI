/**
 * Full TradeSea MDS sync — forming candles + market book (LTP, BBA, quotes, TTV).
 *
 * TradeSea MDS is the source of truth for OHLC and top-of-book.
 * Same pattern as Auren TradeseaDatafeed + TradeseaMarketBookStore.
 */
import { EventEmitter } from "node:events";
import { TradeseaMdsClient } from "./tradesea-mds-client.js";
import { fetchTradeseaHistory, lastTradeseaBar } from "./tradesea-history.js";
import {
  toTradeseaResolution,
  fromTradeseaResolution,
  tradeseaBarUnix,
} from "./tradesea-resolutions.js";
import {
  TradeseaMarketBookStore,
  tradeseaBookToStatus,
} from "./tradesea-market-book.js";
import { resolutionKey } from "./candle-layer.js";

export class TradeseaMdsSync extends EventEmitter {
  #mgr;
  #mds = new TradeseaMdsClient();
  #book = new TradeseaMarketBookStore();
  #candleSubIds = null;
  #marketSubIds = [];
  #options;
  #streamSymbol = "CME:NQ";
  #unbind = [];
  #started = false;

  /** Resolutions where UDF seed is enough (WS often slow). */
  #skipWsWait = new Set(["1M"]);

  constructor(formingBarManager, options = {}) {
    super();
    this.#mgr = formingBarManager;
    this.#options = options;
  }

  get mds() {
    return this.#mds;
  }

  get manager() {
    return this.#mgr;
  }

  get marketBook() {
    return this.#book;
  }

  /** Latest TradeSea market snapshot (last, bid, ask, sizes). */
  getStatus() {
    const session = this.#mgr.session;
    return tradeseaBookToStatus(this.#book.get(this.#streamSymbol), {
      symbol: session?.symbol,
      exchange: session?.exchange,
    });
  }

  getForming(resolution) {
    return this.#mgr.getForming(resolution);
  }

  getLatestWsCandle(resolution) {
    return this.#mds.getLatestCandle(toTradeseaResolution(resolution));
  }

  async start({
    resolutions,
    seedFromHistory = true,
    subscribeMarket = true,
    waitForWsMs = 5000,
    waitForMarketMs = 5000,
    connectTimeoutMs = 15_000,
  } = {}) {
    if (!resolutions?.length) throw new Error("TradeseaMdsSync.start: resolutions required");

    const {
      accessToken,
      refreshToken,
      connectionUserId,
      connectionGroupId,
      streamSymbol = "CME:NQ",
    } = this.#options;

    if (!accessToken) throw new Error("TradeseaMdsSync: accessToken required");
    this.#streamSymbol = streamSymbol;

    const tsResolutions = [...new Set(resolutions.map((r) => toTradeseaResolution(r)))];

    if (seedFromHistory) {
      await this.#seedFromHistory(tsResolutions, streamSymbol);
    }

    await this.#connectMds({ connectionUserId, connectionGroupId, accessToken, refreshToken, connectTimeoutMs });

    this.#wireMarketBook();

    if (subscribeMarket) {
      this.#marketSubIds = this.#mds.subscribeMarketBook([streamSymbol]);
    }

    this.#candleSubIds = this.#mds.subscribeCandles([streamSymbol], tsResolutions);

    const waitList =
      waitForWsMs > 0
        ? tsResolutions.filter((r) => !this.#skipWsWait.has(String(r).toUpperCase()))
        : [];
    const waits = [];
    if (waitList.length) waits.push(this.#mds.waitForCandles(waitList, waitForWsMs));
    if (subscribeMarket && waitForMarketMs > 0) {
      waits.push(this.#mds.waitForMarket({ timeoutMs: waitForMarketMs }));
    }
    if (waits.length) await Promise.all(waits);

    this.#started = true;
    this.emit("ready", { resolutions: tsResolutions, streamSymbol });
    return this;
  }

  async stop() {
    if (this.#candleSubIds != null) {
      this.#mds.unsubscribe(this.#candleSubIds);
      this.#candleSubIds = null;
    }
    if (this.#marketSubIds.length) {
      this.#mds.unsubscribe(this.#marketSubIds);
      this.#marketSubIds = [];
    }
    for (const off of this.#unbind) off();
    this.#unbind = [];
    this.#mds.close();
    this.#started = false;
  }

  #wireMarketBook() {
    const sym = this.#streamSymbol;

    const onCandle = (msg) => this.#applyCandle(msg);
    const onLtp = (msg) => {
      const id = String(msg.id || sym);
      if (Number.isFinite(Number(msg.p))) {
        this.#book.applyLtp(id, Number(msg.p));
        this.#syncFormingCloses(Number(msg.p));
        this.emit("ltp", { streamId: id, price: Number(msg.p), raw: msg });
        this.emit("market", this.getStatus());
      }
    };
    const onBba = (msg) => {
      const id = String(msg.id || sym);
      this.#book.applyBestBidAsk(id, msg);
      this.emit("market", this.getStatus());
    };
    const onQuotes = (msg) => {
      const id = String(msg.id || sym);
      this.#book.applyQuotes(id, msg);
      if (Number.isFinite(Number(msg.p))) this.#syncFormingCloses(Number(msg.p));
      this.emit("market", this.getStatus());
    };
    const onTtv = (msg) => {
      const id = String(msg.id || sym);
      this.#book.applyVolumeAtPrice(id, msg);
      this.emit("ttv", { streamId: id, raw: msg });
    };

    this.#mds.on("candle", onCandle);
    this.#mds.on("ltp", onLtp);
    this.#mds.on("bestBidAsk", onBba);
    this.#mds.on("quotes", onQuotes);
    this.#mds.on("ttv", onTtv);

    this.#unbind = [
      () => this.#mds.off("candle", onCandle),
      () => this.#mds.off("ltp", onLtp),
      () => this.#mds.off("bestBidAsk", onBba),
      () => this.#mds.off("quotes", onQuotes),
      () => this.#mds.off("ttv", onTtv),
    ];
  }

  /** Push TradeSea last into intraday forming closes (matches Auren live close). */
  #syncFormingCloses(lastPrice) {
    if (!Number.isFinite(lastPrice)) return;
    const session = this.#mgr.session;
    if (session?.status && typeof session.status === "object") {
      // Read-only getter on ChartSession — sync via manager only
    }
    this.#mgr.syncFromTradeSeaLast?.(lastPrice);
  }

  async #seedFromHistory(tsResolutions, streamSymbol) {
    const { accessToken, refreshToken, connectionUserId, connectionGroupId } = this.#options;
    const nowSec = Math.floor(Date.now() / 1000);

    await Promise.all(
      tsResolutions.map(async (tsRes) => {
        try {
          const payload = await fetchTradeseaHistory({
            accessToken,
            refreshToken,
            connectionUserId,
            connectionGroupId,
            streamSymbol,
            resolution: tsRes,
            fromSec: nowSec - 3 * 86_400,
            toSec: nowSec + 60,
            countback: 5,
          });
          const bar = lastTradeseaBar(payload);
          if (bar) this.#applyHistoryBar(tsRes, bar);
        } catch (err) {
          this.emit("warn", { resolution: tsRes, error: err });
        }
      }),
    );
  }

  #connectMds({ connectionUserId, connectionGroupId, accessToken, refreshToken, connectTimeoutMs }) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("TradeSea MDS connect timeout"));
      }, connectTimeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.#mds.off("open", onOpen);
        this.#mds.off("error", onError);
      };

      const onOpen = () => {
        cleanup();
        resolve();
      };

      const onError = (err) => {
        cleanup();
        reject(err);
      };

      this.#mds.once("open", onOpen);
      this.#mds.once("error", onError);

      this.#mds.connect({
        connectionUserId,
        connectionGroupId,
        accessToken,
        refreshToken,
      });
    });
  }

  #applyHistoryBar(tsResolution, bar) {
    const marker = tradeseaBarUnix(bar.marker);
    if (marker == null) return;

    const resolution = fromTradeseaResolution(tsResolution);
    this.#mgr.applyTradeSeaForming(resolution, {
      marker,
      open: Number(bar.open),
      high: Number(bar.high),
      low: Number(bar.low),
      close: Number(bar.close),
      volume: bar.volume != null ? Number(bar.volume) : undefined,
      replaySource: "tradesea-udf",
    });
  }

  #applyCandle(msg) {
    this.#mds.noteCandle(msg);

    const marker = tradeseaBarUnix(msg.t);
    if (marker == null) return;

    const resolution = fromTradeseaResolution(msg.r);
    const bar = this.#mgr.applyTradeSeaForming(resolution, {
      marker,
      open: Number(msg.o),
      high: Number(msg.h),
      low: Number(msg.l),
      close: Number(msg.c),
      volume: msg.v != null ? Number(msg.v) : undefined,
      replaySource: "tradesea-mds",
    });

    this.emit("candle", { resolution, bar, raw: msg });
  }
}

/** @deprecated Use TradeseaMdsSync */
export const TradeseaFormingSync = TradeseaMdsSync;
