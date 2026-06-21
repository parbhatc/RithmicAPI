# rithmic-api

Unofficial Node.js client for the [Rithmic](https://www.rithmic.com/) Protocol Buffer WebSocket API.

Use it to discover gateways, load historical OHLC bars (time and tick), and stream live quotes and closed bars — similar to what charting apps show.

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

`ChartSession` opens both connections, logs in, and exposes history + live events.

### Module layout

Chart code is split into small classes under `lib/chart-session/`:

| Class | Role |
|-------|------|
| `ChartSession` | Main session — connect, `loadHistory`, `loadTickHistory`, `startLive`, events |
| `HistoryFetch` | One-shot fetch helpers (`bars`, `history`, `tickBars`, `tickHistory`) |
| `HistoryQuery` | Resolution parsing, query building, `{ s, t, o, h, l, c, v }` payloads |
| `SessionGateway` | Gateway discovery + dual-plant login |
| `TimeBarHistory` | Time-bar replay (template 202 → 203) |
| `TickBarHistory` | Tick-bar replay (template 206 → 207) |
| `LiveFeed` | Live subscribe/unsubscribe + packet dispatch |

Public exports from `index.js`: `ChartSession`, `HistoryFetch`, `HistoryQuery`, plus `Client`, protocol packets, and market helpers.

### Historical bars (one-shot)

Query params match the usual chart-API shape: **`resolution`**, **`from`**, **`to`**, **`countback`**.

```js
import { HistoryFetch, HistoryQuery } from "rithmic-api";

// Normalized bar objects
const bars = await HistoryFetch.bars({
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

// Chart arrays { s, t, o, h, l, c, v } (compat: true by default)
const payload = await HistoryFetch.history({
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
// Pass compat: false for direct 1:1 Rithmic bar mapping.

// Or build payload from bars you already have:
const manual = HistoryQuery.barsToHistoryPayload(bars, { compat: true });
```

| Param | Maps to | Notes |
|-------|---------|--------|
| `resolution` | `bar_type` + `bar_type_period` | Minutes: `1`, `5`, `15`, `60` · Seconds: `"1S"`, `"5S"` · Daily/weekly: `"1D"` / `"1W"` |
| `from` | `start_index` | Unix seconds (range start) |
| `to` | `finish_index` | Unix seconds (range end) |
| `countback` | — | If `from` is omitted: `from = to - countback × period` |

If **`from` and `to`** are both set, that window is sent to Rithmic (you may get more bars than `countback` if the session was open). If only **`to` + `countback`**, the range is derived from the bar count.

Legacy names still work: `barCount`, `period`, `start_index`, `finish_index`.

`marker` on each bar is the **bar open time** (Unix seconds, UTC). Some frontends use `t = marker - 60` for the same candle — pass `timeOffset: -60` with `payload: true` or `HistoryQuery.barsToHistoryPayload(bars, { timeOffset: -60 })`.

`HistoryFetch.history()` defaults to `compat: true`, which aligns `t[i]` with OHLCV from the next bar (count `n - 1`). Use `compat: false` for a direct 1:1 Rithmic mapping.

### Tick-bar history

```js
import { HistoryFetch } from "rithmic-api";

const payload = await HistoryFetch.tickHistory({
  user, password,
  systemName: "LucidTrading",
  symbol: "NQ",
  exchange: "CME",
  resolution: "100T",
  from: 1780479674,
  to: 1780510978,
  countback: 301,
});
```

`ChartSession.loadTickHistory()` uses the same options on an open session. See `examples/match-100t-chart.mjs`.

### Live chart (last, bid/ask, closed bars)

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

await chart.stopLive();
chart.close();
```

| Event | Wire template | When it fires |
|-------|---------------|----------------|
| `trade` | 150 `LastTrade` | New **last trade** (`presence_bits` includes `LAST_TRADE`) |
| `quote` | 151 `BestBidOffer` | Bid and/or ask updated (`BID` / `ASK` bits) |
| `latest_high_low` | 152 `HighPriceLowPrice` | Session **high/low** snapshot |
| `latest_close` | 155 `ClosePrice` | Session **close/settlement** snapshot |
| `bar` | 250 `TimeBar` | **Closed** OHLC bar from the history plant |
| `status` | — | Merged snapshot after any tick/quote/bar update |
| `message` | — | Other decoded packets (debug) |

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

#### Live `TimeBar`

- `TimeBar` (250) is subscribed on the **history plant** (default 1m).
- `marker` = **bar open time** (Unix seconds, UTC).
- For the current price while a bar is still open, use `LastTrade.price`; when the bar closes, `TimeBar.close` is the finalized value.

Bid = buy side of the book. Ask = sell side. `Last … Buy/Sell` is the **aggressor** on that print, not a different close type.

#### Examples

```bash
npm run example              # discover gateways
npm run example:bars         # time-bar replay (low-level)
npm run example:chart        # history + live quotes/bars
npm run example:test-bars    # loadHistory compat arrays
npm run example:tv-15m       # TradingView-style history query
npm run example:tick-bars    # tick-bar replay
npm run example:match-100t   # 100-tick chart comparison
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
| 206 / 207 | Tick bar replay |
| 250 | `TimeBar` (live update) |

Full list: `lib/templates.js`.

Protobuf schemas load from `proto/*.proto` at `init()` time.

Decode a captured frame:

```bash
npm run decode -- AAAAEpi2SxLC6UAKMTc3OTkyNTMyNA==
```

## API reference

### Core

| Export | Description |
|--------|-------------|
| `init()` | Load `.proto` definitions once |
| `connect(options?)` | WebSocket + `Client` |
| `discover(systemName)` | Gateway URLs + system list |
| `Client` | `send`, `receive`, `exchange`, `drain`, `close` |
| `Request*` / `Response*` / `LastTrade` / `TimeBar` / … | Packet classes |
| `buildOrderPlantHandshake`, … | Order-plant login helpers |

### Chart session

| Export | Description |
|--------|-------------|
| `ChartSession` | Dual-plant chart session |
| `ChartSession.open(options)` | Connect ticker + history plants |
| `chart.loadHistory(options)` | Time-bar replay → normalized bars |
| `chart.loadTickHistory(options)` | Tick-bar replay → normalized bars |
| `chart.startLive(options)` | Subscribe live trade/quote/bar |
| `chart.stopLive()` | Unsubscribe |
| `chart.close()` | Close connections |
| `chart.status` | Merged last/bid/ask/bar snapshot |

### History helpers

| Export | Description |
|--------|-------------|
| `HistoryFetch.bars(options)` | One-shot time-bar history → bar objects |
| `HistoryFetch.history(options)` | Same, returns `{ s, t, o, h, l, c, v }` (`compat: true` default) |
| `HistoryFetch.tickBars(options)` | One-shot tick-bar history → bar objects |
| `HistoryFetch.tickHistory(options)` | Same, returns `{ s, t, o, h, l, c, v }` |
| `HistoryQuery.parseResolution(resolution)` | `"15"` / `"1D"` → `{ barType, barTypePeriod, periodSeconds }` |
| `HistoryQuery.parseTickResolution(resolution)` | `"100T"` → tick bar spec |
| `HistoryQuery.resolveHistoryQuery(options)` | Query params → Rithmic `start_index` / `finish_index` |
| `HistoryQuery.resolveTickHistoryQuery(options)` | Tick query params |
| `HistoryQuery.barsToHistoryPayload(bars, opts)` | Bars → `{ s, t, o, h, l, c, v }` |
| `HistoryQuery.trimCountbackBars(bars, n, anchor?)` | Trim to countback |
| `HistoryQuery.aggregateTickBars(bars, tickSize)` | 1-tick → N-tick aggregation |
| `HistoryQuery.isCalendarResolution(resolution)` | `D` / `W` / `M` resolutions |

### Market views

| Export | Description |
|--------|-------------|
| `normalizeBar` / `normalizeTickBar` / `normalizeTrade` / `normalizeQuote` | Packet → plain objects (respects `presence_bits`) |
| `tickBarTime(bar)` | Fractional Unix time for tick bars |
| `chartStatus(snapshot)` | Build merged status object |
| `BarType`, `MarketUpdateBits`, `MarketUpdatePreset`, `ReplayDirection`, … | Wire enums |

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
| `RITHMIC_COUNTBACK` | Bar count for `example:tv-15m` (default `300`) |
| `RITHMIC_TIME_RESOLUTION` | Resolution for `example:tv-15m` (default `15`) |
| `RITHMIC_GATEWAY` | Optional gateway name filter |
| `RITHMIC_VERBOSE` | Set to `1` in `live-chart` for merged `status` logs |
| `RITHMIC_COMPARE_API` | Set to `1` in `example:tv-15m` to diff vs local API |
| `RITHMIC_START_LIVE` | Set to `1` in `example:tv-15m` to stream live bars |

## Project layout

```
index.js
ChartSession.js          re-exports lib/chart-session
init.js / Session.js / Client.js
lib/
  chart-session/         ChartSession, HistoryFetch, TimeBarHistory, TickBarHistory, LiveFeed, …
  history-query.js       HistoryQuery
  market-enums.js / market-views.js
  proto.js               loads proto/*.proto
protocol/                Packet subclasses (generated + core)
proto/                   rithmic.proto, session.proto, async/*.proto
examples/                see examples/README.md
tools/                   decode.js, generate-packets.mjs, download-protos.mjs
web/                     optional TradingView embed + datafeed server
```

Regenerate packet classes after proto updates:

```bash
npm run protos:download
npm run protos:packets
```

## License

MIT — see [LICENSE](LICENSE).
