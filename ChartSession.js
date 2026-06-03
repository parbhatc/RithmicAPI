import { EventEmitter } from "node:events";
import { connect, discover } from "./init.js";
import { InfraType } from "./protocol/RequestLogin.js";
import {
  RequestLogin,
  RequestLoginInfo,
  RequestHeartbeat,
  RequestMarketDataUpdate,
  RequestReferenceData,
  RequestTimeBarReplay,
  RequestTimeBarUpdate,
  ResponseTimeBarReplay,
  RequestTickBarReplay,
  ResponseTickBarReplay,
  LastTrade,
  BestBidOffer,
  ClosePrice,
  HighPriceLowPrice,
  TimeBar,
} from "./protocol/index.js";
import {
  BarType,
  TickBarType,
  TickBarSubType,
  ReplayDirection,
  ReplayTimeOrder,
  SubscribeRequest,
  MarketUpdatePreset,
  LastTradePresence,
  BestBidOfferPresence,
} from "./lib/market-enums.js";
import {
  normalizeBar,
  normalizeTickBar,
  normalizeTrade,
  normalizeQuote,
  normalizeClosePrice,
  normalizeHighLow,
  mergeTick,
  chartStatus,
} from "./lib/market-views.js";
import {
  resolveHistoryQuery,
  resolveTickHistoryQuery,
  barsToHistoryPayload,
  aggregateTickBars,
  trimCountbackBars,
} from "./lib/history-query.js";
import {
  aggregateReplayOHLC,
  applyTradeToFormingBar,
  applyBucketOpen,
  bucketOpen,
  periodSecondsFromBarType,
  seedFormingBar,
  splitHistoryForForming,
  isUsablePrice,
} from "./lib/forming-bar.js";
import { parseResolution, parseTickResolution } from "./lib/history-query.js";
import { tickBarTime } from "./lib/market-views.js";
import {
  FormingReconstructKind,
  resolveDataLayer,
  aggregatePartialTickForming,
  formingReplayWindowSeconds,
} from "./lib/forming-reconstruct.js";
import { mergeFormingFromTimeBar } from "./lib/forming-bar.js";
import { deriveFormingFrom1m, ONE_MINUTE_PERIOD } from "./lib/candle-layer.js";

const WEB_APP = {
  template_version: "2.0",
  app_name: "Rithmic Trader Pro - Web",
  app_version: "2.8.0.0",
};

function userMsg(symbol, exchange) {
  return `${symbol}.${exchange}`;
}

function hasBit(bits, flag) {
  return ((bits ?? 0) & flag) !== 0;
}

async function resolveGatewayUri({ systemName, uri, gatewayName }) {
  if (uri) return uri;
  const { gateways } = await discover(systemName, { timeoutMs: 45_000, connectRetries: 3 });
  if (gatewayName) {
    const match = gateways.find((g) => g.name.includes(gatewayName));
    if (match) return match.uri;
  }
  const chicago = gateways.find((g) => /chicago/i.test(g.name));
  return (chicago ?? gateways[0]).uri;
}

async function loginPlant(client, credentials, infraType) {
  const login = await client.exchange(
    new RequestLogin({
      user: credentials.user,
      password: credentials.password,
      system_name: credentials.systemName,
      infra_type: infraType,
      user_msg: ["new"],
      ...WEB_APP,
    }),
  );
  if (!login.ok) {
    throw new Error(`${client.label} login failed: ${login.rp_code?.join(", ")}`);
  }
  await client.exchange(new RequestLoginInfo(login.unique_user_id));
  return login;
}

/**
 * Live + historical chart session (ticker plant + history plant).
 *
 * Emits:
 * - `trade` — LastTrade (150)
 * - `quote` — BestBidOffer (151)
 * - `latest_high_low` — HighPriceLowPrice (152)
 * - `latest_close` — ClosePrice (155)
 * - `bar` — TimeBar (250) when a bucket **closes** (not while forming)
 * - `formingBar` — current open bucket built from LastTrade (+ optional seed)
 * - `status` — merged last/bid/ask/bar snapshot
 * - `message` — any other decoded packet (debug)
 */
