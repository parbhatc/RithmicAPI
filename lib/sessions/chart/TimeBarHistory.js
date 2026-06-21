import {
  RequestTimeBarReplay,
  ResponseTimeBarReplay,
  ResponseTimeBarUpdate,
} from "../../../protocol/index.js";
import { ReplayDirection, ReplayTimeOrder } from "../../marketEnums.js";
import { normalizeBar } from "../../marketViews.js";
import { HistoryQuery } from "../../HistoryQuery.js";
import { SessionGateway } from "./SessionGateway.js";
import { resolveLog } from "../../util.js";

function isReplayBar(packet) {
  const marker = Number(packet.marker ?? 0);
  return (
    marker !== 0 &&
    (packet.open_price != null ||
      packet.close_price != null ||
      packet.high_price != null ||
      packet.low_price != null)
  );
}

function replayComplete(packet, userMsg) {
  if (packet.rp_code?.[0] !== "0") return false;
  return SessionGateway.matchesUserMsg(packet, userMsg);
}

export class TimeBarHistory {
  static async load(ctx, options = {}) {
    const {
      timeoutMs = 120_000,
      payload = false,
      timeOffset = 0,
      compat = false,
      log: logOpt,
      ...queryOpts
    } = options;

    const symbol = queryOpts.symbol ?? ctx.symbol;
    const exchange = queryOpts.exchange ?? ctx.exchange;
    if (!symbol || !exchange) {
      throw new Error("symbol and exchange are required for loadHistory");
    }

    const log = resolveLog(logOpt ?? ctx.log);
    const q = HistoryQuery.resolveHistoryQuery(queryOpts);
    const msg = SessionGateway.userMsg(symbol, exchange);
    const { history } = ctx;

    if (log) {
      console.log(
        "[history] query",
        JSON.stringify(
          {
            symbol,
            exchange,
            user_msg: msg,
            resolution: q.resolution,
            from: queryOpts.from ?? queryOpts.start_index ?? null,
            to: queryOpts.to ?? queryOpts.finish_index ?? null,
            countback: q.countback,
            bar_type: q.barType,
            bar_type_period: q.barTypePeriod,
            start_index: q.start_index,
            finish_index: q.finish_index,
            period_seconds: q.periodSeconds,
            payload,
            compat,
          },
          null,
          2,
        ),
      );
    }

    const replayRange = async (start_index, finish_index, user_max_count) => {
      await history.drain({ idleMs: 200, max: 50 });

      const body = {
        symbol,
        exchange,
        user_msg: [msg],
        bar_type: q.barType,
        bar_type_period: q.barTypePeriod,
        finish_index,
        direction: ReplayDirection.LAST,
        time_order: ReplayTimeOrder.FORWARDS,
      };
      if (start_index != null) body.start_index = start_index;
      if (user_max_count != null) body.user_max_count = user_max_count;

      if (log) {
        console.log("[history] request RequestTimeBarReplay", JSON.stringify(body, null, 2));
      }

      history.send(new RequestTimeBarReplay(body));

      const out = [];
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const packet = await history.receive();

        if (packet instanceof ResponseTimeBarReplay) {
          if (isReplayBar(packet)) {
            out.push(normalizeBar(packet, { defaultPeriod: q.periodSeconds }));
            if (user_max_count != null && out.length >= user_max_count) {
              break;
            }
          } else if (replayComplete(packet, msg)) {
            if (log) {
              console.log(
                "[history] response ResponseTimeBarReplay (end)",
                JSON.stringify(
                  {
                    rp_code: packet.rp_code,
                    user_msg: packet.user_msg,
                    bars: out.length,
                  },
                  null,
                  2,
                ),
              );
            }
            break;
          }
          continue;
        }

        if (packet instanceof ResponseTimeBarUpdate && replayComplete(packet, msg)) {
          if (log) {
            console.log(
              "[history] response ResponseTimeBarUpdate (end)",
              JSON.stringify({ rp_code: packet.rp_code, user_msg: packet.user_msg }, null, 2),
            );
          }
          break;
        }
      }
      return out;
    };

    const compatExtra = compat ? 1 : 0;
    const fetchBuffer = q.countback != null && !q.isCalendar ? 20 : 0;
    const rawTarget =
      q.countback == null ? null : q.countback + compatExtra + fetchBuffer;
    const rawKeep = q.countback == null ? null : q.countback + compatExtra;
    // Compat pairs bar[i] label with bar[i+1] OHLC — replay one period past `to` for the value bar.
    const replayFinish =
      compat && rawKeep != null && !q.isCalendar
        ? q.finish_index + q.periodSeconds
        : q.finish_index;

    let bars = await replayRange(q.start_index, replayFinish, rawTarget);

    if (rawTarget != null) {
      bars = HistoryQuery.trimBarsAnchoredToFinish(bars, replayFinish, rawTarget);
    }

    const targetCount = rawTarget;

    if (
      targetCount != null &&
      bars.length > 0 &&
      bars.length < targetCount &&
      !q.isCalendar
    ) {
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

      bars = HistoryQuery.trimBarsAnchoredToFinish(bars, replayFinish, targetCount);
    }

    if (rawKeep != null && bars.length > 0 && !q.isCalendar) {
      const capFinish = HistoryQuery.intradayCountbackRawFinishCap(
        q.finish_index,
        q.periodSeconds,
        bars,
        compat,
      );
      bars = HistoryQuery.trimBarsAnchoredToFinish(bars, capFinish, rawKeep);

      if (bars.length < rawKeep) {
        let span = Math.max(
          (rawKeep - bars.length) * q.periodSeconds * 2,
          q.periodSeconds * 120,
        );
        const maxSpan = 14 * 86_400;
        let stagnant = 0;
        let loops = 0;

        while (bars.length < rawKeep && loops < 20) {
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
          bars = HistoryQuery.trimBarsAnchoredToFinish(bars, capFinish, rawKeep);
        }
      }
    }

    if (payload) {
      const result = HistoryQuery.barsToHistoryPayload(bars, {
        timeOffset,
        compat,
        periodSeconds: q.periodSeconds,
      });
      if (log) console.log(`[history] replay done: ${result.t?.length ?? 0} bars (payload)`);
      return result;
    }
    if (log) console.log(`[history] replay done: ${bars.length} bars`);
    return bars;
  }
}
