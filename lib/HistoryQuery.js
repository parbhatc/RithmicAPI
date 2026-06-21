import { BarType, TickBarType, TickBarSubType } from "./marketEnums.js";
import { tickBarTime } from "./marketViews.js";

export class HistoryQuery {
  static isCalendarResolution(resolution) {
    const raw = String(resolution).trim().toUpperCase();
    return (
      raw === "D" ||
      raw === "1D" ||
      raw === "DAILY" ||
      raw === "W" ||
      raw === "1W" ||
      raw === "WEEKLY" ||
      raw === "M" ||
      raw === "1M" ||
      raw === "MONTHLY"
    );
  }

  static parseResolution(resolution = 1) {
    const raw = String(resolution).trim().toUpperCase();

    if (raw === "D" || raw === "1D" || raw === "DAILY") {
      return { barType: BarType.DAILY_BAR, barTypePeriod: 1, periodSeconds: 86_400 };
    }
    if (raw === "W" || raw === "1W" || raw === "WEEKLY") {
      return { barType: BarType.WEEKLY_BAR, barTypePeriod: 1, periodSeconds: 604_800 };
    }
    if (raw === "M" || raw === "1M" || raw === "MONTHLY") {
      return { barType: BarType.DAILY_BAR, barTypePeriod: 30, periodSeconds: 30 * 86_400 };
    }

    const secMatch = /^(\d+)S$/.exec(raw);
    if (secMatch) {
      const sec = Number(secMatch[1]);
      return { barType: BarType.SECOND_BAR, barTypePeriod: sec, periodSeconds: sec };
    }

    const minutes = Number(raw);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new Error(`Invalid resolution: ${resolution}`);
    }

