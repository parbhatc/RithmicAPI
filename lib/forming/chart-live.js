import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { ChartSession } from "../sessions/chart/ChartSession.js";
import { LiveSupervisor } from "../sessions/chart/LiveSupervisor.js";
import { WireSnifferLog } from "../util/wire-sniffer-log.js";
import { HistoryQuery } from "../HistoryQuery.js";
import { BarType, MarketUpdatePreset } from "../marketEnums.js";
import { fmtBarTime, fmtOhlc, fmtOhlcChange, fmtWall } from "../util/bar-format.js";
import { FormingBarManager } from "./forming-bar-manager.js";
import { wrapChartSessionForInstrument } from "./chart-session-adapter.js";
import { bucketOpen } from "./forming-bar.js";
import { ONE_MINUTE_PERIOD } from "./candle-layer.js";

function envMs(name, fallback) {
  const v = process.env[name];
  return v != null && v !== "" ? Number(v) : fallback;
}

function envFlag(name) {
  return process.env[name] === "1";
}

function feedLabel({ symbol, exchange, resolution }) {
  return `${symbol}@${exchange} ${resolution}`;
}

function streamKey(symbol, exchange) {
  return `${symbol}.${exchange}`;
}

/**
 * Live forming-bar session: connect once, then {@link subscribe} per symbol.
 *
 * Events (`latest`, `bar`, `new_bar`, `live`, `closed`, `timeframe_change`, `line`) include
 * `label`, `symbol`, `exchange`, and `resolution` on each payload.
 */
export class ChartLive extends EventEmitter {
  #chart;
  #streams = [];
  #supervisor;
  #logStream = null;
  #wsLogStream = null;
  #lastPacketAt = Date.now();
  #runSeconds;
  #logDir;
  #staleMs;
  #compat;
  #started = false;
  #closing = false;
  #stopping = false;
  #onBar = null;

  constructor(chart, supervisor, options) {
    super();
    this.#chart = chart;
    this.#supervisor = supervisor;
    this.#runSeconds = options.runSeconds ?? 0;
    this.#logDir = options.logDir ?? null;
    this.#staleMs = options.staleMs ?? 45_000;
    this.#compat = options.compat ?? false;
  }

  get chart() {
    return this.#chart;
  }

  /** First subscribed stream's forming manager (convenience for single-symbol use). */
  get manager() {
    return this.#streams[0]?.mgr ?? null;
  }

