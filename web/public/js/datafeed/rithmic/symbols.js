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

export function isTradingViewSymbol(sym) {
  const s = String(sym ?? "");
  return s.includes(":") || /[0-9]!$/.test(s) || s.includes("MINI");
}
