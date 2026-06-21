/** Shared credentials from environment (use --env-file=.env). */
export function env(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing env: ${name}`);
  }
  return v;
}

export function credentials() {
  return {
    user: env("RITHMIC_USER"),
    password: env("RITHMIC_PASSWORD"),
    systemName: env("RITHMIC_SYSTEM", "LucidTrading"),
  };
}

export function symbolPair() {
  return {
    symbol: env("RITHMIC_SYMBOL", "NQ"),
    exchange: env("RITHMIC_EXCHANGE", "CME"),
  };
}
