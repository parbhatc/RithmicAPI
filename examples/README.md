# Examples

Requires `.env` with at least `RITHMIC_USER`, `RITHMIC_PASSWORD`. Optional: `RITHMIC_SYSTEM`, `RITHMIC_SYMBOL`, `RITHMIC_EXCHANGE`, `RITHMIC_GATEWAY`, `RITHMIC_COUNTBACK`, `RITHMIC_RESOLUTION`.

Run with:

```bash
node --env-file=.env examples/discover.mjs
```

| Script | npm script | What it tests |
|--------|------------|----------------|
| `discover.mjs` | `npm run example:discover` | Gateway discovery |
| `chartHistory.mjs` | `npm run example:history` | `ChartSession` + `planets.history.load` |
| `chartLive.mjs` | `npm run example:live` | Live trade/quote/bar events |
| `chartTickHistory.mjs` | `npm run example:tick` | Tick-bar replay |
| `historyFetch.mjs` | `npm run example:fetch` | One-shot `HistoryFetch` |
| `orderSession.mjs` | `npm run example:order` | Order plant accounts/routes |
| `pnlSession.mjs` | `npm run example:pnl` | PnL snapshot |