export class ChartSession extends EventEmitter {
  #ticker = null;
  #history = null;
  #live = false;
  #pumps = [];
  #heartbeatTimer = null;
  #trade = null;
  #quote = null;
  #bar = null;
  #latestHighLow = null;
  #latestClose = null;
  #liveBarType = null;
  #liveBarPeriod = null;
  #formingPeriodSeconds = null;
  #formingBar = null;
  #formingSeedOpen = null;

  constructor() {
    super();
    this.symbol = null;
    this.exchange = null;
    this.uri = null;
  }

  /** Latest merged status for chart headers. */
  get status() {
    return chartStatus({
      symbol: this.symbol,
      exchange: this.exchange,
      trade: this.#trade,
      quote: this.#quote,
      bar: this.#bar,
      latestHighLow: this.#latestHighLow,
      latestClose: this.#latestClose,
    });
  }

  /**
   * Connect ticker + history plants on a regional gateway.
   *
   * @param {object} options
   * @param {string} options.user
   * @param {string} options.password
   * @param {string} options.systemName
   * @param {string} options.symbol
   * @param {string} options.exchange
   * @param {string} [options.uri] Gateway WebSocket URL (from `discover()`)
   * @param {string} [options.gatewayName] Pick gateway by name substring
   * @param {boolean} [options.heartbeat=true] Send periodic heartbeats while live
   */
  static async open(options) {
    const session = new ChartSession();
    await session.connect(options);
    return session;
  }

