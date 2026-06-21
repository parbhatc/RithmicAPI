# Examples

Copy `.env.example` to `.env` and set `RITHMIC_USER` / `RITHMIC_PASSWORD`.

| Script | npm command | What it does |
|--------|-------------|--------------|
| `handshake.js` | `npm run example` | Discover systems / gateways |
| `gateway-session.js` | `npm run example:gateway` | Order-plant login burst |
| `time-bars-replay.js` | `npm run example:bars` | Raw `RequestTimeBarReplay` |
| `live-chart.js` | `npm run example:chart` | History + live quote/bar events |
| `test-get-bars.mjs` | `npm run example:test-bars` | `loadHistory` compat payload |
| `test-tv-history-15m.mjs` | `npm run example:tv-15m` | TradingView-style history (`from` / `to` / `countback`) |
| `tick-bars-replay.mjs` | `npm run example:tick-bars` | Tick-bar history replay |
| `match-100t-chart.mjs` | `npm run example:match-100t` | 100-tick chart comparison |
| `compare-history.js` | — | `HistoryFetch.history` vs external JSON |
| `probe-tick-replay-modes.mjs` | — | Compare tick replay `countbackAnchor` modes |

## TradingView-style history (`test-tv-history-15m.mjs`)

Uses `ChartSession.loadHistory` + `HistoryQuery.barsToHistoryPayload({ compat: true })`.

```bash
npm run example:tv-15m
RITHMIC_COMPARE_API=1 npm run example:tv-15m   # diff vs localhost:3000/api/rithmic/history
RITHMIC_START_LIVE=1 npm run example:tv-15m    # stream closed bars
```

Env: `RITHMIC_COUNTBACK` (default `300`), `RITHMIC_TIME_RESOLUTION` (default `15`), `RITHMIC_FROM` / `RITHMIC_TO`.

## Tick history

`HistoryFetch.tickHistory()` / `ChartSession.loadTickHistory()` — see `match-100t-chart.mjs` and `tick-bars-replay.mjs`.

Optional: `RITHMIC_SYMBOL`, `RITHMIC_EXCHANGE`, `RITHMIC_GATEWAY`.
