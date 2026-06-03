# rithmic-api

Unofficial Node.js client for the [Rithmic](https://www.rithmic.com/) Protocol Buffer WebSocket API.

Use it to discover gateways, load historical OHLC bars, and stream live quotes (last, bid/ask) and forming candles — similar to what charting apps show.

Each message is a small class (`RequestFoo`, `LastTrade`, `TimeBar`, …) with `encode()` / `decode()`. The client adds the 4-byte length prefix.

> **Disclaimer:** Not affiliated with or endorsed by Rithmic. Use at your own risk. You need your own Rithmic account and must follow their terms of service.

## Requirements

- Node.js 18+

## Install

```bash
npm install rithmic-api
```

From source:

```bash
git clone <your-repo-url>
cd RithmicAPI
npm install
cp .env.example .env   # add credentials
```

## Quick start — discovery

```js
import { discover } from "rithmic-api";

const { systems, gateways } = await discover("LucidTrading");

console.log(systems);
// gateways: { name: "Chicago Area", uri: "wss://rprotocol-..." }, ...
```

```bash
npm run example
```

## Chart API (history + live)

Rithmic splits market data across **plants** (separate WebSocket logins on the same gateway URL):

| Plant | `infra_type` | What you get |
|-------|----------------|--------------|
| **Ticker** | `1` | `LastTrade` (150), `BestBidOffer` (151), … via `RequestMarketDataUpdate` (100) |
| **History** | `3` | `ResponseTimeBarReplay` (203), live `TimeBar` (250) via replay / `RequestTimeBarUpdate` (200) |

`ChartSession` opens both connections, logs in, and gives you a simple API plus events.

### Historical bars (one-shot)

Query params match the usual chart-API shape: **`resolution`**, **`from`**, **`to`**, **`countback`**.

```js
import { fetchHistoryBars, fetchHistory } from "rithmic-api";

// Same as: ?resolution=1&from=1779788481&to=1779929351&countback=300
const bars = await fetchHistoryBars({
  user: process.env.RITHMIC_USER,
  password: process.env.RITHMIC_PASSWORD,
  systemName: "LucidTrading",
  symbol: "NQ",
  exchange: "CME",
  resolution: 1,
  from: 1779788481,
  to: 1779929351,
  countback: 300,
});

// Compatibility arrays { s, t, o, h, l, c, v }
const payload = await fetchHistory({
  user: process.env.RITHMIC_USER,
  password: process.env.RITHMIC_PASSWORD,
  systemName: "LucidTrading",
  symbol: "NQ",
  exchange: "CME",
  resolution: 1,
  from: 1779788481,
  to: 1779929351,
  countback: 300,
});
// fetchHistory defaults to compat: true.
// For raw Rithmic mapping, pass compat: false.
```

| Param | Maps to | Notes |
|-------|---------|--------|
| `resolution` | `bar_type` + `bar_type_period` | Minutes: `1`, `5`, `15`, `60` · Seconds: `"1S"`, `"5S"` · Daily/weekly: `"1D"` / `"1W"` |
| `from` | `start_index` | Unix seconds (range start) |
| `to` | `finish_index` | Unix seconds (range end) |
| `countback` | — | If `from` is omitted: `from = to - countback × period` |

If **`from` and `to`** are both set, that window is sent to Rithmic (you may get more bars than `countback` if the session was open). If only **`to` + `countback`**, the range is derived from the bar count.

Legacy names still work: `barCount`, `period`, `start_index`, `finish_index`.

`marker` on each bar is the **bar open time** (Unix seconds, UTC). Some frontends use `t = marker - 60` for the same candle — pass `timeOffset: -60` with `payload: true` or `barsToHistoryPayload(bars, { timeOffset: -60 })`.

`fetchHistory()` now defaults to `compat: true`, which uses compatibility alignment (`t[i]` with OHLCV from the next bar, count `n - 1`). Use `compat: false` for a direct 1:1 Rithmic bar mapping.

### Live chart (last, bid/ask, forming bar)

`ChartSession` uses **two WebSocket connections** on the same gateway:

- **Ticker plant** — `LastTrade` (150), `BestBidOffer` (151)
- **History plant** — live `TimeBar` (250) after `RequestTimeBarUpdate` (200)

Load history **before** `startLive()` so replay finishes before live pumps start.

```js
import { ChartSession, BarType, MarketUpdatePreset } from "rithmic-api";

const chart = await ChartSession.open({
  user: process.env.RITHMIC_USER,
  password: process.env.RITHMIC_PASSWORD,
  systemName: "LucidTrading",
  symbol: "NQ",
  exchange: "CME",
  gatewayName: "Chicago", // optional; default first Chicago gateway from discover()
});

const history = await chart.loadHistory({ barCount: 300 });

chart.on("trade", (t) => console.log("last", t.price, t.size));
chart.on("quote", (q) => console.log("bid/ask", q.bid, q.ask));
chart.on("bar", (b) => console.log("bar", b.marker, b.close));
chart.on("latest_high_low", (r) => console.log("high/low", r.high_price, r.low_price));
chart.on("latest_close", (c) => console.log("close", c.close_price, c.settlement_price));
chart.on("status", (s) => {
  // merged snapshot: last, bid, ask, latest_high, latest_low, latest_close, bar_close, …
});

// Default: 1-minute live bars; CHART preset = quote + session high/low + close/settlement
await chart.startLive({ updateBits: MarketUpdatePreset.CHART });

// 1-second live bars (matches web app SECOND_BAR + period 1)
await chart.startLive({
  barType: BarType.SECOND_BAR,
  barPeriod: 1,
});

await chart.stopLive();
chart.close();
```

| Event | Wire template | When it fires |
|-------|---------------|----------------|
| `trade` | 150 `LastTrade` | New **last trade** (`presence_bits` includes `LAST_TRADE`) |
| `quote` | 151 `BestBidOffer` | Bid and/or ask updated (`BID` / `ASK` bits) |
| `latest_high_low` | 152 `HighPriceLowPrice` | Session **high/low** snapshot |
| `latest_close` | 155 `ClosePrice` | Session **close/settlement** snapshot |
| `bar` | 250 `TimeBar` | **Closed** OHLC bar when a bucket finishes |
| `formingBar` | — (built client-side) | Current **open** bucket from `LastTrade` + optional seed |
| `status` | — | Merged snapshot after any tick/quote/bar update |

Normalized event fields:

| Event | Key fields |
|-------|------------|
| `trade` | `price`, `size`, `volume`, `vwap`, `net_change`, `presence_bits` |
| `quote` | `bid`, `ask`, `bid_size`, `ask_size`, `lean`, `presence_bits` |
| `latest_high_low` | `high_price`, `low_price`, `presence_bits`, `is_snapshot` |
| `latest_close` | `close_price`, `close_date`, `settlement_price`, `settlement_date`, `price_type` |
| `bar` | `open`, `high`, `low`, `close`, `marker`, `volume`, `num_trades`, `bid_volume`, `ask_volume` |

#### Partial updates (`presence_bits`)

Rithmic often sends **incomplete** ticks — only the fields flagged in `presence_bits` are present on the wire. Examples:

- `LastTrade` with `presence_bits: 16` → **VWAP only** (no new price/size)
- `BestBidOffer` with `presence_bits: 2` → **ask side only**

`ChartSession` **merges** partial updates into the last known quote/trade and only emits:

- `trade` when a new last price/size arrives
- `quote` when bid or ask changes

Use `chart.status` for a single merged view (last + bid/ask + bar close).

#### `CandleLayer` — chart refresh without lagging one candle

Use when you need **correct forming OHLC** on refresh (not only on live ticks). Rithmic’s **1m history replay** can report wrong highs/lows in the open bucket; the layer fixes that with a **tick replay** over the 1m tail before rolling up higher timeframes.

**Minute+ flow** (`load1m({ alsoFor: [15] })`):

```
At 4:42 PM, viewing 15m:
  1. Native 15m replay (include_forming: false) → completed bars through 4:15
  2. 1m replay from 4:30 → now (~15 bars), not 300×1m
  3. Tick replay over that 1m tail → correct OHLC per minute
  4. Forming 15m = rollup of tick-refined 1m + forming 1m
```

| Resolution | Closed bars | Open bucket |
|------------|-------------|-------------|
| **15m, 60m, 1D, …** | Native Rithmic replay | Derived from 1m tail |
| **1m** | Tick-refined replay (or full countback if `alsoFor` is only `1`) | `seedForming1m` / tick refine |

**Defaults:** `loadHistory` and `load1m` use `include_forming: false` unless you opt in.

```javascript
import { ChartSession, CandleLayer, MarketUpdatePreset } from "rithmic-api";

const chart = await ChartSession.open({ user, password, systemName: "LucidTrading", symbol: "NQ", exchange: "CME" });
const layer = new CandleLayer(chart);

await layer.load1m({
  alsoFor: [15],           // native completed 15m + 1m tail for open bucket
  countback: 25,             // native HTF bar count
  include_forming: true,     // forming 15m + forming 1m
  tickOpen: true,            // tick-refine 1m tail (default true)
});

const closed15 = layer.getClosed(15);   // rithmic-native, through last completed bucket
const forming15 = layer.getForming(15); // 1m-derived+tick-bucket-open
const series15 = layer.getSeries(15);   // closed + forming

// Live: ticks → forming 1m only; re-read higher TF after each trade
await chart.startLive({
  updateBits: MarketUpdatePreset.QUOTE,
  exactBar: layer.forming1m,
  exactFormingBar: false,
});
chart.on("trade", (t) => {
  layer.onTrade(t);
  const bar = layer.getForming(15);
});
```

`ChartState` is an alias for `CandleLayer`. **Seconds** (`5S` … `45S`) and **tick charts** (`100T`) use a separate path (`resolveDataLayer`) and do not use this 1m store.

**Try it:**

```bash
npm run example:forming-15m
RITHMIC_TIME_RESOLUTION=1 npm run example:forming-15m   # 1m only
RITHMIC_INCLUDE_FORMING=0 npm run example:forming-15m # closed only
RITHMIC_START_LIVE=1 npm run example:forming-15m      # live forming updates
```

See `examples/README.md` for all scripts.

#### Live `TimeBar` vs forming candle

- `TimeBar` (250) on **1m** closes the minute; higher TFs are not subscribed independently.
- `marker` = **bar open time** (Unix seconds, UTC).
- For OHLC **close** while forming, use `LastTrade.price`; when the bucket closes, `TimeBar.close` matches the finalized bar.

Bid = buy side of the book. Ask = sell side. `Last … Buy/Sell` is the **aggressor** on that print, not a different close type.

#### Examples

```bash
npm run example              # discover gateways
npm run example:bars         # time-bar replay (low-level)
npm run example:chart        # history + live quotes/bars
npm run example:test-bars    # loadHistory compat arrays
npm run example:forming-15m  # CandleLayer forming OHLC (15m default, any minute TF)
npm run example:tick-bars    # tick-bar replay
```

`examples/live-chart.js` prints readable lines like:

```
History: 300 bars
  first: 5/28/2026, 2:22:00 PM 30307.75
  last:  5/28/2026, 8:21:00 PM 30294.75

NQ  Bid 30284.50 x 2  |  Ask 30285.75 x 1
NQ  Last 30285.00 x 1  Buy
NQ  latest_high_low  high 30362.00  low 30216.50
NQ  latest_close  20260528 30313.00  settlement 20260528 30307.00  (final)
NQ  Bar 5/28/2026, 8:22:00 PM  close 30288.75  vol 87
```

Set `RITHMIC_VERBOSE=1` to log merged `status` snapshots.

### Lower-level packets

You can still send any `Request*` class on a `Client`:

```js
import {
  init,
  connect,
  InfraType,
  RequestLogin,
  RequestMarketDataUpdate,
  SubscribeRequest,
  MarketUpdatePreset,
  LastTrade,
  BestBidOffer,
} from "rithmic-api";

await init();
const client = await connect({ uri: "wss://…" });
// login with infra_type: InfraType.TICKER_PLANT, then:
client.send(
  new RequestMarketDataUpdate({
    symbol: "NQ",
    exchange: "CME",
    request: SubscribeRequest.SUBSCRIBE,
    update_bits: MarketUpdatePreset.QUOTE, // LAST_TRADE | BBO
    user_msg: ["NQ.CME"],
  }),
);
const msg = await client.receive(); // LastTrade or BestBidOffer
```

`Client.exchange(request)` waits for the matching `Response*` class. If the server sends push data first (e.g. `BestBidOffer` before `ResponseMarketDataUpdate`), those packets are **queued** and returned by the next `receive()` call — same behavior as the web app’s subscribe flow.

Replay request enums must be **numeric** on the wire (e.g. `bar_type: 2` for `MINUTE_BAR`, not the string `"MINUTE_BAR"`).

## Order plant session (login burst)

After the user presses **Login** on the web app, the order plant sends a burst of requests (accounts, routes, orders, …). Helpers build those packets:

```js
import {
  init,
  connect,
  discover,
  buildOrderPlantHandshake,
} from "rithmic-api";

await init();
const { gateways } = await discover("LucidTrading");
const client = await connect({ uri: gateways[0].uri });
client.sendAll(
  buildOrderPlantHandshake({
    fcm_id: "LucidTrading",
    ib_id: "LucidTrading",
    account_id: "YOUR-ACCOUNT",
    server_tag: "rproto_srvr_…",
  }),
);
const messages = await client.drain();
client.close();
```

See `Session.js` and `examples/gateway-session.js` for details.

## Wire format

```
[ 4-byte big-endian length ][ protobuf body ]
```

`template_id` (field **154467**) identifies the message type. Common chart-related IDs:

| ID | Message |
|----|---------|
| 100 / 101 | Market data subscribe / ack |
| 150 | `LastTrade` |
| 151 | `BestBidOffer` |
| 200 / 201 | Time bar subscribe / ack |
| 202 / 203 | Time bar replay / bar or ack |
| 250 | `TimeBar` (live update) |

Full list: `lib/templates.js`.

Decode a captured frame:

```bash
npm run decode -- AAAAEpi2SxLC6UAKMTc3OTkyNTMyNA==
```

## API reference

| Export | Description |
|--------|-------------|
| `init()` | Load `.proto` definitions once |
| `connect(options?)` | WebSocket + `Client` |
| `discover(systemName)` | Gateway URLs + system list |
| `fetchHistoryBars(options)` | One-shot history (`resolution`, `from`, `to`, `countback`) → bars |
| `fetchHistory(options)` | Same, returns `{ s, t, o, h, l, c, v }` |
| `resolveHistoryQuery(options)` | Parse query params → Rithmic `start_index` / `finish_index` |
| `barsToHistoryPayload(bars)` | Normalized bars → `{ s, t, o, h, l, c, v }` |
| `ChartSession` | Dual-plant chart session (`open`, `loadHistory`, `startLive`, events) |
| `ChartSession.open(options)` | Connect ticker + history |
| `CandleLayer` | Canonical 1m store + native HTF completed + tick-refined forming rollup |
| `CandleLayer.load1m`, `getClosed`, `getForming`, `getSeries`, `onTrade` | See forming-candle section above |
| `ChartState` | Alias for `CandleLayer` |
| `normalizeBar` / `normalizeTrade` / `normalizeQuote` | Packet → plain objects (respects `presence_bits`) |
| `mergeTick` | Merge partial quote/trade updates |
| `BarType`, `MarketUpdateBits`, `MarketUpdatePreset`, `LastTradePresence`, `BestBidOfferPresence`, … | Wire enums |
| `Client` | `send`, `receive`, `exchange`, `drain`, `close` |
| `Request*` / `Response*` / `LastTrade` / `TimeBar` / … | Packet classes |
| `buildOrderPlantHandshake`, … | Order-plant login helpers |

### `Client` options

| Option | Default | Description |
|--------|---------|-------------|
| `uri` | mobile discovery URL | WebSocket endpoint (use gateway URI from `discover()`) |
| `log` | `false` | Log send/recv |
| `timeoutMs` | `30000` | Connect / per-read timeout |

### Environment (examples)

| Variable | Purpose |
|----------|---------|
| `RITHMIC_USER` / `RITHMIC_PASSWORD` | Login |
| `RITHMIC_SYSTEM` | e.g. `LucidTrading` |
| `RITHMIC_SYMBOL` / `RITHMIC_EXCHANGE` | e.g. `NQ` / `CME` |
| `RITHMIC_BAR_COUNT` | History length for `live-chart` / `time-bars-replay` |
| `RITHMIC_TIME_RESOLUTION` | Chart TF for `example:forming-15m` (default `15`) |
| `RITHMIC_TIME_BAR_COUNT` | Native HTF countback for `CandleLayer` (default `25`) |
| `RITHMIC_INCLUDE_FORMING` | `0` = closed only; example defaults to forming on |
| `RITHMIC_START_LIVE` | `1` = subscribe trades in `example:forming-15m` |
| `RITHMIC_GATEWAY` | Optional gateway name filter |
| `RITHMIC_VERBOSE` | Set to `1` in `live-chart` for merged `status` logs |

## Project layout

```
index.js / ChartSession.js
init.js / Session.js / Client.js
lib/              templates, proto loader, market enums/views
protocol/         Packet subclasses (generated + core)
proto/            rithmic.proto, session.proto, async/*.proto
examples/         handshake, live-chart, test-forming-15m (CandleLayer), … — see examples/README.md
tools/            decode.js, generate-packets.mjs, download-protos.mjs
extension/        Chrome sniffer (optional, gitignored in some setups)
```

Regenerate packet classes after proto updates:

```bash
npm run protos:download
npm run protos:packets
```

## License

MIT — see [LICENSE](LICENSE).
