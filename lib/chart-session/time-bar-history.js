import { RequestTimeBarReplay, ResponseTimeBarReplay } from "../../protocol/index.js";
import { ReplayDirection, ReplayTimeOrder } from "../market-enums.js";
import { normalizeBar } from "../market-views.js";
import { HistoryQuery } from "../history-query.js";
import { SessionGateway } from "./util.js";

export class TimeBarHistory {
  static async load(ctx, options = {}) {
    const {
      timeoutMs = 120_000,
      payload = false,
      timeOffset = 0,
      compat = false,
      ...queryOpts
    } = options;
    const q = HistoryQuery.resolveHistoryQuery(queryOpts);
    const msg = SessionGateway.userMsg(ctx.symbol, ctx.exchange);
    const { history } = ctx;

    const replayRange = async (start_index, finish_index, user_max_count) => {
      const body = {
        symbol: ctx.symbol,
        exchange: ctx.exchange,
        user_msg: [msg],
        bar_type: q.barType,
        bar_type_period: q.barTypePeriod,
        start_index,
        finish_index,
        direction: ReplayDirection.LAST,
        time_order: ReplayTimeOrder.FORWARDS,
      };
      if (user_max_count != null) body.user_max_count = user_max_count;
      history.send(new RequestTimeBarReplay(body));

      const out = [];
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const packet = await history.receive();
        if (!(packet instanceof ResponseTimeBarReplay)) continue;

        const marker = Number(packet.marker ?? 0);
        const isBar =
          marker !== 0 &&
          (packet.open_price != null || packet.close_price != null);

        if (isBar) out.push(normalizeBar(packet, { defaultPeriod: q.periodSeconds }));
        if (packet.rp_code?.[0] === "0" && !isBar) break;
      }
      return out;
    };

    let bars = await replayRange(q.start_index, q.finish_index);

    const targetCount =
      q.countback == null
        ? null
        : q.countback + (payload && compat ? 1 : 0);

    if (targetCount != null && bars.length > 0 && bars.length < targetCount) {
      let span = Math.max(
        (targetCount - bars.length) * q.periodSeconds * 2,
        q.periodSeconds * 120,
      );
      const maxSpan = 14 * 86_400;
      let stagnant = 0;
      let loops = 0;

      while (bars.length < targetCount && loops < 20) {
        loops++;
        const firstMarker = Number(bars[0]?.marker ?? q.start_index);
        if (stagnant > 0) span = Math.min(span * 3, maxSpan);
        const extraStart = Math.floor(firstMarker - span);
        const extraEnd = Math.floor(firstMarker - q.periodSeconds);
        if (extraEnd <= extraStart) break;

        const older = await replayRange(extraStart, extraEnd);
        if (!older.length) {
          stagnant++;
          if (stagnant >= 8) break;
          continue;
        }

        const seen = new Set(bars.map((b) => Number(b.marker)));
        const uniqueOlder = older.filter((b) => !seen.has(Number(b.marker)));
        if (!uniqueOlder.length) {
          stagnant++;
          if (stagnant >= 8) break;
          continue;
        }

        stagnant = 0;
        bars = [...uniqueOlder, ...bars].sort(
          (a, b) => Number(a.marker) - Number(b.marker),
        );
      }

      if (bars.length > targetCount) {
        bars = bars.slice(-targetCount);
      }
    }

    if (payload) {
      return HistoryQuery.barsToHistoryPayload(bars, { timeOffset, compat });
    }
    return bars;
  }
}
