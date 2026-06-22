import { toPlain } from "../util.js";

const SESSION_PACKETS = new Set([
  "RequestLogin",
  "ResponseLogin",
  "RequestLoginInfo",
  "ResponseLoginInfo",
  "RequestLogout",
  "ResponseLogout",
  "ForcedLogout",
  "Reject",
  "RequestRithmicSystemInfo",
  "ResponseRithmicSystemInfo",
  "RequestRithmicSystemGatewayInfo",
  "ResponseRithmicSystemGatewayInfo",
  "RequestMarketDataUpdate",
  "ResponseMarketDataUpdate",
  "RequestSubscribeForUnderlying",
  "ResponseMarketDataSubscribe",
  "RequestReferenceData",
  "ResponseReferenceData",
  "RequestTimeBarUpdate",
  "ResponseTimeBarUpdate",
  "RequestTimeBarReplay",
  "ResponseTimeBarReplay",
  "RequestTickBarReplay",
  "ResponseTickBarReplay",
  "TimeBar",
]);

const QUIET_PACKETS = new Set([
  "LastTrade",
  "BestBidOffer",
  "HighPriceLowPrice",
  "ClosePrice",
  "OrderBook",
  "MarketMode",
  "RequestHeartbeat",
  "ResponseHeartbeat",
]);

function rpCodeError(rpCode) {
  if (rpCode == null) return false;
  if (Array.isArray(rpCode)) return rpCode.length > 0 && rpCode[0] !== "0" && rpCode[0] !== 0;
  return rpCode !== "0" && rpCode !== 0;
}

function redactFields(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = { ...obj };
  if ("password" in out) out.password = "***";
  return out;
}

/**
 * Sniffer-compatible wire log (matches extension export format).
 * Writes to a stream; use with chartLive for side-by-side comparison with browser sniffer.
 */
export class WireSnifferLog {
  #stream;
  #verbose;
  #verboseMarket;
  #maxLines;
  #count = 0;
  #truncated = false;

  constructor(stream, { verbose = false, verboseMarket = false, maxLines = 50_000 } = {}) {
    this.#stream = stream;
    this.#verbose = verbose;
    this.#verboseMarket = verboseMarket;
    this.#maxLines = maxLines;
  }

  header({ app = "chartLive", version = "1.0.0" } = {}) {
    const now = new Date().toISOString();
    this.#stream.write(`Rithmic WS log (${app}) v${version}\n`);
    this.#stream.write(`exported=${now}\n`);
    this.#stream.write(`verbose=${this.#verbose} market=${this.#verboseMarket}\n`);
    this.#stream.write("---\n");
    this.record("BOOT", `wire log active verbose=${this.#verbose} market=${this.#verboseMarket}`);
  }

  record(level, ...parts) {
    if (this.#truncated) return;
    const body = parts
      .map((p) => {
        if (p == null) return "";
        if (typeof p === "string") return p;
        try {
          return JSON.stringify(p);
        } catch {
          return String(p);
        }
      })
      .filter(Boolean)
      .join(" ");
    const line = `[${new Date().toISOString()}] [${level}] ${body}\n`;
    this.#stream.write(line);
    this.#count += 1;
    if (this.#count >= this.#maxLines) {
      this.#truncated = true;
      this.#stream.write(
        `[${new Date().toISOString()}] [WARN] wire log capped at ${this.#maxLines} lines\n`,
      );
    }
  }

  open(label, url) {
    this.record("OPEN", `WS ${label}`, url);
  }

  close(label, detail) {
    this.record("CLOSE", `WS ${label}`, detail);
  }

  error(label, message) {
    this.record("ERROR", `WS ${label}`, message);
  }

  packet(label, dir, packet) {
    const name = packet?.constructor?.MESSAGE_NAME;
    if (!name) return;
    const fields = redactFields(toPlain(packet.toObject?.() ?? packet));
    if (!this.#shouldLog(name, fields)) return;

    const tid = packet.constructor.TEMPLATE_ID ?? fields.template_id ?? "?";
    this.record(
      "PKT",
      `WS ${label} ${dir}`,
      `${name} (template_id=${tid})`,
      fields,
    );

    if (name === "ForcedLogout") {
      this.record("FORCED_LOGOUT", `WS ${label}`, fields);
    }

    if (name === "ResponseLoginInfo" && fields.tp_max_session_count != null) {
      this.record(
        "SESSION",
        `WS ${label}`,
        `tp_max_session_count=${fields.tp_max_session_count} op_max_session_count=${fields.op_max_session_count ?? "?"}`,
      );
    }
  }

  #shouldLog(name, fields) {
    if (this.#verbose) {
      if (this.#verboseMarket) return true;
      if (QUIET_PACKETS.has(name)) return false;
      return true;
    }
    if (SESSION_PACKETS.has(name)) {
      if (name === "ResponseTimeBarReplay" && !rpCodeError(fields.rp_code)) {
        return false;
      }
      return true;
    }
    if (QUIET_PACKETS.has(name)) return false;
    return rpCodeError(fields.rp_code);
  }
}
