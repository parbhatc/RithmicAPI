import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { ChartSession } from "../sessions/chart/ChartSession.js";
import { LiveSupervisor } from "../sessions/chart/LiveSupervisor.js";
import { WireSnifferLog } from "../util/wire-sniffer-log.js";
import { fmtBarTime, fmtOhlc, fmtOhlcChange, fmtWall } from "../util/bar-format.js";
import { FormingBarManager } from "./forming-bar-manager.js";
import { wrapChartSession } from "./chart-session-adapter.js";
import { bootstrapRithmicAccuracy } from "./rithmic-accuracy.js";
import { bucketOpen } from "./forming-bar.js";
import { ONE_MINUTE_PERIOD } from "./candle-layer.js";

function envMs(name, fallback) {
  const v = process.env[name];
  return v != null && v !== "" ? Number(v) : fallback;
}

function envFlag(name) {
  return process.env[name] === "1";
}

/**
 * High-level live 1m forming-bar session: bootstrap, reconnect, rollover, logging.
 *
 * Events:
 * - `latest` — `{ bar }` last closed bar from bootstrap
 * - `bar` — `{ bar, marker }` Rithmic TimeBar closed (marker = bucket open sec)
 * - `new_bar` — `{ bar }` new forming minute bucket
 * - `live` — `{ bar }` forming bar tick update (same bucket)
 * - `closed` — `{ bar, source, marker }` bar closed on rollover (`forming` | `timebar`)
 * - `line` — status / log text (when logDir is set or via internal messages)
 */
export class ChartLive extends EventEmitter {
  #chart;
  #mgr;
  #supervisor;
  #logStream = null;
  #wsLogStream = null;
  #lastLiveSig = null;
  #lastLiveBucket = null;
  #lastTimeBarMarker = 0;
  #lastStaleLogAt = 0;
  #refreshInflight = false;
  #lastPacketAt = Date.now();
  #resolution;
  #compat;
  #runSeconds;
  #logDir;
  #staleMs;

  constructor(chart, mgr, supervisor, options) {
    super();
    this.#chart = chart;
    this.#mgr = mgr;
    this.#supervisor = supervisor;
    this.#resolution = options.resolution ?? 1;
    this.#compat = options.compat ?? false;
    this.#runSeconds = options.runSeconds ?? 0;
    this.#logDir = options.logDir ?? null;
    this.#staleMs = options.staleMs ?? 45_000;
  }

  get chart() {
    return this.#chart;
  }

  get manager() {
    return this.#mgr;
  }

  static async open({
    logDir,
    compat = Boolean(process.env.TRADESEA_ACCESS_TOKEN),
    resolution = 1,
    runSeconds = envMs("RITHMIC_LIVE_SECONDS", 0),
    staleMs = envMs("RITHMIC_STALE_MS", 45_000),
    watchMs = envMs("RITHMIC_WATCH_MS", 10_000),
    wireVerbose = envFlag("RITHMIC_WIRE_VERBOSE"),
    wireMarket = envFlag("RITHMIC_WIRE_MARKET"),
    formingDebug = envFlag("FORMING_1M_DEBUG"),
    wireSniffer: wireSnifferIn,
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
      ...connectOpts,
    });

    const live = new ChartLive(chart, null, null, {
      resolution,
      compat,
      runSeconds,
      logDir,
      staleMs,
    });
    live.#logStream = logStream;
    live.#wsLogStream = wsLogStream;

    const log = (line) => live.#emitLine(line);
    live.#mgr = new FormingBarManager(wrapChartSession(chart));

    const supervisor = new LiveSupervisor(chart, {
      log,
      watchMs,
      touchActivity: () => {
        live.#lastPacketAt = Date.now();
      },
    });
    live.#supervisor = supervisor;

    if (logStream) {
      live.#wireFormingDebug(logStream);
      log(`Logging to ${path.relative(process.cwd(), path.join(logDir, "chartLive.txt"))}`);
      log(
        `Wire log: ${path.relative(process.cwd(), path.join(logDir, "chartLive-ws.txt"))} verbose=${wireVerbose} market=${wireMarket}`,
      );
    }

