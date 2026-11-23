# Royal Trades — ORB+ live signal terminal

A live signal platform in the style of Aurum Signals, built from scratch around a transparent, testable strategy engine. Aurum keeps its strategy hidden inside a private MT5 EA.

## What's inside

| Part | File | What it does |
|---|---|---|
| Engine | `engine/moxie-engine.js` | ORB+ strategy, multi-timeframe filters, grading, live trade capture, stats, and the Deriv and Weltrade feeds. Runs in the browser and in Node. |
| Terminal | `web/index.html` | Live signals, scanner, chart, performance, backtest, risk tools and settings |
| Single file | `dist/RoyalTrades.html` | Terminal with the engine built in. Open it in Chrome and it runs. |
| Server | `server/server.js` | 24/7 engine with SSE stream to the terminal, optional Telegram broadcast and an optional access key for members |

## How a signal is made

1. **Data:** 1m ticks stream from Deriv's public feed and from Weltrade's SyntX feed (bid prices). They are aggregated into 2m, 15m, 1H, 2H and 4H. Indicators use **closed bars only**, so nothing repaints.
2. **Opening range:** the high and low of the first 15 minutes of every hour.
   - **5m confirmation:** the last closed 5m candle must move with the trade (beyond the 5m EMA9), and an agreeing 5m trend adds +5 to the score.
3. **Trigger:** a 2m candle closes beyond the range edge by at least 15% of the range height. Each direction fires once per hour.
4. **Filters** (a setup must pass all of them):
   - **1H rule:** *strict* means only trades with the 1H trend. *Adaptive* (default) also allows counter-1H **scalps**, but only when the 1H trend is weak, the 15m is aligned, 1m momentum confirms and the 4H isn't against the trade. Scalps get tighter targets and need a higher score.
   - 15m aligned or neutral on the right side of its EMA21
   - 2H and 4H not both against the trade
   - **Chop filter** (optional; off by default because it removed more winners than losers in testing)
   - **Loss guard:** after an SL, the same direction on the same pair is blocked until a new hour *and* a fresh 15m swing confirms
   - The stop must fit within 1.8× the 15m ATR, with at least 1R of room to the nearest 1H swing
5. **Levels:** SL goes beyond the range midpoint or the recent 2m swing. TP1 is the measured move, clamped to 1.0–1.5R. TP2 is 2× the range, clamped to 1.8–3R. Half the position closes at TP1, the SL moves to entry, and the rest runs to TP2.
6. **Score** (0–100, from 4H, 2H, 1H, 15m, 1m, trigger candle, range quality and room) maps to **A+ / A / B**. Anything below the publish threshold is never shown.
7. **Trade capture:** every tick updates each open trade through PENDING, ACTIVE, TP1 (SL to BE), and then TP2, SL, BE or TIME EXIT, with best and worst excursion recorded in R.

## Measured results (real data, conservative fills)

Data: 13 Deriv markets (about 7 days) plus Weltrade FlipX-1, FlipX-2 and FlipX-4 (5–8 days), ending 22 Nov 2026. Each market's 1m history was replayed through the engine with no look-ahead. When TP and SL fall inside the same candle, the SL is counted first.

| | Signals | Win rate (TP1+) | Net | Profit factor |
|---|---|---|---|---|
| Aurum Signals, its last 59 closed (21–22 Nov, from its history tab) | 59 | 36% | about −5.7R | below 1 |
| Royal Trades, first draft | 118 | 45% | +3.4R | 1.05 |
| Royal Trades, final, strict 1H rule | 180 | 54% | +24.7R | 1.30 |
| Royal Trades, adaptive 1H rule | 187 | 54.5% | +29.0R | 1.34 |
| **Royal Trades v1.1 with 5m confirmation (default)**, 13 Deriv markets, 7 days to 22 Nov 18:00 | **136** | **60.3%** | **+32.6R** | **1.60** |

**Per market (backtests to 22 Nov 2026):**

| Market | Data | v1.0 (2m only) | v1.1 (with 5m) | Verdict |
|---|---|---|---|---|
| 12 Deriv markets | 7 days | 56.1% win, +17.5R | **60.0% win, +23.7R, PF 1.54** | Proven edge, so v1.1 applies |
| 14 Weltrade SyntX pairs (FlipX 1–5, FiboX, QuadX, PlusX, FX/SFX Vol, GainX, PainX) | 6.8 days | 43.2% win, −7.8R | 33.9% win, −27.9R | **No edge.** Runs on v1.0 rules, tagged 👑 Royalty |
| Step Index 100 | 30 days | 12 trades, 17% win, −7.1R | 11 trades, 18% win, −6.1R | **No edge.** Tagged 👑 Royalty |
| Step Index 200 | 30 days | 34% win, −7.3R | 46% win, +4.1R, positive in both halves | Small edge |

