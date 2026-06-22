import { FormingBootstrapCache } from "../forming-cache.js";

/** @typedef {ReturnType<typeof createFormingState>} FormingState */

export function createFormingState(session) {
  return {
    session,
    classes: new Map(),
    targets: new Map(),
    tickSizes: new Map(),
    closed1m: [],
    partial1m: null,
    closed1h: [],
    partial1h: null,
    forming: new Map(),
    tickCounts: new Map(),
    resolutionByKey: new Map(),
    unbind: null,
    live: false,
    weeklyPriceAdjust: null,
    tradeSeaAccessToken: null,
    plan: null,
    scratch: { daily: null, monthly: null, nativeWeeklyClose: null },
    cache: FormingBootstrapCache.global(),
    useCache: true,
    fast: false,
    accuracyMode: false,
    skipStopLive: false,
    refine1mOpenInflight: false,
    lastRefine1mOpenAt: 0,
    buffered1mTrades: new Map(),
  };
}
