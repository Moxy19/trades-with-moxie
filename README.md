# Royal Trades — ORB+ live signal terminal

A live signal platform in the style of Aurum Signals, built from scratch around a transparent, testable strategy engine. Aurum keeps its strategy hidden inside a private MT5 EA.

## What's inside

| Part | File | What it does |
|---|---|---|
| Engine | `engine/moxie-engine.js` | ORB+ strategy, multi-timeframe filters, grading, live trade capture, stats, and the Deriv and Weltrade feeds. Runs in the browser and in Node. |
| Terminal | `web/index.html` | Live signals, scanner, chart, performance, backtest, risk tools and settings |
| Single file | `dist/RoyalTrades.html` | Terminal with the engine built in. Open it in Chrome and it runs. |
| Server | `server/server.js` | 24/7 engine with SSE stream to the terminal, optional Telegram broadcast, an optional access key for members, and the optional robot |
| Robot | `engine/royal-robot.js` | Places signals automatically: Paper, or a Deriv demo/real account through Deriv's API (Multipliers). Runs in the terminal's Robot tab or on the server. |
| MT5 robot | `mt5/RoyalTradesRobot.mq5` | Places signals on an MT5 account (Deriv MT5, Weltrade) with lot sizes, reading the server's `/api/robot/feed` |

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

## Royal Ladder (v1.4)

A second live strategy, decoded from a gold signal ("BUY 3612, limit 3609, SL 3600, TP 3616/3620/3625/3630/3640") and refined by backtest:

1. A fresh 15m swing point, confirmed by 5 candles on each side.
2. Never against the 1H trend, and the 15m closes on the trade's side of its EMA50.
3. A limit order placed just before the level (gold: $3), SL beyond it (gold: $12).
4. Five targets (gold: +$4, +$8, +$13, +$18, +$28). Close a fifth at each, and move the stop to entry after TP2.
5. Unfilled orders expire after 4 hours.