  async connect({ user, password, systemName, symbol, exchange, uri, gatewayName, heartbeat = true }) {
    if (!user || !password) throw new Error("user and password are required");
    if (!systemName || !symbol || !exchange) {
      throw new Error("systemName, symbol, and exchange are required");
    }

    this.symbol = symbol;
    this.exchange = exchange;
    this.uri = await resolveGatewayUri({ systemName, uri, gatewayName });

    const credentials = { user, password, systemName };

    this.#ticker = await connect({
      uri: this.uri,
      label: "ticker",
      log: false,
      timeoutMs: 45_000,
      connectRetries: 3,
    });
    this.#history = await connect({
      uri: this.uri,
      label: "history",
      log: false,
      timeoutMs: 180_000,
    });

    await loginPlant(this.#ticker, credentials, InfraType.TICKER_PLANT);
    await loginPlant(this.#history, credentials, InfraType.HISTORY_PLANT);

    if (heartbeat) {
      this.#heartbeatTimer = setInterval(() => {
        const ts = String(Math.floor(Date.now() / 1000));
        try {
          if (this.#ticker?.ws?.readyState === 1) {
            this.#ticker.send(new RequestHeartbeat({ user_msg: [ts] }));
          }
          if (this.#history?.ws?.readyState === 1) {
            this.#history.send(new RequestHeartbeat({ user_msg: [ts] }));
          }
        } catch {
          /* connection closing */
        }
      }, 25_000);
      this.#heartbeatTimer.unref?.();
    }
  }

  /**
   * Replay historical OHLC bars (history plant, template 202 → 203).
   *
   * TradingView-style: `resolution`, `from`, `to`, `countback`
   * (e.g. `resolution=1&from=1779788481&to=1779929351&countback=300`).
   *
   * Legacy: `barCount`, `period`, `start_index`, `finish_index`, `barType`.
   *
   * @param {object} [options]
   * @param {number|string} [options.resolution=1] Bar size in minutes, or `"1D"` / `"1W"`
   * @param {number} [options.from] Range start (Unix s) → `start_index`
   * @param {number} [options.to] Range end (Unix s) → `finish_index`
   * @param {number} [options.countback] Bar count when `from` omitted
   * @param {number} [options.timeoutMs=120000]
   * @param {boolean} [options.payload=false] If true, return `{ s, t, o, h, l, c, v }`
   * @param {number} [options.timeOffset=0] Seconds added to each `t` in payload mode
   * @param {boolean} [options.compat=false] Shift OHLCV by one bar for compatibility mode
   * @param {boolean} [options.include_forming=false] If false, drop the open-bucket partial bar from replay
   * @returns {Promise<object[]|{ s: string, t: number[], o: number[], h: number[], l: number[], c: number[], v: number[] }>}
   */
  async loadHistory(options = {}) {
    const {
      timeoutMs = 120_000,
      payload = false,
      timeOffset = 0,
      compat = false,
      include_forming = false,
      ...queryOpts
    } = options;
    const q = resolveHistoryQuery(queryOpts);
    const msg = userMsg(this.symbol, this.exchange);
    const replayRange = async (start_index, finish_index) => {
      this.#history.send(
        new RequestTimeBarReplay({
          symbol: this.symbol,
          exchange: this.exchange,
          user_msg: [msg],
          bar_type: q.barType,
          bar_type_period: q.barTypePeriod,
          start_index,
          finish_index,
          direction: ReplayDirection.LAST,
          time_order: ReplayTimeOrder.FORWARDS,
        }),
      );

      const out = [];
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const packet = await this.#history.receive();
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

    // If caller asked for countback and the explicit range is too short, backfill older bars.
    if (targetCount != null && bars.length > 0 && bars.length < targetCount) {
      let loops = 0;
      while (bars.length < targetCount && loops < 8) {
        loops++;
        const firstMarker = Number(bars[0]?.marker ?? q.start_index);
        const needed = targetCount - bars.length;
        const span = Math.max(needed * q.periodSeconds * 2, q.periodSeconds * 120);
        const extraStart = Math.floor(firstMarker - span);
        const extraEnd = Math.floor(firstMarker - q.periodSeconds);
        if (extraEnd <= extraStart) break;

        const older = await replayRange(extraStart, extraEnd);
        if (!older.length) break;

        const seen = new Set(bars.map((b) => Number(b.marker)));
        const uniqueOlder = older.filter((b) => !seen.has(Number(b.marker)));
        if (!uniqueOlder.length) break;

        bars = [...uniqueOlder, ...bars];
      }

      if (bars.length > targetCount) {
        bars = bars.slice(-targetCount);
      }
    }

    if (!include_forming) {
      const { closed } = splitHistoryForForming(bars, q.periodSeconds);
      bars = closed;
    }

    if (payload) return barsToHistoryPayload(bars, { timeOffset, compat });
    return bars;
  }

  /**
   * Replay tick / range / volume bars (history plant, template 206 → 207).
   *
   * @param {object} [options]
   * @param {number} [options.from] Range start (Unix s)
   * @param {number} [options.to] Range end (Unix s)
   * @param {number} [options.countback] Max bars to keep (also sets time window if `from` omitted)
   * @param {number} [options.barCount] Alias for `countback`
   * @param {number} [options.barType=TickBarType.TICK_BAR]
   * @param {number} [options.barSubType=TickBarSubType.REGULAR]
   * @param {string} [options.barTypeSpecifier="1"] e.g. `"1"` = 1-tick bars, `"100"` = 100-tick bars
   * @param {string} [options.resolution] Chart resolution e.g. `"100T"` (sets tick size + specifier)
   * @param {number} [options.windowSeconds=3600] Time span when deriving `from` from `countback`
   * @param {number} [options.timeoutMs=120000]
   * @param {boolean} [options.payload=false] Return `{ s, t, o, h, l, c, v }`
   * @param {number} [options.timeOffset=0] Seconds added to each `t` in payload mode
   * @param {boolean} [options.compat=false] Shift OHLCV by one bar in payload mode
   * @returns {Promise<object[]|{ s: string, t: number[], o: number[], h: number[], l: number[], c: number[], v: number[] }>}
   */
  async #receiveTickBarReplay(timeoutMs) {
    const out = [];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const packet = await this.#history.receive();
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

  /**
   * Replay tick bars over `[start_index, finish_index]` (native specifier).
   * @private
   */
  async #replayTickBarRange(
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
      symbol: this.symbol,
      exchange: this.exchange,
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
    this.#history.send(new RequestTickBarReplay(body));
    const bars = await this.#receiveTickBarReplay(timeoutMs);
    bars.sort((a, b) => tickBarTime(a) - tickBarTime(b));
    return bars;
  }

  /**
   * Paginate tick replay when the server caps bars per request (~10k).
   * @private
   */
  async #loadTickBarsChunked(
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
      const chunk = await this.#replayTickBarRange(
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
      // start_index/finish_index are whole seconds; stay on the same second when a full
      // chunk may still have more bars in that second (RProtocolAPI SampleBar uses seconds only).
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

  /**
   * Bounded replay using RProtocol `user_max_count` + direction/time_order (see request_tick_bar_replay.proto).
   * @private
   */
  async #replayCountbackNative(
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

    // RProtocol allows BACKWARDS, but some gateways reject LAST+BACKWARDS+user_max_count (rp 6).
    // Official SampleBar only sets start_index/finish_index (defaults → FORWARDS).
    const direction =
      countbackAnchor === "from" ? ReplayDirection.FIRST : ReplayDirection.LAST;
    const time_order = ReplayTimeOrder.FORWARDS;

    const body = {
      start_index,
      finish_index,
      barType,
      barSubType,
      barTypeSpecifier,
      direction,
      time_order,
      user_max_count: countback,
    };
    return this.#replayTickBarRange(
      { ...body, resume_bars: resumeBars },
      msg,
      timeoutMs,
    );
  }

  /**
   * Native N-tick bars over a range, with optional backfill when `countback` is short.
   * @private
   */
  async #loadNativeTickBarsInRange(
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
      const quick = await this.#replayTickBarRange(
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

    let bars = await this.#loadTickBarsChunked(
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
      bars = await this.#replayTickBarRange(
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

        const older = await this.#replayTickBarRange(
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

  /**
   * Paginate 1-tick replay backwards from `finish_index` (for dense tick streams).
   * @private
   */
  async #loadTickBarsBackwardsChunked(
    {
      start_index,
      finish_index,
      minTicks,
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
      const chunk = await this.#replayTickBarRange(
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

  /**
   * Build N-tick bars from 1-tick replay across the requested window.
   * @private
   */
  async #loadAggregatedTickBars(
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

    let oneTick = await this.#loadTickBarsBackwardsChunked(
      {
        start_index,
        finish_index,
        minTicks,
        fromTime: fromTarget,
        barType,
        barSubType,
        timeoutMs,
      },
      msg,
    );

    if (!oneTick.length) return [];

    if (tickBarTime(oneTick[0]) > fromTarget + 30) {
      const early = await this.#loadTickBarsChunked(
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

    return aggregateTickBars(oneTick, tickSize);
  }

  async loadTickHistory(options = {}) {
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

    const query = resolveTickHistoryQuery({ windowSeconds, ...rangeOpts });
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

    const msg = userMsg(this.symbol, this.exchange);
    let bars = [];

    if (tickSize > 1) {
      bars = await this.#loadNativeTickBarsInRange(
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
        bars = await this.#loadAggregatedTickBars(
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
        symbol: this.symbol,
        exchange: this.exchange,
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
      this.#history.send(new RequestTickBarReplay(replayBody));
      bars = await this.#receiveTickBarReplay(timeoutMs);
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
      bars = trimCountbackBars(bars, keepRaw, countbackAnchor);
    }
    if (payload) return barsToHistoryPayload(bars, { timeOffset, compat });
    return bars;
  }

  /**
   * Seed the open **1m** bucket (replay partial + optional ticks in that minute only).
   * Use `CandleLayer` for all minute+ timeframes.
   */
  async seedForming1m({
    partial1m = null,
    priorClose = null,
    tickOpen = true,
    timeoutMs = 45_000,
  } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const bucket = bucketOpen(now, ONE_MINUTE_PERIOD);
    let bar = null;

    if (tickOpen) {
      const tickEnd = Math.max(now + 1, bucket + ONE_MINUTE_PERIOD);
      const fromTicks = await this.replay1mFromTicks(bucket, tickEnd, { timeoutMs });
      if (fromTicks) {
        return { ...fromTicks, forming: true, replaySource: "1m-tick-refined" };
      }
    }

    if (partial1m && Number(partial1m.marker) === bucket) {
      bar = { ...partial1m, forming: true, replaySource: "1m-partial" };
    }

    if (!bar && partial1m) {
      const prior = priorClose != null ? Number(priorClose) : null;
      const o = Number(partial1m.open);
      if (isUsablePrice(o) && (prior == null || Math.abs(o - prior) >= 0.01)) {
        bar = { ...partial1m, marker: bucket, forming: true, replaySource: "1m-partial" };
      }
    }

    return bar;
  }

  /**
   * Rebuild 1m bars from tick replay (fixes bad Rithmic 1m H/L in an open HTF bucket).
   * @returns {Promise<object[]>}
   */
  async replay1mBarsFromTicks(fromSec, toSec, { timeoutMs = 45_000 } = {}) {
    const from = Math.floor(fromSec);
    const to = Math.floor(toSec);
    const ticks = await this.loadTickHistory({
      from,
      to,
      barTypeSpecifier: "1",
      timeoutMs,
      windowSeconds: Math.max(120, to - from + 30),
      direction: ReplayDirection.FIRST,
      time_order: ReplayTimeOrder.FORWARDS,
    });

    const buckets = new Map();
    for (const b of ticks) {
      const t = tickBarTime(b);
      if (t < from || t >= to) continue;
      const marker = bucketOpen(t, ONE_MINUTE_PERIOD);
      if (!buckets.has(marker)) buckets.set(marker, []);
      buckets.get(marker).push(b);
    }

    const out = [];
    for (const marker of [...buckets.keys()].sort((a, b) => a - b)) {
      const bar = aggregateReplayOHLC(buckets.get(marker), {
        marker,
        periodSeconds: ONE_MINUTE_PERIOD,
        symbol: this.symbol,
        exchange: this.exchange,
      });
      if (bar) {
        out.push({ ...bar, forming: false, replaySource: "1m-tick-refined" });
      }
    }
    return out;
  }

  /** @returns {Promise<object|null>} */
  async replay1mFromTicks(fromSec, toSec, opts = {}) {
    const bars = await this.replay1mBarsFromTicks(fromSec, toSec, opts);
    const from = Math.floor(fromSec);
    return bars.find((b) => Number(b.marker) === from) ?? null;
  }

  /**
   * First trade price in `[fromSec, toSec)` — used once per HTF bucket (first minute only).
   */
  async firstTickPriceInRange(fromSec, toSec, { timeoutMs = 45_000 } = {}) {
    const from = Math.floor(fromSec);
    const to = Math.floor(toSec);
    const ticks = await this.loadTickHistory({
      from,
      to,
      barTypeSpecifier: "1",
      timeoutMs,
      windowSeconds: Math.max(120, to - from + 30),
      direction: ReplayDirection.FIRST,
      time_order: ReplayTimeOrder.FORWARDS,
    });
    const first = ticks
      .filter((b) => tickBarTime(b) >= from)
      .sort((a, b) => tickBarTime(a) - tickBarTime(b))[0];
    const price = Number(first?.open ?? first?.close);
    return isUsablePrice(price) ? price : null;
  }

  /**
   * Forming bar for isolated seconds/tick charts, or derive from `closed1m` / `forming1m`.
   * Prefer `CandleLayer.load1m()` + `getForming(resolution)` for minute+ charts.
   */
  async fetchExactFormingBar({
    resolution = 15,
    marker,
    timeoutMs = 45_000,
    closed1m = null,
    forming1m = null,
  } = {}) {
    const layer = resolveDataLayer(resolution);
    const now = Math.floor(Date.now() / 1000);

    if (layer.layer === "1m") {
      if (!closed1m) return null;
      const { periodSeconds } = parseResolution(resolution);
      const bucket = marker ?? bucketOpen(now, periodSeconds);
      const bar = deriveFormingFrom1m(closed1m, forming1m, periodSeconds, {
        nowSec: now,
        symbol: this.symbol,
        exchange: this.exchange,
      });
      if (!bar) return null;
      return { bar, bucket, source: "1m-derived", strategy: layer };
    }

    const strategy = {
      kind: FormingReconstructKind.TICK_REPLAY,
      tickSize: layer.tickSize ?? 1,
      periodSeconds: layer.periodSeconds ?? null,
      sourceLabel: layer.sourceLabel,
    };
    return this.#fetchExactFormingTickReplay({
      resolution,
      strategy,
      marker,
      timeoutMs,
      now,
    });
  }

  async #fetchExactFormingTickReplay({ resolution, strategy, marker, timeoutMs, now }) {
    const { tickSize } = strategy.tickSize != null
      ? { tickSize: strategy.tickSize }
      : parseTickResolution(resolution);
    const finish = now + 120;
    const periodSeconds = strategy.periodSeconds;
    const bucket =
      marker ??
      (periodSeconds != null ? bucketOpen(now, periodSeconds) : now - formingReplayWindowSeconds(null, tickSize));
    const from =
      periodSeconds != null
        ? bucket
        : Math.floor(bucket) - formingReplayWindowSeconds(null, tickSize);

    const ticks = await this.loadTickHistory({
      from,
      to: finish,
      barTypeSpecifier: "1",
      timeoutMs,
      windowSeconds: formingReplayWindowSeconds(periodSeconds, tickSize),
      direction: ReplayDirection.FIRST,
      time_order: ReplayTimeOrder.FORWARDS,
    });

    if (tickSize > 1) {
      const { forming, tickCount } = aggregatePartialTickForming(ticks, tickSize);
      if (forming) {
        return {
          bar: forming,
          bucket: Number(forming.marker),
          source: strategy.sourceLabel,
          tickCount,
          strategy,
        };
      }
    }

    const inBucket =
      periodSeconds != null
        ? ticks.filter((b) => tickBarTime(b) >= bucket)
        : ticks;
    const base = {
      marker: periodSeconds != null ? bucket : tickBarTime(inBucket[0] ?? ticks[0]),
      symbol: this.symbol,
      exchange: this.exchange,
    };
    const bar = aggregateReplayOHLC(inBucket.length ? inBucket : ticks, base);
    if (!bar) return null;
    return {
      bar,
      bucket: Number(bar.marker),
      source: strategy.sourceLabel,
      tickCount: inBucket.length,
      strategy,
    };
  }

  /** @deprecated Use `fetchExactFormingBar` — returns only `open`. */
  async fetchExactBucketOpen(options = {}) {
    const hit = await this.fetchExactFormingBar(options);
    if (!hit) return null;
    return {
      open: hit.bar.open,
      bucket: hit.bucket,
      source: hit.source,
      bar: hit.bar,
    };
  }

  /**
   * Subscribe to live last trade, bid/ask, and forming bars.
   * Starts background readers; emits `trade`, `quote`, `bar`, `status`.
   *
   * @param {object} [options]
   * @param {number} [options.updateBits=MarketUpdatePreset.QUOTE]
   * @param {boolean} [options.referenceData=true] Send RequestReferenceData before subscribe (web app does this)
   * @param {string} [options.priceType='final'] Reference data price type (`user_msg[1]`)
   * @param {string} [options.referenceMode='auto'] Reference data mode (`user_msg[2]`)
   * @param {number} [options.barType=BarType.MINUTE_BAR]
   * @param {number} [options.barPeriod=1]
   * @param {object} [options.seedFormingFrom] Last bar from `loadHistory` (may be partial current bucket)
   * @param {object[]} [options.seedFormingBars] Full replay series (for partial snapshot)
   * @param {number|string} [options.resolution] For `fetchExactBucketOpen` (e.g. `15`)
   * @param {boolean} [options.exactFormingBar=true] Replay ticks to rebuild bucket OHLCV
   * @param {object} [options.exactBar] Pre-built forming bar (skips fetch)
   * @param {boolean} [options.exactBucketOpen] Alias for `exactFormingBar`
   * @param {number} [options.exactOpen] Legacy: only seeds open, not H/L
   */
  async startLive({
    updateBits = MarketUpdatePreset.QUOTE,
    referenceData = true,
    priceType = "final",
    referenceMode = "auto",
    barType = BarType.MINUTE_BAR,
    barPeriod = 1,
    seedFormingFrom = null,
    seedFormingBars = null,
    resolution,
    exactFormingBar = true,
    exactBucketOpen,
    exactBar: exactBarIn = null,
    exactOpen: exactOpenIn = null,
  } = {}) {
    if (this.#live) return;
    const msg = userMsg(this.symbol, this.exchange);

    this.#liveBarType = BarType.MINUTE_BAR;
    this.#liveBarPeriod = 1;
    this.#formingPeriodSeconds = ONE_MINUTE_PERIOD;

    let exactBar = exactBarIn;
    let replaySource = exactBarIn ? "provided" : null;

    const wantExact = exactFormingBar ?? exactBucketOpen ?? true;
    if (wantExact && !exactBar && exactOpenIn == null) {
      exactBar = await this.seedForming1m({
        partial1m: seedFormingFrom,
        timeoutMs: 45_000,
      });
      if (exactBar) replaySource = exactBar.replaySource ?? "1m-seed";
    }

    this.#formingBar = seedFormingBar(seedFormingFrom, {
      periodSeconds: this.#formingPeriodSeconds,
      symbol: this.symbol,
      exchange: this.exchange,
      bars: seedFormingBars,
      exactBar,
      exactOpen: exactBar ? null : exactOpenIn,
    });
    if (this.#formingBar && replaySource) this.#formingBar.replaySource = replaySource;
    this.#formingSeedOpen = this.#formingBar?.open ?? null;
    if (this.#formingBar) this.emit("formingBar", this.#formingBar);

    if (referenceData) {
      await this.#ticker.exchange(
        new RequestReferenceData({
          symbol: this.symbol,
          exchange: this.exchange,
          user_msg: [msg, priceType, referenceMode],
        }),
      );
    }

    await this.#ticker.exchange(
      new RequestMarketDataUpdate({
        symbol: this.symbol,
        exchange: this.exchange,
        user_msg: [msg],
        request: SubscribeRequest.SUBSCRIBE,
        update_bits: updateBits,
      }),
    );

    await this.#history.exchange(
      new RequestTimeBarUpdate({
        symbol: this.symbol,
        exchange: this.exchange,
        user_msg: [msg],
        request: SubscribeRequest.SUBSCRIBE,
        bar_type: BarType.MINUTE_BAR,
        bar_type_period: 1,
      }),
    );

    // Snapshots often arrive right after subscribe, before the pump loop runs.
    const earlyTicker = await this.#ticker.drain({ idleMs: 400, max: 30 });
    for (const packet of earlyTicker) {
      this.#dispatch(packet, "ticker");
    }
    const earlyHistory = await this.#history.drain({ idleMs: 400, max: 30 });
    for (const packet of earlyHistory) {
      this.#dispatch(packet, "history");
    }

    this.#live = true;
    this.#pumps.push(this.#pump(this.#ticker, "ticker"), this.#pump(this.#history, "history"));
  }

  /** Unsubscribe live feeds and stop background readers. */
  async stopLive() {
    if (!this.#live) return;
    const msg = userMsg(this.symbol, this.exchange);

    try {
      await this.#ticker.exchange(
        new RequestMarketDataUpdate({
          symbol: this.symbol,
          exchange: this.exchange,
          user_msg: [msg],
          request: SubscribeRequest.UNSUBSCRIBE,
          update_bits: MarketUpdatePreset.QUOTE,
        }),
      );
    } catch {
      /* ignore */
    }

    try {
      await this.#history.exchange(
        new RequestTimeBarUpdate({
          symbol: this.symbol,
          exchange: this.exchange,
          user_msg: [msg],
          request: SubscribeRequest.UNSUBSCRIBE,
          bar_type: this.#liveBarType ?? BarType.MINUTE_BAR,
          bar_type_period: this.#liveBarPeriod ?? 1,
        }),
      );
    } catch {
      /* ignore */
    }

    this.#live = false;
    this.#liveBarType = null;
    this.#liveBarPeriod = null;
    this.#formingPeriodSeconds = null;
    this.#formingBar = null;
    this.#formingSeedOpen = null;
    await Promise.allSettled(this.#pumps);
    this.#pumps = [];
  }

  async #pump(client, label) {
    while (this.#live && client.ws?.readyState === 1) {
      let packet;
      try {
        packet = await client.receive();
      } catch {
        if (!this.#live) break;
        continue;
      }
      this.#dispatch(packet, label);
    }
  }

  #dispatch(packet, plant) {
    if (packet instanceof LastTrade) {
      const partial = normalizeTrade(packet);
      this.#trade = mergeTick(this.#trade, partial);
      if (hasBit(partial.presence_bits, LastTradePresence.LAST_TRADE)) {
        this.emit("trade", this.#trade);
      if (this.#formingPeriodSeconds === ONE_MINUTE_PERIOD) {
        const next = applyTradeToFormingBar(this.#formingBar, this.#trade, {
          periodSeconds: ONE_MINUTE_PERIOD,
          symbol: this.symbol,
          exchange: this.exchange,
          seedOpen: this.#formingSeedOpen,
        });
        if (next) {
          this.#formingBar = next;
          this.#bar = next;
          this.emit("formingBar", this.#formingBar);
        }
      }
      }
      this.emit("status", this.status);
      return;
    }
    if (packet instanceof BestBidOffer) {
      const partial = normalizeQuote(packet);
      this.#quote = mergeTick(this.#quote, partial);
      if (
        hasBit(partial.presence_bits, BestBidOfferPresence.BID) ||
        hasBit(partial.presence_bits, BestBidOfferPresence.ASK)
      ) {
        this.emit("quote", this.#quote);
      }
      this.emit("status", this.status);
      return;
    }
    if (packet instanceof TimeBar) {
      const bar = normalizeBar(packet, { defaultPeriod: ONE_MINUTE_PERIOD });
      const now = Math.floor(Date.now() / 1000);
      const open1m = bucketOpen(now, ONE_MINUTE_PERIOD);
      const m = Number(bar.marker);

      if (m === open1m) {
        const next = mergeFormingFromTimeBar(this.#formingBar, bar, {
          periodSeconds: ONE_MINUTE_PERIOD,
        });
        if (next) {
          this.#formingBar = next;
          this.#bar = next;
          if (isUsablePrice(next.open)) this.#formingSeedOpen = next.open;
          this.emit("formingBar", this.#formingBar);
        }
        this.emit("status", this.status);
        return;
      }

      if (m === open1m - ONE_MINUTE_PERIOD) {
        bar.forming = false;
        this.#bar = bar;
        this.emit("bar", bar);
        this.#formingBar = null;
        this.#formingSeedOpen = null;
      }
      this.emit("status", this.status);
      return;
    }
    if (packet instanceof HighPriceLowPrice) {
      this.#latestHighLow = normalizeHighLow(packet);
      this.emit("latest_high_low", this.#latestHighLow);
      this.emit("status", this.status);
      return;
    }
    if (packet instanceof ClosePrice) {
      this.#latestClose = normalizeClosePrice(packet);
      this.emit("latest_close", this.#latestClose);
      this.emit("status", this.status);
      return;
    }
    this.emit("message", { plant, packet });
  }

  close() {
    this.#live = false;
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    this.#ticker?.close();
    this.#history?.close();
    this.#ticker = null;
    this.#history = null;
  }
}

/**
 * One-shot historical bar fetch (opens history plant, replays, closes).
 *
 * @param {object} options — connect fields + history query:
 *   `resolution`, `from`, `to`, `countback` (or legacy `barCount` / `start_index` / `finish_index`)
 * @param {boolean} [options.payload=false] Return `{ s, t, o, h, l, c, v }` instead of bar objects
 * @returns {Promise<object[]|{ s: string, t: number[], o: number[], h: number[], l: number[], c: number[], v: number[] }>}
 */
export async function fetchHistoryBars(options) {
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
    return await session.loadHistory({
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

/** Alias for `fetchHistoryBars` with `payload: true`. */
export async function fetchHistory(options) {
  return fetchHistoryBars({
    ...options,
    payload: true,
    compat: options?.compat ?? true,
  });
}

/**
 * One-shot tick bar replay (history plant, templates 206 → 207).
 *
 * @param {object} options — `ChartSession.open` fields + `loadTickHistory` options
 * @returns {Promise<object[]>}
 */
export async function fetchTickHistoryBars(options) {
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
    return await session.loadTickHistory({
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

/** Alias for `fetchTickHistoryBars` with `payload: true` (chart `{ s, t, o, h, l, c, v }`). */
export async function fetchTickHistory(options) {
  return fetchTickHistoryBars({
    ...options,
    payload: true,
    compat: options?.compat ?? false,
  });
}
