/** TradeSea MDS order book snapshot (f:1 / f:4 / f:6 / f:2 / f:7). Port of Auren tradeseaMarketBook. */

function emptyBook(streamId) {
  return {
    streamId,
    last: null,
    bestBid: null,
    bestAsk: null,
    bestBidSize: null,
    bestAskSize: null,
    bids: [],
    asks: [],
    volumeByPrice: new Map(),
    updatedAt: 0,
  };
}

function parseLevelRows(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 1) continue;
    const price = Number(row[0]);
    const size = Number(row[1] ?? 0);
    if (!Number.isFinite(price)) continue;
    out.push({ price, size: Number.isFinite(size) ? size : 0 });
  }
  return out;
}

export function mergeBookSide(existing, delta, side) {
  const map = new Map();
  for (const l of existing) {
    if (l.size > 0) map.set(l.price, l.size);
  }
  for (const l of delta) {
    if (l.size <= 0) map.delete(l.price);
    else map.set(l.price, l.size);
  }
  const merged = [...map.entries()].map(([price, size]) => ({ price, size }));
  merged.sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
  return merged;
}

function syncBestFromLevels(book) {
  if (book.bids.length) {
    book.bestBid = book.bids[0].price;
    book.bestBidSize = book.bids[0].size;
  }
  if (book.asks.length) {
    book.bestAsk = book.asks[0].price;
    book.bestAskSize = book.asks[0].size;
  }
}

export class TradeseaMarketBookStore {
  /** @type {Map<string, ReturnType<emptyBook>>} */
  #books = new Map();
  /** @type {Set<(streamId: string) => void>} */
  #listeners = new Set();

  get(streamId) {
    const id = String(streamId || "").trim();
    if (!id) return null;
    return this.#books.get(id) ?? null;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(streamId) {
    for (const fn of this.#listeners) {
      try {
        fn(streamId);
      } catch {
        /* ignore */
      }
    }
  }

  #touch(streamId) {
    const id = String(streamId || "").trim();
    let book = this.#books.get(id);
    if (!book) {
      book = emptyBook(id);
      this.#books.set(id, book);
    }
    return book;
  }

  applyLtp(streamId, price) {
    if (!Number.isFinite(price)) return;
    const book = this.#touch(streamId);
    book.last = price;
    book.updatedAt = Date.now();
    this.#notify(streamId);
  }

  applyBestBidAsk(streamId, fields) {
    const book = this.#touch(streamId);
    if (fields.bp != null && Number.isFinite(Number(fields.bp))) book.bestBid = Number(fields.bp);
    if (fields.ap != null && Number.isFinite(Number(fields.ap))) book.bestAsk = Number(fields.ap);
    if (fields.bs != null && Number.isFinite(Number(fields.bs))) book.bestBidSize = Number(fields.bs);
    if (fields.as != null && Number.isFinite(Number(fields.as))) book.bestAskSize = Number(fields.as);
    if (book.bestBid != null && book.bestBidSize != null && book.bestBidSize > 0) {
      book.bids = mergeBookSide(book.bids, [{ price: book.bestBid, size: book.bestBidSize }], "bid");
    }
    if (book.bestAsk != null && book.bestAskSize != null && book.bestAskSize > 0) {
      book.asks = mergeBookSide(book.asks, [{ price: book.bestAsk, size: book.bestAskSize }], "ask");
    }
    book.updatedAt = Date.now();
    this.#notify(streamId);
  }

  applyQuotes(streamId, fields) {
    const book = this.#touch(streamId);
    if (fields.p != null && Number.isFinite(Number(fields.p))) book.last = Number(fields.p);
    if (fields.bp != null && Number.isFinite(Number(fields.bp))) book.bestBid = Number(fields.bp);
    if (fields.ap != null && Number.isFinite(Number(fields.ap))) book.bestAsk = Number(fields.ap);
    if (fields.bs != null && Number.isFinite(Number(fields.bs))) book.bestBidSize = Number(fields.bs);
    if (fields.as != null && Number.isFinite(Number(fields.as))) book.bestAskSize = Number(fields.as);
    if (book.bestBid != null && book.bestBidSize != null && book.bestBidSize > 0) {
      book.bids = mergeBookSide(book.bids, [{ price: book.bestBid, size: book.bestBidSize }], "bid");
    }
    if (book.bestAsk != null && book.bestAskSize != null && book.bestAskSize > 0) {
      book.asks = mergeBookSide(book.asks, [{ price: book.bestAsk, size: book.bestAskSize }], "ask");
    }
    book.updatedAt = Date.now();
    this.#notify(streamId);
  }

  applyVolumeAtPrice(streamId, fields) {
    const book = this.#touch(streamId);
    const rows = parseLevelRows(fields.v);
    const updateType = Number(fields.u);

    if (updateType === 1) book.volumeByPrice = new Map();

    for (const row of rows) {
      if (row.size <= 0) book.volumeByPrice.delete(row.price);
      else book.volumeByPrice.set(row.price, row.size);
    }

    book.updatedAt = Date.now();
    this.#notify(streamId);
  }
}

/** Compact status object (matches ChartSession.status fields where possible). */
export function tradeseaBookToStatus(book, { symbol, exchange } = {}) {
  if (!book) return null;
  return {
    symbol,
    exchange,
    last: book.last,
    bid: book.bestBid,
    ask: book.bestAsk,
    bid_size: book.bestBidSize,
    ask_size: book.bestAskSize,
    source: "tradesea-mds",
    updated_at: book.updatedAt,
  };
}

export function resolveTradePanelBidAsk(book) {
  if (!book) return { bid: null, ask: null };
  const last = book.last;
  return {
    bid: book.bestBid ?? last ?? null,
    ask: book.bestAsk ?? last ?? null,
  };
}
