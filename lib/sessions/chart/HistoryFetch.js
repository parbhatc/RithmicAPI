import { ChartSession } from "./ChartSession.js";

export class HistoryFetch {
  static async bars(options) {
    const {
      resolution,
      from,
      to,
      countback,
      barCount,
      period,
      barType,
      barTypePeriod,
      start_index,
      finish_index,
      timeoutMs,
      payload,
      timeOffset,
      compat,
      ...connectOpts
    } = options;

    const session = await ChartSession.open(connectOpts);
    try {
      return await session.planets.history.load({
        resolution,
        from,
        to,
        countback,
        barCount,
        period,
        barType,
        barTypePeriod,
        start_index,
        finish_index,
        timeoutMs,
        payload,
        timeOffset,
        compat,
      });
    } finally {
      session.close();
    }
  }

  static async history(options) {
    return this.bars({
      ...options,
      payload: true,
      compat: options?.compat ?? true,
    });
  }

  static async tickBars(options) {
    const {
      from,
      to,
      countback,
      barCount,
      resolution,
      start_index,
      finish_index,
      barType,
      barSubType,
      barTypeSpecifier,
      windowSeconds,
      timeoutMs,
      payload,
      timeOffset,
      compat,
      countbackAnchor,
      resumeBars,
      ...connectOpts
    } = options;

    const session = await ChartSession.open(connectOpts);
    try {
      return await session.planets.history.loadTick({
        from,
        to,
        countback,
        barCount,
        resolution,
        start_index,
        finish_index,
        barType,
        barSubType,
        barTypeSpecifier,
        windowSeconds,
        timeoutMs,
        payload,
        timeOffset,
        compat,
        countbackAnchor,
        resumeBars,
      });
    } finally {
      session.close();
    }
  }

  static async tickHistory(options) {
    return this.tickBars({
      ...options,
      payload: true,
      compat: options?.compat ?? false,
    });
  }
}
