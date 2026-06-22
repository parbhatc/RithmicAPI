# rithmic-api

Unofficial Node.js client for the [Rithmic](https://www.rithmic.com/) Protocol Buffer WebSocket API.

Use it to discover gateways, load historical OHLC bars (time and tick), stream live quotes and closed bars, and work with order and PnL plants.

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

## Quick start

```js
import { init, discover, ChartSession, MarketUpdatePreset } from "rithmic-api";

await init();

const { gateways } = await discover("LucidTrading");
console.log(gateways);

const chart = await ChartSession.open({
  user: process.env.RITHMIC_USER,
  password: process.env.RITHMIC_PASSWORD,
  systemName: "LucidTrading",
  symbol: "NQ",
  exchange: "CME",
  gatewayName: "Chicago",
});

await chart.planets.history.load({ countback: 300 });
await chart.planets.live.start({ updateBits: MarketUpdatePreset.CHART });

chart.on("trade", (t) => console.log("last", t.price));
chart.on("bar", (b) => console.log("bar", b.marker, b.close));

chart.close();
```

```bash
node --env-file=.env examples/discover.mjs
npm run example:history
npm run example:live
```

See [examples/README.md](examples/README.md) for the full list.

## Rithmic plants

Rithmic splits functionality across **plants** — separate WebSocket logins on the same gateway URL (`infra_type` on `RequestLogin`):

| Plant | `infra_type` | Purpose |
|-------|--------------|---------|
| **Ticker** | `1` | Last trade, bid/ask, reference data, depth |
| **Order** | `2` | Accounts, routes, place/cancel/modify orders |
| **History** | `3` | Time/tick bar replay and live `TimeBar` updates |
| **PnL** | `4` | Position and account PnL snapshots/updates |

`ChartSession` can open several plants at once via the `plants` option. Defaults are in `DEFAULT_PLANTS` (all four on).

```js
plants: { ticker: true, history: true, order: true, pnl: true }
```

## Chart session (`chart.planets`)

| Planet | Role |
|--------|------|
| `chart.planets.history` | `load()`, `loadTick()` — replay on a persistent history socket |
| `chart.planets.ticker` | Reference data, subscribe/unsubscribe, symbol search, depth |
| `chart.planets.live` | `start()`, `stop()` — merged live events on `chart` |
| `chart.planets.order` | Raw `client` + `send()` / `exchange()` when `plants.order: true` |
| `chart.planets.pnl` | Raw `client` when `plants.pnl: true` |

Load history **before** `planets.live.start()` so replay finishes before live updates.

### Historical bars (one-shot)

`HistoryFetch` opens a session, loads bars, and closes — no persistent socket.

Query params: **`resolution`**, **`from`**, **`to`**, **`countback`**.

```js
import { HistoryFetch } from "rithmic-api";

const bars = await HistoryFetch.bars({
  user, password, systemName: "LucidTrading",
  symbol: "NQ", exchange: "CME",
  resolution: 1,
  countback: 300,
});

const payload = await HistoryFetch.history({ /* same options */ });
// { s, t, o, h, l, c, v } — compat: true by default
```

| Param | Notes |
|-------|--------|
| `resolution` | Minutes: `1`, `5`, `15`, `60` · Seconds: `"1S"` · Daily/weekly: `"1D"` / `"1W"` |
| `from` / `to` | Unix seconds (range) |
| `countback` | If `from` omitted: `from = to - countback × period` |

Tick bars: `HistoryFetch.tickBars()` / `tickHistory()` with `resolution: "100T"`, or `chart.planets.history.loadTick()` on an open session.

`marker` on each bar is the **bar open time** (Unix seconds, UTC).

### Live events

| Event | Wire | When |
|-------|------|------|
| `trade` | 150 `LastTrade` | New last price/size |
| `quote` | 151 `BestBidOffer` | Bid and/or ask change |
| `bar` | 250 `TimeBar` | Closed OHLC bar (history plant) |
| `status` | — | Merged snapshot after updates |

Partial wire updates are merged using `presence_bits` before events fire. Use `chart.status` for one combined view.

## Plant sessions (standalone)

Use these when you only need one plant without `ChartSession`:

| Class | Plant | Typical use |
|-------|-------|-------------|
| `TickerSession` | Ticker | Market data only |
| `OrderSession` | Order | Trading, accounts, routes |
| `PnLSession` | PnL | Position snapshots and streaming updates |

```js
import { OrderSession, PnLSession } from "rithmic-api";

const order = await OrderSession.open({ user, password, systemName: "LucidTrading" });
console.log(order.accounts, order.tradeRoutes);
await order.close();

const pnl = await PnLSession.open({ user, password, systemName: "LucidTrading" });
const snap = await pnl.snapshot();
await pnl.close();
```

`OrderSession` supports `mobileBootstrap: true` for the mobile/Lucid login burst.

## Wire format

```
[ 4-byte big-endian length ][ protobuf body ]
```

`template_id` (field **154467**) identifies the message type. Common chart IDs:

| ID | Message |
|----|---------|
| 100 / 101 | Market data subscribe / ack |
| 150 | `LastTrade` |
| 151 | `BestBidOffer` |
| 200 / 201 | Time bar subscribe / ack |
| 202 / 203 | Time bar replay |
| 206 / 207 | Tick bar replay |
| 250 | `TimeBar` (live) |

Full list: `lib/templates.js`. Protobuf schemas load from `proto/*.proto` at `init()`.

## API reference

### Core

| Export | Description |
|--------|-------------|
| `init()` | Load `.proto` definitions once |
| `connect(options?)` | WebSocket + `Client` |
| `discover(systemName)` | Gateway URLs + system list |
| `Client` | `send`, `receive`, `exchange`, `drain`, `close` |
| `Request*` / `Response*` / market packets | Generated protocol classes |
| `buildOrderPlantHandshake`, … | Order-plant login packet helpers |

### History helpers

| Export | Description |
|--------|-------------|
| `HistoryFetch.bars` / `.history` | One-shot time-bar history |
| `HistoryFetch.tickBars` / `.tickHistory` | One-shot tick-bar history |
| `HistoryQuery` | Resolution parsing, query building, payload shaping |

### Market views

| Export | Description |
|--------|-------------|
| `normalizeBar`, `normalizeTrade`, `normalizeQuote`, … | Packet → plain objects |
| `MarketUpdatePreset`, `ReplayDirection`, … | Wire enums |

Deprecated on `ChartSession` (still work): `loadHistory`, `loadTickHistory`, `startLive`, `stopLive`.

## Project layout

```
index.js                 public API exports
lib/
  core/                  Client.js, init.js, Session.js
  sessions/
    chart/               ChartSession.js, SessionGateway.js, LiveFeed.js, …
      planets/           HistoryPlanet.js, TickerPlanet.js, Planets.js, …
    plant/               PlantSession.js, OrderSession.js, PnLSession.js, …
  HistoryQuery.js
  marketEnums.js / marketViews.js
  proto.js / templates.js
protocol/                packet classes
proto/                   .proto message definitions
examples/                runnable scripts (see examples/README.md)
```

## Examples

| npm script | Script |
|------------|--------|
| `npm run example:discover` | Gateway discovery |
| `npm run example:history` | Chart history replay |
| `npm run example:live` | Live trade/quote/bar stream |
| `npm run example:tick` | Tick-bar replay |
| `npm run example:fetch` | One-shot `HistoryFetch` |
| `npm run example:order` | Order plant login |
| `npm run example:pnl` | PnL snapshot |

Environment variables for examples: `RITHMIC_USER`, `RITHMIC_PASSWORD`, optional `RITHMIC_SYSTEM`, `RITHMIC_SYMBOL`, `RITHMIC_EXCHANGE`, `RITHMIC_GATEWAY`, `RITHMIC_COUNTBACK`, `RITHMIC_RESOLUTION`, `RITHMIC_LIVE_SECONDS`.

## License

MIT — see [LICENSE](LICENSE).
