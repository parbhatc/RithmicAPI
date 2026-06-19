/**
 * TradeSea weekly bars use native Rithmic Friday-week closes + a stable price offset.
 * Fetch the offset from the last *closed* TradeSea week vs native weekly close.
 */

const DEFAULT_CONNECTION_USER_ID =
  "dDqVtke0T1bbMKI-g6JpZKpOT1FCUzI5NzQ2omV1q0xULTFYRDgxWjlEoWSDonNurEx1Y2lkVHJhZGluZ6NmY22sTHVjaWRUcmFkaW5nomlirEx1Y2lkVHJhZGluZw";
const DEFAULT_CONNECTION_GROUP_ID =
  "6c1e6cb7bff88283b854e92fcf5aa9eda70a33e728f6875015d2a8e36217b265";

/** @type {Map<string, { close: number, at: number }>} */
const closedWeekCloseCache = new Map();
const CLOSED_WEEK_TTL_MS = 6 * 60 * 60 * 1000;

function closedWeekCacheKey(symbol, nowSec) {
  const week = Math.floor(nowSec / 604_800);
  return `${symbol}:closed-week:${week}`;
}

/**
 * @param {object} [options]
 * @param {string} options.accessToken
 * @param {string} [options.symbol='CME:NQ']
 * @param {number} [options.nowSec]
 */
export async function fetchTradeSeaClosedWeekClose({
  accessToken,
  symbol = "CME:NQ",
  nowSec = Math.floor(Date.now() / 1000),
  connectionUserId = process.env.TRADESEA_CONNECTION_USER_ID ?? DEFAULT_CONNECTION_USER_ID,
  connectionGroupId = process.env.TRADESEA_CONNECTION_GROUP_ID ?? DEFAULT_CONNECTION_GROUP_ID,
} = {}) {
  if (!accessToken) return null;

  const cacheKey = closedWeekCacheKey(symbol, nowSec);
  const cached = closedWeekCloseCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CLOSED_WEEK_TTL_MS) {
    return cached.close;
  }

  const params = new URLSearchParams({
    "connection-user-id": connectionUserId,
    "connection-group-id": connectionGroupId,
    symbol,
    resolution: "1W",
    countback: "3",
    to: String(nowSec + 60),
    currencyCode: "USD",
  });

  const res = await fetch(`https://prod-market-data.tradesea.ai/v1/history?${params}`, {
    headers: {
      Cookie: `access_token=${accessToken}`,
      Origin: "https://app.tradesea.ai",
      Referer: "https://app.tradesea.ai/",
    },
  });
  if (!res.ok) return null;

  const data = await res.json();
  if (data.s !== "ok" || !data.c?.length) return null;

  // Last bar is forming; prior bar is last closed TradeSea week.
  const i = data.c.length >= 2 ? data.c.length - 2 : data.c.length - 1;
  const close = Number(data.c[i]);
  if (Number.isFinite(close)) {
    closedWeekCloseCache.set(cacheKey, { close, at: Date.now() });
  }
  return close;
}

/**
 * @param {number} nativeFridayWeekClose — Rithmic native weekly bar close (Friday marker)
 * @param {object} [options] — passed to `fetchTradeSeaClosedWeekClose`
 * @returns {Promise<number|null>} price offset to add to native weekly/daily rollup OHLC
 */
export async function resolveTradeSeaWeeklyAdjust(nativeFridayWeekClose, options = {}) {
  const tsClose = await fetchTradeSeaClosedWeekClose(options);
  if (tsClose == null || !Number.isFinite(nativeFridayWeekClose)) return null;
  return tsClose - nativeFridayWeekClose;
}

/** Apply uniform TradeSea weekly price offset. */
export function shiftBarOHLC(bar, adjust) {
  if (!bar || !Number.isFinite(adjust)) return bar;
  const o = Number(bar.open);
  const h = Number(bar.high);
  const l = Number(bar.low);
  const c = Number(bar.close);
  return {
    ...bar,
    open: o + adjust,
    high: h + adjust,
    low: l + adjust,
    close: c + adjust,
  };
}

/**
 * @param {string} resolution — e.g. `"240"`, `"1W"`
 * @param {object} [options]
 * @returns {Promise<{ open, high, low, close, marker }|null>}
 */
export async function fetchTradeSeaLastBar(resolution, options = {}) {
  const {
    accessToken,
    symbol = "CME:NQ",
    nowSec = Math.floor(Date.now() / 1000),
    connectionUserId = process.env.TRADESEA_CONNECTION_USER_ID ?? DEFAULT_CONNECTION_USER_ID,
    connectionGroupId = process.env.TRADESEA_CONNECTION_GROUP_ID ?? DEFAULT_CONNECTION_GROUP_ID,
  } = options;
  if (!accessToken) return null;

  const params = new URLSearchParams({
    "connection-user-id": connectionUserId,
    "connection-group-id": connectionGroupId,
    symbol,
    resolution: String(resolution),
    countback: "2",
    to: String(nowSec + 60),
    currencyCode: "USD",
  });

  const res = await fetch(`https://prod-market-data.tradesea.ai/v1/history?${params}`, {
    headers: {
      Cookie: `access_token=${accessToken}`,
      Origin: "https://app.tradesea.ai",
      Referer: "https://app.tradesea.ai/",
    },
  });
  if (!res.ok) return null;

  const data = await res.json();
  if (data.s !== "ok" || !data.t?.length) return null;

  const i = data.t.length - 1;
  return {
    marker: data.t[i],
    open: data.o[i],
    high: data.h[i],
    low: data.l[i],
    close: data.c[i],
  };
}