    return live;
  }

  async bootstrap() {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.#log("bootstrap 1m start");
        if (this.#compat) {
          this.#log("bootstrap rithmic accuracy (compat)");
          await bootstrapRithmicAccuracy(this.#mgr, {
            resolutions: [this.#resolution],
            skipAttachLive: true,
            prefetchQuote: false,
          });
        } else {
          this.#log("bootstrap 1m shared");
          await this.#mgr.bootstrap({ resolutions: [this.#resolution] });
        }
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

  async start() {
    await this.bootstrap();

    const forming = this.#mgr.getForming(this.#resolution);
    this.#log(
      `bootstrap done closed=${this.#mgr.closed1m?.length ?? 0} forming=${forming ? fmtBarTime(forming.marker) : "none"}`,
    );

    const symbol = this.#chart.symbol ?? "?";
    this.#log(
      `Symbol: ${symbol}  Timeframe: ${this.#resolution} min  Compat: ${this.#compat ? "Enabled" : "Disabled"}`,
    );
    this.#logFile(`=== session ${new Date().toISOString()} ${symbol} ===`);

    const closed = this.#mgr.closed1m?.at(-1);
    if (closed) {
      this.emit("latest", { bar: { ...closed } });
      this.#log(`Latest candle: @ ${fmtBarTime(closed.marker)} ${fmtOhlc(closed)}`);
    }

    this.#mgr.on("formingBar", ({ bar }) => this.#onFormingBar(bar));
    this.#chart.on("bar", (tb) => this.#onTimeBar(tb));

    await this.#supervisor.start();
    this.#log("live feed started (CHART preset)");
    await this.#mgr.attachLive({ skipStartLive: true });
    this.#mgr.syncFromLastTrade();
    this.#emitForming(this.#mgr.getForming(this.#resolution));

    this.#supervisor.startWatch({
      onStale: () => this.#onWatchStale(),
    });
  }

  async run() {
    await this.start();
    const msg =
      this.#runSeconds > 0
        ? `Streaming for ${this.#runSeconds}s (Ctrl+C to stop early)…`
        : "Streaming until Ctrl+C…";
    this.#log(msg);

    await new Promise((resolve) => {
      if (this.#runSeconds > 0) setTimeout(resolve, this.#runSeconds * 1000);
      process.once("SIGINT", resolve);
    });
  }

  async close() {
    await this.#supervisor.stop();
    this.#log("shutdown: stopping live feed and logging out plants…");
    try {
      await this.#mgr.detachLive();
    } catch {
      /* ignore */
    }
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

  #currentBucket() {
    return bucketOpen(Math.floor(Date.now() / 1000), ONE_MINUTE_PERIOD);
  }

  #onFormingBar(bar) {
    this.#lastPacketAt = Date.now();
    this.#emitForming(bar);
  }

  #emitForming(bar) {
    if (!bar?.forming) return;
    if (Number(bar.marker) < this.#currentBucket()) return;

    const sig = `${bar.marker}:${bar.open}:${bar.high}:${bar.low}:${bar.close}`;
    if (sig === this.#lastLiveSig) return;

    const bucket = Number(bar.marker);
    if (bucket !== this.#lastLiveBucket) {
      this.#lastLiveBucket = bucket;
      this.#lastLiveSig = sig;
      const payload = { bar: { ...bar } };
      this.emit("new_bar", payload);
      this.#log(`New Bar: @ ${fmtBarTime(bar.marker)} ${fmtOhlc(bar)}`);
      return;
    }

    this.#lastLiveSig = sig;
    const payload = { bar: { ...bar } };
    this.emit("live", payload);
    this.#log(`Live: @ ${fmtBarTime(bar.marker)} ${fmtOhlcChange(bar)}`);
  }

  #emitClosed(bar, source, marker) {
    if (!bar) return;
    const openSec = marker ?? Number(bar.marker);
    this.emit("closed", { bar: { ...bar }, source, marker: openSec });
    this.#log(`Closed (${source}): @ ${fmtBarTime(openSec)} ${fmtOhlc(bar)}`);
  }

  #onTimeBar(tb) {
    this.#lastPacketAt = Date.now();
    const endMarker = Number(tb.marker);
    if (!endMarker || endMarker === this.#lastTimeBarMarker) return;
    this.#lastTimeBarMarker = endMarker;
    const marker = endMarker - ONE_MINUTE_PERIOD;
    this.emit("bar", { bar: { ...tb }, marker, endMarker });
    this.#log(`timebar close marker=${fmtBarTime(marker)} ${fmtOhlc(tb)}`);
    void this.#roll(endMarker, tb);
  }

  async #roll(endMarker, timebar) {
    if (this.#refreshInflight) return;
    this.#refreshInflight = true;
    const bucketOpenSec = endMarker - ONE_MINUTE_PERIOD;

    try {
      const formingClosed = this.#mgr.getForming(this.#resolution);
      if (formingClosed && Number(formingClosed.marker) === bucketOpenSec) {
        this.#emitClosed(formingClosed, "forming", bucketOpenSec);
      }
      this.#lastLiveSig = null;
      await Promise.race([
        this.#mgr.refreshCurrent1m(Math.floor(Date.now() / 1000), 8000, {
          closedBucketOpen: bucketOpenSec,
          rollover: true,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("refresh timeout")), 12_000),
        ),
      ]);
    } catch (err) {
      this.#log(`Roll refresh failed: ${err?.message ?? err} @ ${fmtWall()}`);
    } finally {
      this.#chart.liveFeed?.resumeHistoryPump();
      this.#refreshInflight = false;
    }

    await this.#supervisor.ensure();
    this.#mgr.syncFromLastTrade();
    this.#emitForming(this.#mgr.getForming(this.#resolution));
  }

  #onWatchStale() {
    const now = Date.now();
    const staleSec = (now - this.#lastPacketAt) / 1000;

    if (staleSec * 1000 >= this.#staleMs && now - this.#lastStaleLogAt >= this.#staleMs) {
      this.#lastStaleLogAt = now;
      this.#log(`No market data for ${staleSec.toFixed(0)}s @ ${fmtWall()}`);
      this.#mgr.syncFromLastTrade();
      this.#emitForming(this.#mgr.getForming(this.#resolution));
    }

    const nowSec = Math.floor(now / 1000);
    const curBucket = bucketOpen(nowSec, ONE_MINUTE_PERIOD);
    const forming = this.#mgr.getForming(this.#resolution);
    const formingBucket = forming ? Number(forming.marker) : null;

    if (
      formingBucket != null &&
      formingBucket < curBucket &&
      !this.#refreshInflight &&
      nowSec >= curBucket + 3
    ) {
      this.#log(
        `Minute rolled without TimeBar (${fmtBarTime(formingBucket)} → ${fmtBarTime(curBucket)}) @ ${fmtWall()}`,
      );
      const endMarker = formingBucket + ONE_MINUTE_PERIOD;
      if (endMarker > this.#lastTimeBarMarker) this.#lastTimeBarMarker = endMarker;
      void this.#roll(endMarker, null);
    }
  }

  #emitLine(line) {
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