Gold uses those fixed dollar distances. Every other market uses the same distances as multiples of its 15m ATR (gold's median ATR is $7.37). It runs live on gold, silver, forex and crypto.

| Market group | Trades | TP1 hit | Closed in profit | Full stop | Result |
|---|---|---|---|---|---|
| Gold (fixed $, 41 days) | 48 | 85% | 75% | 15% | +12.5R |
| Gold, silver, forex, crypto (ATR, ~20 days) | 318 | 73% | 62% | 27% | +14.7R |
| Deriv synthetics (ATR, ~14 days, backtest only) | 214 | 77% | 62% | 22% | +12.3R |

The ladder loses on EUR/USD, USD/CHF, EUR/GBP and BTC/USD, and is flat on ETH/USD, so those carry the 👑 Royalty tag for this strategy.

## Stop-loss review and 5m entries (v1.5)

**Stop-loss lab, 23 Nov 2026.** 593 ORB+ trades (about 21 days of synthetics, 30 of forex and crypto) were replayed, and every stop-out was compared with the winners.

- Most stops are false breakouts: 70% hit within 30 minutes of entry, and 30% never moved more than 0.2R in profit.
- Losses cluster in places that can be avoided:
  - opening ranges wider than 1.5× the 15m ATR (38% win);
  - scores under 74;
  - forex and metals from 06:00 to 10:00 SAST, the London-open fakeouts (42% win, −9R);
  - six markets where ORB+ lost money in both halves of the data: NZD/USD, USD/CHF, EUR/USD, USD/JPY, Volatility 75 and Volatility 25 (1s).
- The Ladder lost in both halves on EUR/GBP and USD/CHF.

v1.5 filters all of these out. Replayed through the engine on the same data:

| Strategy | Version | Trades | Win | Stop-outs | Result |
|---|---|---|---|---|---|
| ORB+ | before | 593 | 51% | 48% | +57.8R |
| ORB+ | v1.5 | 405 | 56% | 44% | +86.0R |
| Ladder | before | 442 | 61% | 38% | +14.1R |
| Ladder | v1.5 | 368 | 63% | 36% | +33.6R |

Both halves of the data improved for both strategies.

**Ladder 5m confirmation (v1.5.1).** The Ladder now waits for price to reach the zone, then enters on the first 5m candle that closes back in the trade's direction. If price hits the stop first, the setup is cancelled. It also skips levels that are already more than 3 ATRs from price.

On gold, forex and crypto (engine replay, 13 markets):

| Entry | Trades | TP1 hit | Win | Stop-outs | Result |
|---|---|---|---|---|---|
| Limit at the level | 339 | 75% | 63% | 36% | +30.9R |
| 5m confirmation | 216 | 87% | 73% | 27% | +29.6R |

Finding setups on 5m swings instead of 15m made signals arrive about 70 minutes sooner, but each trade was less accurate. Measuring stops with the 5m ATR was worse. On synthetics, none of the Ladder versions made money, so it stays off there.

## Trade management for profit (v1.6)

The management lab (23 Nov 2026) used the v1.5.1 rules on all 24 markets, about 21 days of synthetics and 30 of forex and crypto. It replayed every option through the engine.

| Change | ORB+ result | Notes |
|---|---|---|
| v1.5.1 as shipped | +83.8R | 55% win, 44% stop-outs |
| **Stop to entry at +0.5R (now default)** | **+99.8R** | stop-outs fall to 25%; win rate shows 38% because breakeven exits don't count as wins; both halves better |
| Stop to entry at +0.7R, locking +0.2R | +85.8R | 65% win: the "High win rate" setting |
| Close 30% or 70% at TP1 | +83.9R / +83.8R | no real difference |
| Further or nearer TP2 | +83.0R / +64.3R | nearer is worse |
| 3h or 12h maximum hold | +85.2R / +84.1R | no real difference |

| Royal Ladder (gold, forex, crypto) | Result | Win rate |
|---|---|---|
| Stop to entry after TP2 (v1.5.1) | +27.8R | 72% |
| **Stop to entry after TP3 (now default)** | **+35.7R** | 64% |
| Stop to entry after TP1 ("High win rate") | +17.8R | 82% |

You can switch between "Max profit" and "High win rate" in Settings under "Trade management".

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

## Trailing stop after TP1 (v1.7)

Lab of 23 Nov 2026, 24 Deriv markets, v1.6 filters, pessimistic fills (stop first on ties), no spread modelled.

| ORB+ management | Trades | In profit | Full stops | Total R | 1st half | 2nd half |
|---|---|---|---|---|---|---|
| v1.6: stop to entry at +0.5R | 533 | 38% | 26% | +99.4R | 37.3 | 62.1 |
| Lock +0.1R at +0.5R, +0.3R at TP1, fixed TP2 | 532 | 74% | 26% | +101.0R | 41.3 | 59.8 |
| **v1.7 default:** same locks, then trail 20 pips (forex & metals) / 0.75× ATR (others), no fixed TP2 | 511 | 74% | 26% | **+112.5R** | 50.6 | 61.9 |
| Same, 0.75× ATR trail everywhere | 528 | 74% | 26% | +116.7R | 61.8 | 54.9 |

"Breakeven" is now a small win (+0.1R before TP1, at least +0.3R on the runner after TP1).
Royal Ladder keeps the stop-to-entry-after-TP3 rule: stepping the stop up behind every TP lifts its win rate to 86% but cuts it from +34.7R to +13.2R. That option is in Settings → Trade management → High win rate.

## Fewer full stop-outs (v1.8)

Stop-out lab of 24 Nov 2026: about 20 days of 1m Deriv data, 23 markets (Ladder: its 12 pairs), pessimistic fills, no spread.
A "full stop-out" is the original stop hit with the whole position still open.

| ORB+ | Trades | In profit | Full stops | Total R | 1st half | 2nd half |
|---|---|---|---|---|---|---|
| v1.7 | 512 | 74% | 26% | +111.5R | 49.6 | 61.9 |
| **v1.8:** lock +0.05R at +0.3R, cut on a 5m close 0.6R against | 668 | 79% | **9%** | +109.9R | 64.7 | 45.3 |
| SL = 50% of TP2 (1:2) | 526 | 74% | 26% | +99.6R | 53.1 | 46.5 |
| SL = 50% of TP1 | 499 | 71% | 29% | +102.8R | 68.1 | 34.8 |

| Royal Ladder | Trades | In profit | Full stops | Total R | 1st half | 2nd half |
|---|---|---|---|---|---|---|
| v1.7 (SL 1.63 ATR) | 223 | 63% | 15% | +34.7R | 17.0 | 17.7 |
| SL = 50% of TP3 (0.88 ATR) | 176 | 52% | 20% | +47.6R | 26.8 | 20.8 |
| **v1.8:** SL = 50% of TP3, cut on a 5m close 0.6R against | 180 | 47% | **10%** | **+41.1R** | 21.6 | 19.5 |
| SL = 50% of TP5 (1.90 ATR) | 218 | 66% | 13% | +29.0R | 15.3 | 13.7 |

Early cuts turn most would-be full stops into smaller losses (about −0.6R); the losing-trade count does not fall.
Gold lost money on the Ladder in every variant over this window (−5.9R in v1.8), so the gold Ladder is tagged Royalty.

## Dynamic stop (v1.9)

Dynamic-stop lab of 24 Nov 2026 (23 markets, ~20 days, on top of v1.8). Until TP1 the stop trails behind the best price,
but never past half of the TP1 distance.

| Trail distance | ORB+ wins | ORB+ full stops | ORB+ R | Ladder wins | Ladder full stops | Ladder R | All wins | All R |
|---|---|---|---|---|---|---|---|---|
| none (v1.8) | 79% | 9% | +106.3R | 46% | 11% | +40.4R | 72% | +146.7R |
| **1R (v1.9)** | 78% | **1%** | **+134.4R** | 45% | **1%** | +41.3R | 72% | **+175.7R** |
| 0.75R | 72% | 1% | +103.6R | 41% | 0% | +34.8R | 66% | +138.4R |
| 0.5R | 62% | 0% | +97.6R | 36% | 0% | +19.6R | 57% | +117.2R |
| 1R, cap kept for the whole trade | 78% | 1% | +132.5R | 51% | 1% | +34.7R | 73% | +167.2R |

The win rate shown in the app now counts trades closed in profit and splits it by strategy (ORB+ and Royal Ladder).

## v1.9.1: market clean-up and ORB+ headline

Same lab data as v1.9. Gold on the Royal Ladder (−5.0R) and USD/CAD on ORB+ (−2.3R) lost money in both halves, so both are off.

| | Trades | ORB+ wins | Ladder wins | All wins | Total R | 1st half | 2nd half |
|---|---|---|---|---|---|---|---|
| v1.9 | 971 | 78% | 45% | 72% | +175.7R | 94.2 | 81.5 |
| **v1.9.1** | 909 | 78% | 48% | 73% | **+183.0R** | 96.5 | 86.6 |

The headline win rate in the app is now ORB+ only; the Royal Ladder is shown beside it as the Royalty stream, with the overall figure.

## v1.10: regime filters, ORB+ only

The Royal Ladder is off. ORB+ now only signals when the opening range is compact (0.6–0.9× the 15m ATR) and inside the active
session (06:00–18:00 UTC, 08:00–20:00 SAST). The stop locks +0.05R once a trade is +0.15R in profit.

Tested on two separate windows of about 20 trading days each (the earlier window was not used to choose anything):

| ORB+ | Trades | In profit | Profit factor | Max drawdown | Net |
|---|---|---|---|---|---|
| Earlier window, no regime filter | 694 | 87% | 2.31 | 7.0R | +101.8R |
| **Earlier window, regime filter (unseen data)** | 210 | 87% | 2.80 | 3.7R | +43.8R |
| Recent window, regime filter | 165 | 93% | 6.23 | 2.2R | +56.3R |
| **Both windows, regime filter** | 375 | 89% | 3.85 | 3.7R | +100.1R |

Average win +0.40R, average loss −0.88R: most wins are the early profit lock, not TP1 (about 20% of trades reach TP1).
Adding a 4H-trend requirement looked better on the recent window but worse on the unseen one, so it is not used.

Entry lab (ICT order blocks, fair value gaps, OTE Fibonacci, OB+Fib confluence, S/R flips, liquidity sweeps; 23 markets, ~28 days):
TP1 was reached on 45–59% of trades at best, profit factor 1.1–1.5 overall (1.7–2.1 on forex for 5m-confirmed OB, FVG and S/R entries).
None beat ORB+ yet, so none are live.

## v1.11: Royal Ladder removed

All-strategies lab, 24 Nov 2026 (`tools/all-lab.js`): 23 Deriv markets, ~21 days of synthetics, BTC and ETH, ~31 days of gold, silver and forex, run on the v1.10 engine.
Stop first on ties, no spread.

| Strategy | Trades | Closed in profit | Reached TP1 | Net | Profit factor | Max DD |
|---|---|---|---|---|---|---|
| **ORB+ v1.10 (live)** | 167 | **92%** | 19% | **+55.1R** | **5.58** | 2.4R |
| ORB+ classic (half at TP1, stop to entry, TP2) | 525 | 52% | 52% | +67.1R | 1.27 | 15.8R |
| Royal Ladder | 390 | 40% | 73% | +35.5R | 1.26 | 18.1R |
| EMA 9/21 cross + Fib | 140 | 45% | 43% | +20.5R | 1.27 | 6.6R |
| EMA layers | 590 | 43% | 42% | +37.5R | 1.11 | 25.3R |

The Royal Ladder lost money on synthetics (−9.9R, PF 0.84) and on gold (18% wins, −5.0R), and closed only 40% of trades in profit overall.
It can't meet a 75% win-rate floor, so v1.11 removes it from the engine and the terminal, and drops its old trades from the stored record.
ORB+ signals are unchanged: replayed on the same data, v1.10 and v1.11 produce identical trades.
The lab's "Royal Ladder" variant needs the v1.10 engine (`git show 0f130f5:engine/moxie-engine.js`).

## 60-day fresh comparison (24 Nov 2026)

`tools/fresh-lab.js`: three back-to-back windows of about 20 trading days each (~62 days on synthetics and crypto,
~3 calendar months on forex), 23 Deriv markets, ORB+ only, stop first on ties, no spread. Window 3 (the oldest) was never
used to choose any setting.

| System | Trades | In profit | Profit factor | Max drawdown | Net | Window 3 alone |
|---|---|---|---|---|---|---|
| v1.2 (renamed to Royal Trades, original rules) | 1528 | 47% | 1.06 | 37.4R | +45.1R | 43%, PF 0.89, −30.2R |
| v1.2 entries + v1.10 trade management | 3747 | 86% | 1.92 | 10.4R | +422.7R | 84%, PF 1.71, +119.1R |
| **v1.10 / v1.11 (live)** | 537 | 88% | **3.51** | 3.1R | +145.0R | 84%, PF 3.05, 2.9R, +45.1R |
| v1.12 (24 Nov, switched off again in v1.12.1): v1.11 + late-entry filter (score 95+ with 2H and 4H aligned skipped) | 215 | 90% | **5.17** | 3.2R | +78.4R | 83%, PF 2.55, +18.5R |

v1.11.1 adds the drawdown size rule to the terminal: half size from 2R below the equity peak, quarter size from 3R,
full size again at a new high.

v1.12 turned the late-entry filter on in the live engine; v1.12.1 turns it off again (v1.11.1 entries, user's choice) (`skipLate: true`, set it to `false` to go back to v1.11.1 entries).

v1.13.1 (24 Nov) reverts v1.13 to the "More signals" preset (about 23 signals a day). v1.14 (24 Nov, user rule): no stop move or profit lock before TP1. The early +0.05R lock at +0.15R (`beAtR`/`beLockR`) and the pre-TP1 dynamic stop (`dyn`) are off; the stop moves to entry +0.3R only once TP1 is touched. The 5m soft stop (a loss cut) stays.
Over all 60 days it lifts the profit factor from 3.51 to 5.17 and the in-profit rate from 88% to 90%, with about 60% fewer
trades and less total R (+78.4R vs +145.0R). On the oldest window alone, which was never used to choose settings, it did
slightly worse than v1.11.1 (PF 2.55 vs 3.05), so watch the live record. The −2R / −3R size rule and the Ladder removal are unchanged.

## Royal Robot: automatic execution

Educational software, not financial advice. Automated trading can lose money fast. Run it in Paper mode or on a demo account first.

The robot takes the same signals the terminal shows and places the trades for you. It never invents its own trades.

**Where it runs**
- **Robot tab in the terminal.** Press START. It trades while the tab is open. The stop loss and take profit sit at the broker, so they still work if the tab closes. Early exits (profit lock, trailing, cutting early) only happen while the robot is running.
- **On the server (24/7).** `ROBOT_MODE=demo DERIV_APP_ID=... DERIV_TOKEN=... node server/server.js`. Status is at `/api/robot`. A real account needs `ROBOT_MODE=real ROBOT_REAL_CONFIRM=I_UNDERSTAND`. Settings go in `ROBOT_SETTINGS` as JSON, for example `{"riskPct":1,"maxOpen":2}`.
- **MT5 (lot sizes).** `mt5/RoyalTradesRobot.mq5` reads the server's `/api/robot/feed` and trades any MT5 account (Deriv MT5, Weltrade) with fixed lots or lots sized from % risk. Attach it to one chart and allow WebRequest to your server.

**Deriv connection.** Easiest: **Log in with Deriv** (OAuth with PKCE). The App ID `3533hZTM3TxsGSi8gV95I` ("Royal Trades Robot", OAuth, `trade` scope, redirect `https://moxy19.github.io/trades-with-moxie/`) is registered and built in. After that, users just sign in at Deriv, and the access token is kept for that browser session only. Deriv's guide prefers the token exchange from a server; if Deriv blocks it from the browser, paste a token instead. Or make an App ID and a Personal Access Token with the **trade** scope at [developers.deriv.com](https://developers.deriv.com). The robot exchanges the token for a one-time WebSocket address (`POST /trading/v1/options/accounts/{id}/otp`). It checks that the account type matches the mode: in demo mode it refuses a real account. The token is never logged or put in the robot's history. It is only kept in the browser if you tick "remember".

**How a trade is placed (Deriv).** Each signal becomes a MULTUP (buy) or MULTDOWN (sell) Multiplier contract:
- **Size.** Loss at the stop ≈ stake × multiplier × stop distance ÷ price. In "% risk" mode the robot picks the stake and multiplier so a stopped-out trade loses your chosen % (default 1%). Deriv's minimum stake is $1, so on small accounts it uses a lower multiplier. If even that would pass the cap (default 3%), it skips the trade.
- **Broker-side protection.** Stop loss = the money at risk. Take profit = TP1 for the first half.
- **Management.** At TP1 the first contract closes. The second contract follows the engine: its broker stop tightens as the engine's stop moves, and it closes when the engine closes the trade.
- **Fixed stake** mode is the Deriv version of a lot size.

**Safety limits** (all editable): the v1.11.1 drawdown rule on the robot's own results (half size from 2R below its peak, quarter from 3R), max 2 open trades, one per market, 8 trades a day, a 6% daily loss limit that counts open risk, a pause after 3 losses in a row, a $3 balance floor, a cap on stake per trade, and skips for signals older than 3 minutes or more than 0.3R past entry. Default filters: grades A+ and A, synthetics only, Royalty markets skipped. Per-pair settings: on/off, direction, stake and max trades a day.

**Tested** (`node test/robot.test.js`): sizing, every limit, Paper trading on the live engine path, and the Deriv client against a fake Deriv server. That covers the OTP exchange, the demo/real account check, proposal → buy → contract stream → sell, and the token never leaking. It has not yet run against Deriv's real servers, because this build environment can't reach them. The MT5 robot has not been compiled yet. Compile it in MetaEditor and run it on a demo account before relying on it.
