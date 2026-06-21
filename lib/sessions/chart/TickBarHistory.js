import {
  RequestTickBarReplay,
  ResponseTickBarReplay,
} from "../../../protocol/index.js";
import { ReplayDirection, ReplayTimeOrder } from "../../marketEnums.js";
import { normalizeTickBar, tickBarTime } from "../../marketViews.js";
import { HistoryQuery } from "../../HistoryQuery.js";
import { SessionGateway } from "./SessionGateway.js";

export class TickBarHistory {
  static async load(ctx, options = {}) {
    const {
      timeoutMs = 120_000,
      payload = false,
      timeOffset = 0,
      compat = false,
      windowSeconds = 3600,
      direction = ReplayDirection.LAST,
      time_order = ReplayTimeOrder.FORWARDS,
      countbackAnchor = "to",
      resumeBars,
      ...rangeOpts
    } = options;

    const query = HistoryQuery.resolveTickHistoryQuery({ windowSeconds, ...rangeOpts });
    const {
      barType,
      barSubType,
      barTypeSpecifier,
      start_index,
      finish_index,
      countback,
      tickSize = Number(barTypeSpecifier),
    } = query;

    const fromT = rangeOpts.from ?? rangeOpts.start_index;
    const toT = rangeOpts.to ?? rangeOpts.finish_index;
    const keepRaw =
      countback == null ? null : countback + (payload && compat ? 1 : 0);

    const msg = SessionGateway.userMsg(ctx.symbol, ctx.exchange);
    let bars = [];

    if (tickSize > 1) {
      bars = await this.#loadNativeInRange(
        ctx,
        {
          start_index,
          finish_index,
          barType,
          barSubType,
          barTypeSpecifier: String(tickSize),
          countback,
          countbackAnchor,
          direction,
          time_order,
          resumeBars,
          timeoutMs,
        },
        msg,
      );

      if (bars.length < (countback ?? 1)) {
        bars = await this.#loadAggregated(
          ctx,
          {
            start_index,
            finish_index,
            fromT,
            tickSize,
            countback,
            barType,
            barSubType,
            timeoutMs,
          },
          msg,
        );
      }
    } else {
      const replayBody = {
        symbol: ctx.symbol,
        exchange: ctx.exchange,
        user_msg: [msg],
        bar_type: barType,
        bar_sub_type: barSubType,
        bar_type_specifier: barTypeSpecifier,
        start_index,
        finish_index,
        direction,
        time_order,
      };
      if (countback != null) {
        replayBody.user_max_count = countback + (compat && payload ? 1 : 0);
      }
      ctx.history.send(new RequestTickBarReplay(replayBody));
      bars = await this.#receiveReplay(ctx.history, timeoutMs);
    }

    if (fromT != null || toT != null) {
      const lo = fromT != null ? Number(fromT) : -Infinity;
      const hi = toT != null ? Number(toT) : Infinity;
      bars = bars.filter((b) => {
        const t = tickBarTime(b);
        return t >= lo && t <= hi;
      });
    }
    if (keepRaw != null && bars.length > keepRaw) {
      bars = HistoryQuery.trimCountbackBars(bars, keepRaw, countbackAnchor);
    }
    if (payload) {
      return HistoryQuery.barsToHistoryPayload(bars, { timeOffset, compat });
    }
    return bars;
  }

  static async #receiveReplay(history, timeoutMs) {
    const out = [];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const packet = await history.receive();
      if (!(packet instanceof ResponseTickBarReplay)) continue;

      const isBar = packet.open_price != null || packet.close_price != null;
      if (isBar && packet.rq_handler_rp_code?.[0] === "0") {
        out.push(normalizeTickBar(packet));
      }

      const done =
        !packet.rq_handler_rp_code?.length && packet.rp_code?.length > 0;
      if (done) {
        if (packet.rp_code[0] !== "0") {
          const err = new Error(
            `Tick bar replay failed: ${packet.rp_code.join(", ")}`,
          );
          err.rpCode = packet.rp_code;
          throw err;
        }
        break;
      }
    }
    return out;
  }

  static async #replayRange(
    ctx,
    {
      start_index,
      finish_index,
      barType,
      barSubType,
      barTypeSpecifier,
      direction = ReplayDirection.LAST,
      time_order = ReplayTimeOrder.FORWARDS,
      user_max_count,
      resume_bars,
    },
    msg,
    timeoutMs,
  ) {
    const body = {
      symbol: ctx.symbol,
      exchange: ctx.exchange,
      user_msg: [msg],
      bar_type: barType,
      bar_sub_type: barSubType,
      bar_type_specifier: barTypeSpecifier,
      start_index,
      finish_index,
      direction,
      time_order,
    };
    if (user_max_count != null) body.user_max_count = user_max_count;
    if (resume_bars != null) body.resume_bars = resume_bars;
    ctx.history.send(new RequestTickBarReplay(body));
    const bars = await this.#receiveReplay(ctx.history, timeoutMs);
    bars.sort((a, b) => tickBarTime(a) - tickBarTime(b));
    return bars;
  }

  static async #loadChunked(
    ctx,
    {
      start_index,
      finish_index,
      barTypeSpecifier,
      maxBars,
      toTime,
      barType,
      barSubType,
      timeoutMs,
    },
    msg,
  ) {
    const CHUNK = 10_000;
    const all = [];
    const seen = new Set();
    let cursor = start_index;
    const endTime = toTime != null ? Number(toTime) : finish_index;
    let loops = 0;

    while (cursor < finish_index && loops < 64) {
      loops++;
      const chunk = await this.#replayRange(
        ctx,
        {
          start_index: cursor,
          finish_index,
          barType,
          barSubType,
          barTypeSpecifier,
          direction: ReplayDirection.FIRST,
          time_order: ReplayTimeOrder.FORWARDS,
          user_max_count: CHUNK,
        },
        msg,
        timeoutMs,
      );
      if (!chunk.length) break;

      for (const bar of chunk) {
        const key = `${bar.marker}:${bar.usecs}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(bar);
      }

      const last = chunk[chunk.length - 1];
      const lastT = tickBarTime(last);
      const lastSec = Math.floor(lastT);
      let nextCursor;
      if (chunk.length < CHUNK) {
        nextCursor = lastSec + 1;
      } else if (lastSec > cursor) {
        nextCursor = lastSec;
      } else {
        nextCursor = cursor + 1;
      }
      if (nextCursor <= cursor) break;
      cursor = nextCursor;

      if (maxBars != null && all.length >= maxBars) break;
      if (lastT >= endTime - 1 && chunk.length < CHUNK) break;
    }

    all.sort((a, b) => tickBarTime(a) - tickBarTime(b));
    return all;
  }

  static async #replayCountbackNative(
    ctx,
    {
      start_index,
      finish_index,
      barType,
      barSubType,
      barTypeSpecifier,
      countback,
      countbackAnchor = "to",
      resumeBars,
      timeoutMs,
    },
    msg,
  ) {
    if (countback == null || countbackAnchor === "spread") return null;

    const direction =
      countbackAnchor === "from" ? ReplayDirection.FIRST : ReplayDirection.LAST;
    const time_order = ReplayTimeOrder.FORWARDS;

    return this.#replayRange(
      ctx,
      {
        start_index,
        finish_index,
        barType,
        barSubType,
        barTypeSpecifier,
        direction,
        time_order,
        user_max_count: countback,
        resume_bars: resumeBars,
      },
      msg,
      timeoutMs,
    );
  }

  static async #loadNativeInRange(
    ctx,
    {
      start_index,
      finish_index,
      barType,
      barSubType,
      barTypeSpecifier,
      countback,
      countbackAnchor = "to",
      direction = ReplayDirection.LAST,
      time_order = ReplayTimeOrder.FORWARDS,
      resumeBars,
      timeoutMs,
    },
    msg,
  ) {
    if (countback != null && countbackAnchor !== "spread") {
      try {
        const bounded = await this.#replayCountbackNative(
          ctx,
          {
            start_index,
            finish_index,
            barType,
            barSubType,
            barTypeSpecifier,
            countback,
            countbackAnchor,
            resumeBars,
            timeoutMs,
          },
          msg,
        );
        if (bounded?.length >= countback) {
          bounded.sort((a, b) => tickBarTime(a) - tickBarTime(b));
          return countbackAnchor === "from"
            ? bounded.slice(0, countback)
            : bounded.slice(-countback);
        }
      } catch (err) {
        if (!String(err?.rpCode?.[0] ?? err.message).includes("6")) throw err;
      }
    }

    if (countback != null) {
      const quick = await this.#replayRange(
        ctx,
        {
          start_index,
          finish_index,
          barType,
          barSubType,
          barTypeSpecifier,
          direction,
          time_order,
          user_max_count: countback,
          resume_bars: resumeBars,
        },
        msg,
        timeoutMs,
      );
      if (quick.length >= countback) return quick;
    }

    let bars = await this.#loadChunked(
      ctx,
      {
        start_index,
        finish_index,
        barTypeSpecifier,
        maxBars: null,
        barType,
        barSubType,
        timeoutMs,
      },
      msg,
    );

    if (!bars.length) {
      bars = await this.#replayRange(
        ctx,
        {
          start_index,
          finish_index,
          barType,
          barSubType,
          barTypeSpecifier,
          direction: ReplayDirection.LAST,
          time_order: ReplayTimeOrder.FORWARDS,
        },
        msg,
        timeoutMs,
      );
    }

    if (countback != null && bars.length > 0 && bars.length < countback) {
      let loops = 0;
      while (bars.length < countback && loops < 12) {
        loops++;
        const firstT = tickBarTime(bars[0]);
        const needed = countback - bars.length;
        const span = Math.max(needed * 120, 3600);
        const extraStart = Math.floor(firstT - span);
        const extraEnd = Math.floor(firstT - 1);
        if (extraEnd <= extraStart || extraEnd < start_index) break;

        const older = await this.#replayRange(
          ctx,
          {
            start_index: extraStart,
            finish_index: extraEnd,
            barType,
            barSubType,
            barTypeSpecifier,
            direction: ReplayDirection.LAST,
            time_order: ReplayTimeOrder.FORWARDS,
          },
          msg,
          timeoutMs,
        );
        if (!older.length) break;

        const seen = new Set(bars.map((b) => `${b.marker}:${b.usecs}`));
        const uniqueOlder = older.filter((b) => !seen.has(`${b.marker}:${b.usecs}`));
        if (!uniqueOlder.length) break;
        bars = [...uniqueOlder, ...bars];
      }
    }

    return bars;
  }

  static async #loadBackwardsChunked(
    ctx,
    {
      start_index,
      finish_index,
      fromTime,
      barType,
      barSubType,
      timeoutMs,
    },
    msg,
  ) {
    const CHUNK = 10_000;
    const seen = new Set();
    const all = [];
    let endCursor = finish_index;
    const fromTarget = fromTime != null ? Number(fromTime) : start_index;
    let loops = 0;

    while (loops < 64) {
      loops++;
      const chunk = await this.#replayRange(
        ctx,
        {
          start_index,
          finish_index: endCursor,
          barType,
          barSubType,
          barTypeSpecifier: "1",
          direction: ReplayDirection.LAST,
          time_order: ReplayTimeOrder.BACKWARDS,
          user_max_count: CHUNK,
        },
        msg,
        timeoutMs,
      );
      if (!chunk.length) break;

      let oldestT = Infinity;
      for (const bar of chunk) {
        const key = `${bar.marker}:${bar.usecs}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(bar);
        oldestT = Math.min(oldestT, tickBarTime(bar));
      }

      if (oldestT <= fromTarget + 1) break;
      if (chunk.length < CHUNK) break;

      const nextEnd = Math.floor(oldestT) - 1;
      if (nextEnd < start_index || nextEnd >= endCursor) break;
      endCursor = nextEnd;
    }

    all.sort((a, b) => tickBarTime(a) - tickBarTime(b));
    return all;
  }

  static async #loadAggregated(
    ctx,
    {
      start_index,
      finish_index,
      fromT,
      tickSize,
      countback,
      barType,
      barSubType,
      timeoutMs,
    },
    msg,
  ) {
    const targetBars = countback ?? 300;
    const minTicks = targetBars * tickSize + tickSize * 2;
    const fromTarget = fromT != null ? Number(fromT) : start_index;

    let oneTick = await this.#loadBackwardsChunked(
      ctx,
      {
        start_index,
        finish_index,
        fromTime: fromTarget,
        barType,
        barSubType,
        timeoutMs,
      },
      msg,
    );

    if (!oneTick.length) return [];

    if (tickBarTime(oneTick[0]) > fromTarget + 30) {
      const early = await this.#loadChunked(
        ctx,
        {
          start_index,
          finish_index: Math.floor(tickBarTime(oneTick[0])),
          barTypeSpecifier: "1",
          maxBars: null,
          toTime: tickBarTime(oneTick[0]),
          barType,
          barSubType,
          timeoutMs,
        },
        msg,
      );
      const seen = new Set(oneTick.map((b) => `${b.marker}:${b.usecs}`));
      for (const b of early) {
        const key = `${b.marker}:${b.usecs}`;
        if (!seen.has(key)) oneTick.push(b);
      }
      oneTick.sort((a, b) => tickBarTime(a) - tickBarTime(b));
    }

    return HistoryQuery.aggregateTickBars(oneTick, tickSize);
  }
}
