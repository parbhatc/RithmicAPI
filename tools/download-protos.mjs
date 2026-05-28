/**
 * Download Rithmic .proto definitions from async_rithmic (MIT).
 * Skips messages already defined in proto/rithmic.proto and proto/session.proto.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "proto", "async");
const BASE =
  "https://raw.githubusercontent.com/rundef/async_rithmic/main/async_rithmic/protocol_buffers/source";

const FILES = [
  "request_logout.proto",
  "response_logout.proto",
  "request_reference_data.proto",
  "response_reference_data.proto",
  "reject.proto",
  "forced_logout.proto",
  "request_market_data_update.proto",
  "response_market_data_update.proto",
  "last_trade.proto",
  "best_bid_offer.proto",
  "order_book.proto",
  "request_time_bar_update.proto",
  "response_time_bar_update.proto",
  "request_time_bar_replay.proto",
  "response_time_bar_replay.proto",
  "request_tick_bar_replay.proto",
  "response_tick_bar_replay.proto",
  "time_bar.proto",
  "tick_bar.proto",
  "request_new_order.proto",
  "response_new_order.proto",
  "request_cancel_all_orders.proto",
  "response_cancel_all_orders.proto",
  "request_exit_position.proto",
  "response_exit_position.proto",
  "request_subscribe_to_bracket_updates.proto",
  "response_subscribe_to_bracket_updates.proto",
  "request_show_brackets.proto",
  "response_show_brackets.proto",
  "request_show_bracket_stops.proto",
  "response_show_bracket_stops.proto",
  "rithmic_order_notification.proto",
  "exchange_order_notification.proto",
  "request_pnl_position_updates.proto",
  "response_pnl_position_updates.proto",
  "request_pnl_position_snapshot.proto",
  "response_pnl_position_snapshot.proto",
  "instrument_pnl_position_update.proto",
  "account_pnl_position_update.proto",
  "response_account_list.proto",
  "response_account_rms_info.proto",
  "response_subscribe_for_order_updates.proto",
  "response_show_orders.proto",
];

await mkdir(OUT, { recursive: true });

for (const file of FILES) {
  const url = `${BASE}/${file}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`FAIL ${file}: ${res.status}`);
    process.exitCode = 1;
    continue;
  }
  const text = await res.text();
  await writeFile(join(OUT, file), text, "utf8");
  console.log(`OK ${file}`);
}