None of 12 variants tried on Weltrade held up across both halves of the week. FlipX-style pairs reverse direction by design, so breakouts there fail more often than they follow through.

**5m confirmation (v1.1):** a breakout only fires if the last closed 5m candle moves with the trade and sits beyond the 5m EMA9, and a 5m trend that agrees adds to the score. Same data, same week, against the 2m-only engine (56.7% win, +25.3R, PF 1.41): the win rate rose in both halves (50%→55% and 62%→65%). Other 5m designs tested worse: a strict 5m-trend filter gave 53.5% and +7.1R, and a 5m breakout trigger gave 48.8% and +11.5R.

- The final engine was positive in **both halves** of the period (it was tuned on the whole period, so this check is partial).
- The **loss guard** is the biggest single fix over Aurum. With it switched off, the result drops to about +5R.
- The adaptive 1H rule added 9 counter-1H scalps: 6 won, for +4.1R.
- Max drawdown was 7.2R. At 2% risk per trade, that's about a 14% dip, so size small accounts accordingly.
- Some pairs were poor for breakouts in this window, notably Volatility 100 and FlipX-2/4. Dropping pairs based on past results did **not** help in walk-forward tests, so the engine keeps scanning everything and lets the filters decide.
- One week is a small sample. Re-check in the Backtest tab regularly.

## Gold, forex and crypto (v1.3)

Royal Trades scans Deriv's gold, silver, ten forex pairs, BTC and ETH alongside the synthetics. Each market was replayed through the same engine over its last 7 trading days, ending 23 Nov 2026, with the stop counted first when TP and SL share a candle.

| Market | Trades | Win rate | Result | Tag |
|---|---|---|---|---|
| Gold (XAU/USD) | 24 | 63% | +8.6R | Standard |
| AUD/USD | 22 | 64% | +7.9R | Standard |
| EUR/JPY | 16 | 63% | +7.3R | Standard |
| Silver (XAG/USD) | 17 | 65% | +6.8R | Standard |
| GBP/USD | 16 | 69% | +4.2R | Standard |
| USD/CHF | 10 | 60% | +4.0R | Standard |
| GBP/JPY | 13 | 54% | +1.6R | Standard |
| BTC/USD | 8 | 50% | +0.2R | 👑 Royalty |
| ETH/USD | 7 | 43% | −0.5R | 👑 Royalty |
| USD/CAD | 10 | 40% | −3.0R | 👑 Royalty |
| USD/JPY | 8 | 25% | −3.1R | 👑 Royalty |
| EUR/USD | 12 | 42% | −3.4R | 👑 Royalty |
| NZD/USD | 12 | 33% | −4.3R | 👑 Royalty |
| EUR/GBP | 11 | 18% | −7.2R | 👑 Royalty |

**Royalty** is the name for the strategy as it runs on markets with no proven edge yet. Those signals still publish, carry a gold 👑 ROYALTY tag, and should be watched or traded at minimum size. Samples are small (7–24 trades per market) and the tags were chosen from this same week, so they will be re-checked as more data comes in. Forex and metals close at the weekend.

## Run it

**Quickest:** open `dist/RoyalTrades.html` in Chrome. The engine runs in the tab, and it captures live only while the tab is open.

**24/7 server** (Node 22+, no dependencies):

```bash
cd server
PORT=8080 node server.js
# optional:
ACCESS_KEY=members-only TREND_MODE=adaptive MIN_SCORE=62 \
TELEGRAM_BOT_TOKEN=123:abc TELEGRAM_CHAT_ID=-100123 node server.js
```

Open `http://your-server:8080`. The terminal detects the server and switches to server mode. You can host it on Render, Railway, Fly.io or any small VPS with Node 22.

## Weltrade pairs: the MT5 bridge

Weltrade doesn't offer a public price API. Its chart data is restricted to its own website, so the app doesn't scrape it. Instead, `mt5/RoyalTradesBridge.mq5` runs in **your own MT5 terminal**, logged into Weltrade, and posts prices to the server. This is the same bridge model Aurum uses ("MT5 BRIDGE · LAST RELAY"). The bridge only reads prices and never trades.

1. Start the server with a bridge secret, for example `BRIDGE_KEY=long-random-secret node server.js`.
2. In MT5 desktop (on a PC or VPS, not the phone app), go to Tools > Options > Expert Advisors, tick "Allow WebRequest" and add your server URL.
3. Copy the `.mq5` file into `MQL5/Experts`, compile it in MetaEditor and attach it to any one chart. Set ServerURL (`https://your-server/api/bridge`), BridgeKey and Symbols.
4. The bridge sends about 4 days of history per pair, then live bars every 2 seconds. Weltrade pairs appear in the terminal tagged MT5.

Check `/api/bridge/status` on the server to see what has arrived.

*Educational tool, not financial advice. Risk 1–2% per trade at most.*