    return {
      barType: BarType.MINUTE_BAR,
      barTypePeriod: minutes,
      periodSeconds: minutes * 60,
    };
  }

  static parseTickResolution(resolution = "1T") {
    const raw = String(resolution).trim().toUpperCase();
    const match = /^(\d+)\s*T?$/.exec(raw);
    if (!match) {
      throw new Error(`Invalid tick resolution: ${resolution} (expected e.g. 100T)`);
    }
    const tickSize = Number(match[1]);
    if (!Number.isFinite(tickSize) || tickSize <= 0) {
      throw new Error(`Invalid tick resolution: ${resolution}`);
    }
    return {
      barType: TickBarType.TICK_BAR,
      barSubType: TickBarSubType.REGULAR,
      barTypeSpecifier: String(tickSize),
      tickSize,
    };
  }

  static resolveTickHistoryQuery(options = {}) {
    let tick;
    if (options.barType != null) {
      const size = options.barTypeSpecifier ?? options.tickSize ?? "1";
      tick = {
        barType: options.barType,
        barSubType: options.barSubType ?? TickBarSubType.REGULAR,
        barTypeSpecifier: String(size),
        tickSize: Number(size),
      };
    } else if (options.resolution != null) {
      tick = this.parseTickResolution(options.resolution);
    } else if (options.barTypeSpecifier != null || options.tickSize != null) {
      const size = options.barTypeSpecifier ?? options.tickSize ?? "1";
      tick = {
        barType: TickBarType.TICK_BAR,
        barSubType: options.barSubType ?? TickBarSubType.REGULAR,
        barTypeSpecifier: String(size),
        tickSize: Number(size),
      };
    } else {
      tick = this.parseTickResolution("1T");
    }

    const countback = options.countback ?? options.countBack ?? options.barCount;
    let finish_index = options.finish_index ?? options.to;
    let start_index = options.start_index ?? options.from;

    if (finish_index == null) finish_index = Date.now() / 1000;
    if (start_index == null && countback != null) {
      const span = Math.max(options.windowSeconds ?? 3600, countback * 60);
      start_index = finish_index - span;
    }
    if (start_index == null) {
      const n = countback ?? 300;
      start_index = finish_index - n * 60;
    }

    return {
      ...tick,
      tickSize: tick.tickSize ?? Number(tick.barTypeSpecifier),
      start_index: Math.floor(start_index),
      finish_index: Math.floor(finish_index),
      resolution: String(options.resolution ?? `${tick.barTypeSpecifier}T`),
      countback: countback ?? null,
    };
  }

  static aggregateTickBars(bars, tickSize) {
    const n = Math.floor(Number(tickSize));
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(`Invalid tick size for aggregation: ${tickSize}`);
    }
    if (n === 1) return bars;

    const out = [];
    for (let i = 0; i + n <= bars.length; i += n) {
      const chunk = bars.slice(i, i + n);
      const first = chunk[0];
      const last = chunk[n - 1];
      let high = -Infinity;
      let low = Infinity;
      let volume = 0;
      for (const b of chunk) {
        high = Math.max(high, Number(b.high));
        low = Math.min(low, Number(b.low));
        volume += Number(b.volume ?? 0);
      }
      out.push({
        ...last,
        type_specifier: String(n),
        open: first.open,
        high,
        low,
        close: last.close,
        volume,
        t: tickBarTime(last),
      });
    }
    return out;
  }

  static resolveHistoryQuery(options = {}) {
    const resolution = options.resolution ?? options.period ?? 1;
    const { barType, barTypePeriod, periodSeconds } =
      options.barType != null
        ? {
            barType: options.barType,
            barTypePeriod: options.barTypePeriod ?? options.period ?? 1,
            periodSeconds: (options.barTypePeriod ?? options.period ?? 1) * 60,
          }
        : this.parseResolution(resolution);

    const countback = options.countback ?? options.countBack ?? options.barCount;
    let finish_index = options.finish_index ?? options.to;
    let start_index = options.start_index ?? options.from;

    if (finish_index == null) {
      finish_index = Math.floor(Date.now() / 1000);
    }

    if (start_index == null && countback != null) {
      start_index = finish_index - countback * periodSeconds;
    }

    if (start_index == null) {
      const n = countback ?? 300;
      start_index = finish_index - n * periodSeconds;
    }

    return {
      barType,
      barTypePeriod,
      periodSeconds,
      start_index: Math.floor(start_index),
      finish_index: Math.floor(finish_index),
      resolution: String(resolution),
      countback: countback ?? null,
    };
  }

  static barsToHistoryPayload(bars, { timeOffset = 0, compat = false } = {}) {
    const t = [];
    const o = [];
    const h = [];
    const l = [];
    const c = [];
    const v = [];

    const barTime = (bar) => {
      if (bar.t != null && Number.isFinite(Number(bar.t))) return Number(bar.t);
      const marker = Number(bar.marker ?? 0);
      const usecs = Number(bar.usecs ?? 0);
      return marker + (Number.isFinite(usecs) ? usecs : 0) / 1_000_000;
    };

    if (compat) {
      for (let i = 0; i + 1 < bars.length; i++) {
        const labelBar = bars[i];
        const valueBar = bars[i + 1];
        const labelT = barTime(labelBar);
        const valueT = barTime(valueBar);
        const step =
          Number(labelBar.period ?? valueBar.period) ||
          Math.max(valueT - labelT, 1e-6) ||
          60;
        const gap = valueT - labelT;
        const compatT = gap > step ? valueT - step : labelT;
        t.push(compatT + timeOffset);
        o.push(valueBar.open);
        h.push(valueBar.high);
        l.push(valueBar.low);
        c.push(valueBar.close);
        v.push(valueBar.volume ?? 0);
      }
      return { s: "ok", t, o, h, l, c, v };
    }

    for (const bar of bars) {
      t.push(barTime(bar) + timeOffset);
      o.push(bar.open);
      h.push(bar.high);
      l.push(bar.low);
      c.push(bar.close);
      v.push(bar.volume ?? 0);
    }

    return { s: "ok", t, o, h, l, c, v };
  }

  static trimCountbackBars(bars, countback, anchor = "to") {
    if (bars.length <= countback) return bars;
    if (anchor === "spread") return this.subsampleCountbackBars(bars, countback);
    return anchor === "from" ? bars.slice(0, countback) : bars.slice(-countback);
  }

  static subsampleCountbackBars(bars, countback) {
    const n = bars.length;
    if (n <= countback) return bars;
    if (countback <= 1) return [bars[0]];
    const out = [];
    for (let i = 0; i < countback; i++) {
      const idx = Math.round((i * (n - 1)) / (countback - 1));
      out.push(bars[idx]);
    }
    return out;
  }

  static effectiveHistoryCountback({ from, to, countback = 300, resolutionSec }) {
    if (from != null && to != null && resolutionSec > 0) {
      return Math.max(1, Math.ceil((to - from) / resolutionSec));
    }
    return countback;
  }

  static chartBarTimeSec(bar) {
    return Number(bar.marker ?? 0);
  }
}
