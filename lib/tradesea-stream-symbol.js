/** Rithmic symbol → TradeSea MDS/UDF stream ticker (Auren tradeseaStreamSymbol). */

const EXCHANGE_PREFIX = {
  CME: "CME",
  CBOT: "CBOT",
  NYMEX: "NYMEX",
  COMEX: "COMEX",
};

/**
 * @param {string} symbol e.g. NQ, MNQ
 * @param {string} exchange e.g. CME
 * @param {boolean} [delayed=false]
 * @returns {string} e.g. CME:NQ
 */
export function toTradeseaStreamSymbol(symbol, exchange, delayed = false) {
  const sym = String(symbol || "").trim().toUpperCase();
  const ex = String(exchange || "CME").trim().toUpperCase();
  const prefix = EXCHANGE_PREFIX[ex] ?? ex;
  if (delayed) return `${prefix}-Delayed:${sym}`;
  return `${prefix}:${sym}`;
}
