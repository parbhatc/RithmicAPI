/** @typedef {{ name: string, exchange: string, tick: number }} SymbolMeta */

export const RITHMIC_SYMBOLS = {
  NQ: { name: "E-mini Nasdaq-100", exchange: "CME", tick: 0.25 },
  ES: { name: "E-mini S&P 500", exchange: "CME", tick: 0.25 },
};

const ALIASES = {
  "CME_MINI:NQ1!": "NQ",
  "CME:NQ": "NQ",
  "NQ1!": "NQ",
  "CME_MINI:ES1!": "ES",
  "CME:ES": "ES",
  "ES1!": "ES",
};

export function normalizeRithmicSymbol(sym) {
  const raw = String(sym ?? "NQ").trim();
  const upper = raw.toUpperCase();
  if (ALIASES[raw]) return ALIASES[raw];
  if (ALIASES[upper]) return ALIASES[upper];
  if (upper === "NQ" || upper === "ES") return upper;
  if (upper.includes(":")) {
    const tail = upper.split(":").pop() ?? upper;
    const base = tail.replace(/[0-9!].*$/, "");
    if (base === "NQ" || base === "ES") return base;
  }
  const base = upper.replace(/[0-9!].*$/, "");
  if (base === "NQ" || base === "ES") return base;
  return upper.length <= 4 ? upper : "NQ";
}
