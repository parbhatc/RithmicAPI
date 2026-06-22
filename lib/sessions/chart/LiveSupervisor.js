import { MarketUpdatePreset } from "../../marketEnums.js";
import { isSessionLimitError, SessionBackoff } from "../../util/session-limit.js";
import { fmtWall } from "../../util/bar-format.js";

const WS_STATES = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];

function wsLabel(ws) {
  if (!ws) return "missing";
  return WS_STATES[ws.readyState] ?? String(ws.readyState);
}

function plantsOpen(chart) {
  return chart.tickerClient?.ws?.readyState === 1 && chart.historyClient?.ws?.readyState === 1;
}

function plantNeedsReconnect(client) {
  const rs = client?.ws?.readyState;
  return rs == null || rs === 2 || rs === 3;
}

async function waitPlantsOpen(chart, maxMs = 20_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (plantsOpen(chart)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * Keeps chart live pumps running: reconnect plants, session-limit backoff, health watch.
 */
export class LiveSupervisor {
  #chart;
  #log;
  #backoff = new SessionBackoff();
  #chain = Promise.resolve();
  #watch = null;
  #lastStallAt = 0;
  #lastReceiveErrLog = 0;
  #shuttingDown = false;
  #touchActivity;
  #watchMs;
  #liveStart;
  #resolveInstruments;

  constructor(chart, { log, touchActivity, watchMs = 10_000, liveStart, resolveInstruments } = {}) {
    this.#chart = chart;
    this.#log = log ?? (() => {});
    this.#touchActivity = touchActivity ?? (() => {});
    this.#watchMs = watchMs;
    this.#liveStart = liveStart;
    this.#resolveInstruments = resolveInstruments ?? null;
  }

  get shuttingDown() {
    return this.#shuttingDown;
  }

  wirePlants() {
    this.#wireClient("ticker", this.#chart.tickerClient);
    this.#wireClient("history", this.#chart.historyClient);
  }

  attachHandlers() {
    const chart = this.#chart;
    chart.on("liveStall", ({ plant, readyState }) => this.#onStall(plant, readyState));
    chart.on("sessionKicked", ({ plant }) => this.#onKicked(plant));
    chart.on("liveReceiveError", ({ plant, error }) => this.#onReceiveError(plant, error));
    chart.on("trade", () => this.#touchActivity());
    chart.on("quote", () => this.#touchActivity());
  }

  startWatch({ onStale } = {}) {
    this.#watch = setInterval(() => {
      if (this.#shuttingDown) return;
      const chart = this.#chart;
      const ticker = wsLabel(chart.tickerClient?.ws);
      const history = wsLabel(chart.historyClient?.ws);
      const pumpActive = chart.liveFeed?.live;

      if (ticker !== "OPEN" || history !== "OPEN" || !pumpActive) {
        this.#log(
          `WS status: ticker=${ticker} history=${history} livePump=${pumpActive ? "on" : "off"} @ ${fmtWall()}`,
        );
        if (!this.#backoff.active) {
          this.scheduleEnsure({ reason: "watch" });
        }
        return;
      }

      onStale?.();
    }, this.#watchMs);
    this.#watch.unref?.();
  }

  async start() {
    this.wirePlants();
    this.attachHandlers();
    await this.ensure();
  }

  scheduleEnsure({ delayMs = 0, reason = "" } = {}) {
    if (this.#shuttingDown) return this.#chain;
    this.#chain = this.#chain
      .then(async () => {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        await this.ensure(reason);
      })
      .catch((err) => {
        this.#log(`ensureLive chain failed: ${err?.message ?? err} @ ${fmtWall()}`);
      });
    return this.#chain;
  }

  async ensure(reason = "") {
    if (this.#shuttingDown) return;
    const chart = this.#chart;

    if (this.#backoff.active) {
      this.#log(
        `ensureLive skipped — session backoff until ${fmtWall(this.#backoff.until)}${reason ? ` (${reason})` : ""}`,
      );
      return;
    }

    const feed = chart.liveFeed;
    if (feed?.live && feed.pumps?.length >= 2 && plantsOpen(chart)) {
      return;
    }

    if (!plantsOpen(chart)) {
      const needsReconnect =
        plantNeedsReconnect(chart.tickerClient) || plantNeedsReconnect(chart.historyClient);
      if (needsReconnect) {
        try {
          this.#log(`reconnecting plants${reason ? ` (${reason})` : ""}`);
          await chart.reconnectDataPlants();
          this.wirePlants();
        } catch (err) {
          const line = `reconnect failed: ${err?.message ?? err}`;
          this.#log(line);
          if (isSessionLimitError(null, "", line)) this.#noteKick("reconnect");
        }
      }
      if (!plantsOpen(chart)) {
        const ready = await waitPlantsOpen(chart, 10_000);
        if (!ready) {
          this.#log(`ensureLive skipped — WS timeout${reason ? ` (${reason})` : ""}`);
          return;
        }
      }
    }

    try {
      if (feed?.live) await chart.planets.live.stop();
    } catch {
      /* ignore */
    }

    try {
      const base = this.#liveStart ?? { updateBits: MarketUpdatePreset.CHART };
      const instruments = this.#resolveInstruments?.() ?? base.instruments;
      await chart.planets.live.start({ ...base, instruments });
      this.#log(`live feed (re)started${reason ? ` (${reason})` : ""}`);
      this.#backoff.reset();
    } catch (err) {
      const line = `ensureLive failed: ${err?.message ?? err}`;
      this.#log(`${line} @ ${fmtWall()}`);
      if (isSessionLimitError(null, "", line)) this.#noteKick("ensureLive");
    }
  }

  async stop() {
    this.#shuttingDown = true;
    if (this.#watch) clearInterval(this.#watch);
    await this.#chain.catch(() => {});
    try {
      await this.#chart.planets?.live?.stop();
    } catch {
      /* ignore */
    }
  }

  async drainChain() {
    await this.#chain.catch(() => {});
  }

  #noteKick(source) {
    const backoff = this.#backoff.noteKick();
    this.#log(
      `Session limit (${source}) — Rithmic forced logout (account allows 1 plant session). ` +
        `Check for another chartLive process or Rithmic browser tab; wait ${backoff / 1000}s before retry. @ ${fmtWall()}`,
    );
  }

  #onStall(plant, readyState) {
    if (this.#shuttingDown) return;
    const now = Date.now();
    if (now - this.#lastStallAt < 2000) return;
    this.#lastStallAt = now;
    this.#log(
      `Live pump stopped (${plant}) ws=${WS_STATES[readyState] ?? readyState} @ ${fmtWall()}`,
    );
    const delay = this.#backoff.active ? this.#backoff.currentMs() : 500;
    this.scheduleEnsure({ delayMs: delay, reason: `stall:${plant}` });
  }

  #onKicked(plant) {
    if (this.#shuttingDown) return;
    this.#noteKick(`forced-logout:${plant}`);
    this.scheduleEnsure({ delayMs: this.#backoff.currentMs(), reason: "forced-logout" });
  }

  #onReceiveError(plant, error) {
    const now = Date.now();
    if (now - this.#lastReceiveErrLog < 15_000) return;
    this.#lastReceiveErrLog = now;
    this.#log(`Live receive error (${plant}): ${error?.message ?? error} @ ${fmtWall()}`);
  }

  #wireClient(name, client) {
    const ws = client?.ws;
    if (!ws || ws.__liveSupervisorWired) return;
    ws.__liveSupervisorWired = true;

    const onOpen = () => {
      this.#log(`WS connected (${name}): ${this.#chart.uri}`);
    };
    if (ws.readyState === 1) onOpen();
    else ws.once("open", onOpen);

    ws.on("close", (code, reason) => {
      const r = reason?.toString?.() || "";
      ws.__liveSupervisorWired = false;
      if (client._intentionalClose || this.#shuttingDown) {
        this.#log(`WS closed (${name}) code=${code} intentional`);
        return;
      }
      this.#log(`WS disconnected (${name}): code=${code}${r ? ` ${r}` : ""} @ ${fmtWall()}`);
      if (isSessionLimitError(code, r)) {
        this.#noteKick(`1011:${name}`);
        this.scheduleEnsure({ delayMs: this.#backoff.currentMs(), reason: "session-limit" });
        return;
      }
      this.scheduleEnsure({ delayMs: 1500, reason: `ws-close:${name}` });
    });

    ws.on("error", (err) => {
      this.#log(`WS error (${name}): ${err?.message ?? err} @ ${fmtWall()}`);
    });
  }
}
