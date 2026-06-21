/** Default plants enabled on `ChartSession.open()`. */
export const DEFAULT_PLANTS = {
  ticker: true,
  history: true,
  order: true,
  pnl: true,
};

export function resolvePlants(plants) {
  if (plants == null) return { ...DEFAULT_PLANTS };
  if (typeof plants === "boolean") {
    return {
      ticker: plants,
      history: plants,
      order: plants,
      pnl: plants,
    };
  }
  return { ...DEFAULT_PLANTS, ...plants };
}
