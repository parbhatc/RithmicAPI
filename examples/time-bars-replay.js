/**
 * History plant: replay 1-minute bars (matches Rithmic Trader web wire shape).
 *
 * Env: RITHMIC_USER, RITHMIC_PASSWORD (+ optional RITHMIC_* in .env)
 */
import {
  connect,
  InfraType,
  RequestLogin,
  RequestLoginInfo,
  RequestTimeBarReplay,
  ResponseTimeBarReplay,
} from "../index.js";
import { toPlain } from "../lib/util.js";

const user = process.env.RITHMIC_USER;
const password = process.env.RITHMIC_PASSWORD;
const system = process.env.RITHMIC_SYSTEM ?? "LucidTrading";
const symbol = process.env.RITHMIC_SYMBOL ?? "NQ";
const exchange = process.env.RITHMIC_EXCHANGE ?? "CME";
const barCount = Number(process.env.RITHMIC_BAR_COUNT ?? "300", 10);
const period = Number(process.env.RITHMIC_BAR_PERIOD ?? "1", 10);

if (!user || !password) {
  console.error("Set RITHMIC_USER and RITHMIC_PASSWORD to run this example.");
  process.exit(1);
}

const userMsg = `${symbol}.${exchange}`;
const finish_index = Math.floor(Date.now() / 1000);
const start_index = finish_index - barCount * period * 60;

const BAR_TYPE = {
  0: "UNSPECIFIED",
  1: "SECOND_BAR",
  2: "MINUTE_BAR",
  3: "DAILY_BAR",
  4: "WEEKLY_BAR",
  MINUTE_BAR: "MINUTE_BAR",
  SECOND_BAR: "SECOND_BAR",
  DAILY_BAR: "DAILY_BAR",
  WEEKLY_BAR: "WEEKLY_BAR",
};

const REPLAY_DIRECTION = { 0: "UNSPECIFIED", 1: "FIRST", 2: "LAST", LAST: "LAST", FIRST: "FIRST" };
const REPLAY_TIME_ORDER = {
  0: "UNSPECIFIED",
  1: "FORWARDS",
  2: "BACKWARDS",
  FORWARDS: "FORWARDS",
  BACKWARDS: "BACKWARDS",
};

function enumName(map, value) {
  if (value == null) return undefined;
  return map[value] ?? String(value);
}

function firstStr(value) {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value[0];
  return String(value);
}

function toNum(value) {
  if (value == null) return value;
  if (typeof value === "object" && typeof value.toNumber === "function") return value.toNumber();
  return Number(value);
}

/** Sniffer-style request object (what the web app shows). */
function replayRequestView(body) {
  return {
    symbol: body.symbol,
    exchange: body.exchange,
    user_msg: firstStr(body.user_msg),
    bar_type: enumName(BAR_TYPE, body.bar_type),
    period: body.bar_type_period ?? body.period,
    start_index: body.start_index,
    finish_index: body.finish_index,
    direction: enumName(REPLAY_DIRECTION, body.direction),
    time_order: enumName(REPLAY_TIME_ORDER, body.time_order),
  };
}

/** Sniffer-style bar from ResponseTimeBarReplay (template 203). */
function barFromMessage(msg) {
  const p = toPlain(msg.toObject());
  return {
    bar_type: enumName(BAR_TYPE, p.type),
    period: p.period != null ? String(p.period) : String(period * 60),
    marker: toNum(p.marker),
    num_trades: toNum(p.num_trades),
    volume: toNum(p.volume),
    bid_volume: toNum(p.bid_volume),
    ask_volume: toNum(p.ask_volume),
    open_price: p.open_price,
    close_price: p.close_price,
    high_price: p.high_price,
    low_price: p.low_price,
    clear_bits: p.must_clear_settlement_price ? 1 : 0,
    presence_bits: p.has_settlement_price ? 1 : 0,
    symbol: p.symbol,
    exchange: p.exchange,
    rq_handler_rp_code: firstStr(p.rq_handler_rp_code),
    user_msg: firstStr(p.user_msg),
  };
}

// Wire uses numeric enums; replayRequestView() prints sniffer-style strings.
const replayBody = {
  symbol,
  exchange,
  user_msg: [userMsg],
  bar_type: 2, // MINUTE_BAR
  bar_type_period: period,
  start_index,
  finish_index,
  direction: 2, // LAST
  time_order: 1, // FORWARDS
};

const client = await connect({ label: "history", log: false });

try {
  const login = await client.exchange(
    new RequestLogin({
      user,
      password,
      system_name: system,
      infra_type: InfraType.HISTORY_PLANT,
      template_version: "2.0",
      app_name: "Rithmic Trader Pro - Web",
      app_version: "2.8.0.0",
      user_msg: ["new"],
    }),
  );

  if (!login.ok) throw new Error(`login failed: ${login.rp_code?.join(", ")}`);

  await client.exchange(new RequestLoginInfo(login.unique_user_id));

  console.log("Request:", JSON.stringify(replayRequestView(replayBody), null, 2));
  client.send(new RequestTimeBarReplay(replayBody));

  const bars = [];
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const msg = await client.receive();
    if (!(msg instanceof ResponseTimeBarReplay)) {
      console.warn("skip:", msg.constructor.MESSAGE_NAME);
      continue;
    }

    const isBar =
      msg.marker != null &&
      msg.marker !== 0 &&
      (msg.open_price != null || msg.close_price != null);

    if (isBar) bars.push(barFromMessage(msg));

    if (msg.rp_code?.[0] === "0" && !isBar) break;
  }

  console.log(`\nReceived ${bars.length} bar(s)\n`);

  if (bars.length === 0) {
    console.log("No bars returned.");
    process.exit(2);
  }

  console.log("First: ", JSON.stringify(bars[0], null, 2));
  if (bars.length > 1) console.log("Second:", JSON.stringify(bars[1], null, 2));
  if (bars.length > 2) console.log("Last:  ", JSON.stringify(bars[bars.length - 1], null, 2));
} finally {
  client.close();
}
