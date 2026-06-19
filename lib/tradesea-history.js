/**
 * TradeSea UDF history REST (prod-market-data).
 * Same contract as Auren TradeseaDatafeed getBars.
 */

const DEFAULT_CONNECTION_USER_ID =
  "dDqVtke0T1bbMKI-g6JpZKpOT1FCUzI5NzQ2omV1q0xULTFYRDgxWjlEoWSDonNurEx1Y2lkVHJhZGluZ6NmY22sTHVjaWRUcmFkaW5nomlirEx1Y2lkVHJhZGluZw";
const DEFAULT_CONNECTION_GROUP_ID =
  "6c1e6cb7bff88283b854e92fcf5aa9eda70a33e728f6875015d2a8e36217b265";
const DEFAULT_HISTORY_BASE = "https://prod-market-data.tradesea.ai/v1/history";

function buildCookie(accessToken, refreshToken) {
  const parts = [];
  if (accessToken) parts.push(`access_token=${accessToken}`);
  if (refreshToken) parts.push(`refresh_token=${refreshToken}`);
  return parts.join("; ");
}

/**
 * @param {object} options
 * @param {string} options.accessToken
 * @param {string} [options.refreshToken]
 * @param {string} [options.connectionUserId]
 * @param {string} [options.connectionGroupId]
 * @param {string} [options.streamSymbol='CME:NQ']
 * @param {string|number} options.resolution TradeSea resolution (`15`, `1D`, …)
 * @param {number} [options.fromSec]
 * @param {number} [options.toSec]
 * @param {number} [options.countback=300]
 */
export async function fetchTradeseaHistory({
  accessToken,
  refreshToken,
  connectionUserId = process.env.TRADESEA_CONNECTION_USER_ID ?? DEFAULT_CONNECTION_USER_ID,
  connectionGroupId = process.env.TRADESEA_CONNECTION_GROUP_ID ?? DEFAULT_CONNECTION_GROUP_ID,
  streamSymbol = "CME:NQ",
  resolution,
  fromSec = Math.floor(Date.now() / 1000) - 3 * 86_400,
  toSec = Math.floor(Date.now() / 1000) + 60,
  countback = 300,
  historyBase = process.env.TRADESEA_HISTORY_BASE ?? DEFAULT_HISTORY_BASE,
} = {}) {
  if (!accessToken) throw new Error("fetchTradeseaHistory: accessToken required");

  const params = new URLSearchParams({
    "connection-user-id": connectionUserId,
    "connection-group-id": connectionGroupId,
    symbol: streamSymbol,
    resolution: String(resolution),
    from: String(fromSec),
    to: String(toSec),
    countback: String(countback),
    currencyCode: "USD",
  });

  const res = await fetch(`${historyBase}?${params}`, {
    headers: {
      Cookie: buildCookie(accessToken, refreshToken),
      Origin: "https://app.tradesea.ai",
      Referer: "https://app.tradesea.ai/",
      "connection-user-id": connectionUserId,
      "connection-group-id": connectionGroupId,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TradeSea history ${resolution} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  if (data.s !== "ok") {
    throw new Error(`TradeSea history ${resolution}: ${JSON.stringify(data)}`);
  }
  return data;
}

/** Last row from UDF payload (forming bar when market open). */
export function lastTradeseaBar(payload) {
  if (!payload?.t?.length) return null;
  const i = payload.t.length - 1;
  return {
    marker: payload.t[i],
    open: payload.o[i],
    high: payload.h[i],
    low: payload.l[i],
    close: payload.c[i],
    volume: payload.v?.[i],
  };
}
