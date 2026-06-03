# Examples

Copy `.env.example` to `.env` and set `RITHMIC_USER` / `RITHMIC_PASSWORD`.

| Script | npm command | What it does |
|--------|-------------|--------------|
| `handshake.js` | `npm run example` | Discover systems / gateways |
| `gateway-session.js` | `npm run example:gateway` | Order-plant login burst |
| `time-bars-replay.js` | `npm run example:bars` | Raw `RequestTimeBarReplay` |
| `live-chart.js` | `npm run example:chart` | History + live quote/bar events |
| `test-get-bars.mjs` | `npm run example:test-bars` | `loadHistory` compat payload (no layer) |
| `test-forming-15m.mjs` | `npm run example:forming-15m` | **`CandleLayer`** — forming OHLC, any minute TF |
| `tick-bars-replay.mjs` | `npm run example:tick-bars` | Tick-bar history replay |
| `match-100t-chart.mjs` | `npm run example:match-100t` | 100-tick chart comparison |

## Forming candles (`test-forming-15m.mjs`)

Uses `CandleLayer` so refresh does not lag one candle behind and open-bucket OHLC matches the tape.

```bash
# Default: 15m with forming bar
npm run example:forming-15m

# 1m chart only
RITHMIC_TIME_RESOLUTION=1 npm run example:forming-15m

# Closed history only
RITHMIC_INCLUDE_FORMING=0 npm run example:forming-15m

# Live updates
RITHMIC_START_LIVE=1 npm run example:forming-15m
```

Optional: `RITHMIC_TIME_BAR_COUNT`, `RITHMIC_SYMBOL`, `RITHMIC_EXCHANGE`, `RITHMIC_GATEWAY`.