  get streams() {
    return this.#streams.map((s) => ({
      label: s.label,
      symbol: s.symbol,
      exchange: s.exchange,
      resolution: s.resolution,
      manager: s.mgr,
    }));
  }

  static async open({
    logDir,
    compat = Boolean(process.env.TRADESEA_ACCESS_TOKEN),
    runSeconds = envMs("RITHMIC_LIVE_SECONDS", 0),
    staleMs = envMs("RITHMIC_STALE_MS", 45_000),
    watchMs = envMs("RITHMIC_WATCH_MS", 10_000),
    wireVerbose = envFlag("RITHMIC_WIRE_VERBOSE"),
    wireMarket = envFlag("RITHMIC_WIRE_MARKET"),
    formingDebug = envFlag("FORMING_1M_DEBUG"),
    wireSniffer: wireSnifferIn,
    symbol,
    exchange,
    ...connectOpts
  } = {}) {
    if (formingDebug) process.env.FORMING_1M_DEBUG = "1";

    let wireSniffer = wireSnifferIn ?? null;
    let logStream = null;
    let wsLogStream = null;

    if (logDir) {
      fs.mkdirSync(logDir, { recursive: true });
      logStream = fs.createWriteStream(path.join(logDir, "chartLive.txt"), { flags: "w" });
      wsLogStream = fs.createWriteStream(path.join(logDir, "chartLive-ws.txt"), { flags: "w" });
      wireSniffer ??= new WireSnifferLog(wsLogStream, {
        verbose: wireVerbose,
        verboseMarket: wireMarket,
      });
      wireSniffer.header({ app: "chartLive" });
    }

    const chart = await ChartSession.open({
      plants: { ticker: true, history: true, order: false, pnl: false },
      wireSniffer,
      symbol,
      exchange,
      ...connectOpts,
    });

    const live = new ChartLive(chart, null, { runSeconds, logDir, staleMs, compat });
    live.#logStream = logStream;
    live.#wsLogStream = wsLogStream;

    const log = (line) => live.#emitLine(line);

    live.#supervisor = new LiveSupervisor(chart, {
      log,
      watchMs,
      touchActivity: () => {
        live.#lastPacketAt = Date.now();
      },
      liveStart: {
        updateBits: MarketUpdatePreset.CHART,
        instruments: [],
      },
      resolveInstruments: () => live.#liveInstruments(),
    });

    if (logStream) {
      live.#wireFormingDebug(logStream);
      log(`Logging to ${path.relative(process.cwd(), path.join(logDir, "chartLive.txt"))}`);
      log(
        `Wire log: ${path.relative(process.cwd(), path.join(logDir, "chartLive-ws.txt"))} verbose=${wireVerbose} market=${wireMarket}`,
      );
    }

    return live;
  }

  #liveInstruments() {
    return this.#streams.map((stream) => ({
      symbol: stream.symbol,
      exchange: stream.exchange,
      barType: stream.barType,
      barPeriod: stream.barTypePeriod,
      periodSeconds: stream.periodSeconds,
    }));
  }

  #createStream({ symbol, exchange, resolution, forming }) {
    const { barType, barTypePeriod, periodSeconds } = HistoryQuery.parseResolution(resolution);
    const session = wrapChartSessionForInstrument(this.#chart, { symbol, exchange });
    const mgr = new FormingBarManager(session);
    const stream = {
      label: feedLabel({ symbol, exchange, resolution }),
      symbol,
      exchange,
      resolution,
      barType,
      barTypePeriod,
      periodSeconds,
      compat: this.#compat,
      forming,
      mgr,
      lastLiveSig: null,
      lastLiveBucket: null,
      lastTimeBarMarker: 0,
      refreshInflight: false,
      lastStaleLogAt: 0,
      onFormingBar: null,
    };
    stream.emitPayload = (extra) => ({
      label: stream.label,
      symbol: stream.symbol,
      exchange: stream.exchange,
      resolution: stream.resolution,
      ...extra,
    });
    return stream;
  }

  async #bootstrapStream(stream) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (!stream.forming) return;
        this.#log(`bootstrap ${stream.label} start`);
        if (stream.compat) {
          this.#log(`bootstrap ${stream.label} rithmic accuracy (compat)`);
          const { bootstrapRithmicAccuracy } = await import(
            "../../testing/tradesea/rithmic-accuracy.js"
          );
          await bootstrapRithmicAccuracy(stream.mgr, {
            resolutions: [stream.resolution],
            skipAttachLive: true,
            prefetchQuote: false,
          });
        } else {
          await stream.mgr.bootstrap({ resolutions: [stream.resolution] });
        }
        const forming = stream.mgr.getForming(stream.resolution);
        this.#log(
          `bootstrap ${stream.label} done closed=${stream.mgr.closed1m?.length ?? 0} forming=${forming ? fmtBarTime(forming.marker) : "none"}`,
        );
        return;
      } catch (err) {
        const msg = String(err?.message ?? err);
        const recoverable = /not connected|permission denied|\b1011\b/.test(msg);
        if (!recoverable || attempt === maxAttempts) throw err;
        this.#log(`bootstrap failed (${msg}) — reconnect ${attempt + 1}/${maxAttempts}`);
        await this.#chart.reconnectDataPlants();
        this.#supervisor.wirePlants();
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }

  async #attachForming(stream) {
    if (!stream.forming) return;
    stream.onFormingBar = ({ bar }) => this.#onFormingBar(stream, bar);
    stream.mgr.on("formingBar", stream.onFormingBar);
    await stream.mgr.attachLive({ skipStartLive: true });
    stream.mgr.syncFromLastTrade();
    const closed = stream.mgr.closed1m?.at(-1);
    if (closed) {
      this.#safeEmit("latest", stream.emitPayload({ bar: { ...closed } }));
    }
    this.#emitForming(stream, stream.mgr.getForming(stream.resolution));
  }

  async #detachForming(stream) {
    if (stream.onFormingBar) {
      stream.mgr.off("formingBar", stream.onFormingBar);
      stream.onFormingBar = null;
    }
    if (stream.forming) {
      await stream.mgr.detachLive();
    }
  }

  async #ensureStarted() {
    if (this.#started || this.#closing) return;

    this.#onBar ??= (tb) => {
      if (this.#closing) return;
      for (const stream of this.#streams) {
        this.#onTimeBar(stream, tb);
      }
    };
    this.#chart.on("bar", this.#onBar);

    await this.#supervisor.start();
    this.#started = true;
    this.#log("live feed started (CHART preset)");
    this.#logFile(`=== session ${new Date().toISOString()} ===`);

    this.#supervisor.startWatch({
      onStale: () => this.#onWatchStale(),
    });
  }

  /**
   * Subscribe to live bars for a symbol.
   * @param {string} symbol
   * @param {string} exchange
   * @param {number|string} resolution e.g. `1`, `"30S"`
   * @param {boolean} [forming=true]
   */
  async subscribe(symbol, exchange, resolution, forming = true) {
    if (this.#closing) throw new Error("session is closing");
    const key = streamKey(symbol, exchange);
    if (this.#streams.some((s) => s.symbol === symbol && s.exchange === exchange)) {
      throw new Error(`already subscribed: ${key}`);
    }

    const isFirst = this.#streams.length === 0;
    const stream = this.#createStream({ symbol, exchange, resolution, forming });
    this.#streams.push(stream);

    await this.#bootstrapStream(stream);
    await this.#attachForming(stream);
    await this.#ensureStarted();

    const feed = this.#chart.liveFeed;
    if (!isFirst && feed.live) {
      await feed.subscribeInstrument(
        this.#chart,
        this.#chart.ctx(),
        {
          symbol,
          exchange,
          barType: stream.barType,
          barPeriod: stream.barTypePeriod,
          periodSeconds: stream.periodSeconds,
        },
        {
          updateBits: MarketUpdatePreset.CHART,
          subscribeUnderlying: this.#streams.length > 1,
        },
      );
    }

    const feedSummary = this.#streams
      .map((s) => `${s.label}${s.forming ? "" : " (forming off)"}`)
      .join("  ");
    this.#log(`Feeds: ${feedSummary}`);
    return stream;
  }

  /** Unsubscribe from a symbol and stop its forming bar stream. */
  async unsubscribe(symbol, exchange) {
    const idx = this.#streams.findIndex(
      (s) => s.symbol === symbol && s.exchange === exchange,
    );
    if (idx < 0) {
      throw new Error(`not subscribed: ${streamKey(symbol, exchange)}`);
    }

    const stream = this.#streams[idx];
    await this.#detachForming(stream);

    const feed = this.#chart.liveFeed;
    if (feed.live) {
      await feed.unsubscribeInstrument(this.#chart, this.#chart.ctx(), {
        symbol,
        exchange,
        barType: stream.barType,
        barPeriod: stream.barTypePeriod,
      });
    }

    this.#streams.splice(idx, 1);
    this.#log(`unsubscribed ${stream.label}`);
  }

  /**
   * Switch a subscribed symbol to a new resolution (Rithmic Trader Pro pattern:
   * UNSUBSCRIBE old time bar → history replay/bootstrap → SUBSCRIBE new time bar).
   * Market-data subscription is unchanged.
   *
   * @param {string} symbol
   * @param {string} exchange
   * @param {number|string} resolution e.g. `1`, `"30S"`, `"3S"`
   * @param {boolean} [forming] defaults to the stream's current forming flag
   */
  async changeTimeFrame(symbol, exchange, resolution, forming) {
    if (this.#closing) throw new Error("session is closing");

    const stream = this.#streams.find(
      (s) => s.symbol === symbol && s.exchange === exchange,
    );
    if (!stream) {
      throw new Error(`not subscribed: ${streamKey(symbol, exchange)}`);
    }

    const prevResolution = stream.resolution;
    if (String(prevResolution) === String(resolution)) {
      return stream;
    }

    const previous = {
      barType: stream.barType,
      barPeriod: stream.barTypePeriod,
      periodSeconds: stream.periodSeconds,
      resolution: prevResolution,
    };

    const { barType, barTypePeriod, periodSeconds } = HistoryQuery.parseResolution(resolution);
    const formingOn = forming ?? stream.forming;

    this.#log(
      `timeframe ${stream.label}: ${prevResolution} → ${resolution} (bootstrap + resubscribe)`,
    );

    const feed = this.#chart.liveFeed;
    const ctx = this.#chart.ctx();

    if (feed.live) {
      await feed.runWireTask(ctx, () =>
        feed.unsubscribeTimeBar(ctx, {
          symbol,
          exchange,
          barType: previous.barType,
          barPeriod: previous.barPeriod,
        }),
      );
    }

    stream.resolution = resolution;
    stream.barType = barType;
    stream.barTypePeriod = barTypePeriod;
    stream.periodSeconds = periodSeconds;
    stream.label = feedLabel({ symbol, exchange, resolution });
    stream.forming = formingOn;
    stream.lastLiveSig = null;
    stream.lastLiveBucket = null;
    stream.lastTimeBarMarker = 0;
    stream.refreshInflight = false;

    if (formingOn) {
      await this.#bootstrapStream(stream);
      stream.mgr.syncFromLastTrade();
    }

    if (feed.live) {
      await feed.runWireTask(ctx, () =>
        feed.subscribeTimeBar(ctx, {
          symbol,
          exchange,
          barType,
          barPeriod: barTypePeriod,
          periodSeconds,
        }),
      );
    }

    const formingBar = formingOn ? stream.mgr.getForming(resolution) : null;
    const payload = stream.emitPayload({
      previousResolution: prevResolution,
      resolution,
      forming: formingOn,
      bar: formingBar ? { ...formingBar } : undefined,
    });
    this.#safeEmit("timeframe_change", payload);

    if (formingBar) {
      this.#emitForming(stream, formingBar);
    }

    const feedSummary = this.#streams
      .map((s) => `${s.label}${s.forming ? "" : " (forming off)"}`)
      .join("  ");
    this.#log(`Feeds: ${feedSummary}`);

    return stream;
  }

  async start() {
    await this.#ensureStarted();
  }

  async run() {
    if (this.#streams.length === 0) {
      throw new Error("subscribe to at least one symbol before run()");
    }
    await this.#ensureStarted();

    const msg =
      this.#runSeconds > 0
        ? `Streaming for ${this.#runSeconds}s (Ctrl+C to stop)…`
        : "Streaming until Ctrl+C…";
    this.#log(msg);

    await new Promise((resolve) => {
      let timer = null;
      const done = () => {
        if (timer) clearTimeout(timer);
        process.removeListener("SIGINT", onStop);
        process.removeListener("SIGTERM", onStop);
        resolve();
      };
      const onStop = () => {
        this.#closing = true;
        void this.#stopFeeds().then(done);
      };
      process.once("SIGINT", onStop);
      process.once("SIGTERM", onStop);
      if (this.#runSeconds > 0) timer = setTimeout(onStop, this.#runSeconds * 1000);
    });
  }

  async #stopFeeds() {
    if (this.#stopping) return;
    this.#stopping = true;
    await this.#supervisor?.stop();
  }

  async close() {
    this.#closing = true;
    await this.#stopFeeds();

    if (this.#onBar) {
      this.#chart.off("bar", this.#onBar);
      this.#onBar = null;
    }

    this.#log("shutdown: stopping live feed and logging out plants…");
    for (const stream of [...this.#streams]) {
      try {
        await this.#detachForming(stream);
      } catch {
        /* ignore */
      }
    }
    this.#streams = [];

    await this.#chart.close();
    this.#log("shutdown: all plants logged out");

    await new Promise((resolve) => {
      if (!this.#logStream) {
        this.#wsLogStream?.end(resolve);
        return;
      }
      this.#logStream.end(() => {
        this.#wsLogStream?.end(resolve);
      });
    });

    if (this.#logDir) {
      this.#emitLine(`Stopped. Logs in ${path.relative(process.cwd(), this.#logDir)}`);
    }
  }

  #currentBucket(periodSeconds) {
    return bucketOpen(Math.floor(Date.now() / 1000), periodSeconds);
  }

  #safeEmit(event, payload) {
    if (this.#closing) return;
    this.emit(event, payload);
  }

  #onFormingBar(stream, bar) {
    if (this.#closing) return;
    this.#lastPacketAt = Date.now();
    this.#emitForming(stream, bar);
  }

  #emitForming(stream, bar) {
    if (this.#closing || !bar?.forming) return;
    if (Number(bar.marker) < this.#currentBucket(stream.periodSeconds)) return;

    const sig = `${bar.marker}:${bar.open}:${bar.high}:${bar.low}:${bar.close}`;
    if (sig === stream.lastLiveSig) return;

    const bucket = Number(bar.marker);
    if (bucket !== stream.lastLiveBucket) {
      stream.lastLiveBucket = bucket;
      stream.lastLiveSig = sig;
      const payload = stream.emitPayload({ bar: { ...bar } });
      this.#safeEmit("new_bar", payload);
      this.#log(`${stream.label} New Bar: @ ${fmtBarTime(bar.marker)} ${fmtOhlc(bar)}`);
      return;
    }

    stream.lastLiveSig = sig;
    const payload = stream.emitPayload({ bar: { ...bar } });
    this.#safeEmit("live", payload);
    this.#log(`${stream.label} Live: @ ${fmtBarTime(bar.marker)} ${fmtOhlcChange(bar)}`);
  }

  #emitClosed(stream, bar, source, marker) {
    if (this.#closing || !bar) return;
    const openSec = marker ?? Number(bar.marker);
    this.#safeEmit("closed", stream.emitPayload({ bar: { ...bar }, source, marker: openSec }));
    this.#log(
      `${stream.label} Closed (${source}): @ ${fmtBarTime(openSec)} ${fmtOhlc(bar)}`,
    );
  }

  #matchesTimeBar(stream, tb) {
    if (tb.symbol !== stream.symbol || tb.exchange !== stream.exchange) return false;

    const rawType = tb.bar_type ?? tb.type;
    if (rawType != null) {
      const typeName =
        typeof rawType === "number"
          ? rawType === BarType.SECOND_BAR
            ? "SECOND_BAR"
            : rawType === BarType.MINUTE_BAR
              ? "MINUTE_BAR"
              : String(rawType)
          : String(rawType).toUpperCase();
      const expected =
        stream.barType === BarType.SECOND_BAR ? "SECOND_BAR" : "MINUTE_BAR";
      if (typeName !== expected) return false;
    }

    const barPeriod = Number(tb.period);
    return !Number.isFinite(barPeriod) || barPeriod === stream.periodSeconds;
  }

  #onTimeBar(stream, tb) {
    if (this.#closing || !this.#matchesTimeBar(stream, tb)) return;

    this.#lastPacketAt = Date.now();
    const endMarker = Number(tb.marker);
    if (!endMarker || endMarker === stream.lastTimeBarMarker) return;
    stream.lastTimeBarMarker = endMarker;
    const marker = endMarker - stream.periodSeconds;
    this.#safeEmit("bar", stream.emitPayload({ bar: { ...tb }, marker, endMarker }));
    this.#log(
      `${stream.label} timebar close marker=${fmtBarTime(marker)} ${fmtOhlc(tb)}`,
    );
    if (stream.forming && stream.periodSeconds === ONE_MINUTE_PERIOD) {
      void this.#roll1m(stream, endMarker);
    } else if (stream.forming) {
      const formingClosed = stream.mgr.getForming(stream.resolution);
      if (formingClosed && Number(formingClosed.marker) === marker) {
        this.#emitClosed(stream, formingClosed, "forming", marker);
      }
      stream.lastLiveSig = null;
      stream.mgr.syncFromLastTrade();
      this.#emitForming(stream, stream.mgr.getForming(stream.resolution));
    }
  }

  async #roll1m(stream, endMarker) {
    if (this.#closing || stream.refreshInflight) return;
    stream.refreshInflight = true;
    const bucketOpenSec = endMarker - ONE_MINUTE_PERIOD;

    try {
      const formingClosed = stream.mgr.getForming(stream.resolution);
      if (formingClosed && Number(formingClosed.marker) === bucketOpenSec) {
        this.#emitClosed(stream, formingClosed, "forming", bucketOpenSec);
      }
      stream.lastLiveSig = null;
      await Promise.race([
        stream.mgr.refreshCurrent1m(Math.floor(Date.now() / 1000), 8000, {
          closedBucketOpen: bucketOpenSec,
          rollover: true,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("refresh timeout")), 12_000),
        ),
      ]);
    } catch (err) {
      this.#log(
        `${stream.label} Roll refresh failed: ${err?.message ?? err} @ ${fmtWall()}`,
      );
    } finally {
      this.#chart.liveFeed?.resumeHistoryPump();
      stream.refreshInflight = false;
    }

    if (this.#closing) return;
    await this.#supervisor.ensure();
    stream.mgr.syncFromLastTrade();
    this.#emitForming(stream, stream.mgr.getForming(stream.resolution));
  }

  #onWatchStale() {
    if (this.#closing) return;
    const now = Date.now();
    const staleSec = (now - this.#lastPacketAt) / 1000;

    if (staleSec * 1000 >= this.#staleMs) {
      for (const stream of this.#streams) {
        if (!stream.forming) continue;
        if (now - stream.lastStaleLogAt < this.#staleMs) continue;
        stream.lastStaleLogAt = now;
        this.#log(
          `${stream.label} No market data for ${staleSec.toFixed(0)}s @ ${fmtWall()}`,
        );
        stream.mgr.syncFromLastTrade();
        this.#emitForming(stream, stream.mgr.getForming(stream.resolution));
      }
    }

    const nowSec = Math.floor(now / 1000);
    for (const stream of this.#streams) {
      if (!stream.forming || stream.periodSeconds !== ONE_MINUTE_PERIOD) continue;
      const curBucket = bucketOpen(nowSec, ONE_MINUTE_PERIOD);
      const forming = stream.mgr.getForming(stream.resolution);
      const formingBucket = forming ? Number(forming.marker) : null;

      if (
        formingBucket != null &&
        formingBucket < curBucket &&
        !stream.refreshInflight &&
        nowSec >= curBucket + 3
      ) {
        this.#log(
          `${stream.label} Minute rolled without TimeBar (${fmtBarTime(formingBucket)} → ${fmtBarTime(curBucket)}) @ ${fmtWall()}`,
        );
        const endMarker = formingBucket + ONE_MINUTE_PERIOD;
        if (endMarker > stream.lastTimeBarMarker) stream.lastTimeBarMarker = endMarker;
        void this.#roll1m(stream, endMarker);
      }
    }
  }

  #emitLine(line) {
    if (this.#closing && !/^shutdown|Stopped/.test(line)) return;
    this.emit("line", line);
    this.#logFile(`[${fmtWall()}] ${line}`);
  }

  #log(line) {
    this.#emitLine(line);
  }

  #logFile(line) {
    this.#logStream?.write(`${line}\n`);
  }

  #wireFormingDebug(logStream) {
    const orig = console.log.bind(console);
    let auditBlock = false;
    console.log = (...args) => {
      const line = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
      if (line.includes("[1m-forming]") || line.includes("[1m-open-audit]")) {
        auditBlock = line.includes("[1m-open-audit]");
        logStream.write(`[${fmtWall()}] ${line}\n`);
        return;
      }
      if (line.includes("bucket=") && line.includes("forming=")) {
        logStream.write(`[${fmtWall()}] ${line.trim()}\n`);
        return;
      }
      if (auditBlock && /^\s{2,}/.test(line)) {
        logStream.write(`[${fmtWall()}] ${line}\n`);
        return;
      }
      auditBlock = false;
      orig(...args);
    };
  }
}
