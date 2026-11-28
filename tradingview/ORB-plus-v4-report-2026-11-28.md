# ORB+ v4 (Pine v6): changes and test results, 28 Nov 2026

Educational tool only, not financial advice. Times are SAST (UTC+2).

The script was saved in place as **ORB+ v2** on TradingView (version 13) and is on the Step Index chart.
- Original source backup: `ORB-plus-v2-original-backup-2026-11-28.pine` (byte-for-byte copy). To restore it, paste it into the Pine Editor and save.
- New source: `ORB-plus-v4-pine6.pine`.

## What changed
1. **Pine v6 rebuild.** The script is still named ORB+ and still has the same green/red look.
2. **O'clock opening ranges on 11 timeframes**: 1m, 2m, 3m, 5m, 10m, 15m, 30m, 45m, 1H, 2H and 4H, each one switchable. For each period the opening range is the first 5m candle (the first 1m candle for the 2m–5m periods), taken with `request.security`.
   - The candle's colour gives an early bias, shown as "buy (candle)".
   - Breaking its high or low confirms BUY or SELL for the rest of the period. A wick counts as a break, or you can switch that to needing a close.
   - Higher timeframes carry more weight in the **Overall** score (weights are adjustable).
3. **Dashboard** (top right, small): one row per timeframe showing the bias, the trend arrow and the time left in the period, plus Overall, ALIGNED (4H, 2H and 1H agree) and the golden-rule status.
4. **Trend detection**: a buy or sell trend starts when the 21 EMA turns. It also starts on a **break of structure**, or on an **early reversal**: a strong candle that engulfs the last one right off a fresh high or low. The early reversal rule is new today, and it is what catches the Friday 08:00 sell on the 2H.
5. **Spikes**: a candle whose body is at least 2× the average body, or whose range is at least 1.5× ATR. Only the first candle of the move is marked. 1m data adds the minute the move started to the tooltip. While a spike candle is still forming, an "early spike" alert fires.
6. **Pullback re-entries** for buys and sells: a 30–60% retrace, a touch of the 9/21 EMA, or a retest of the broken level, followed by the first candle that closes back with the trend. These are numbered Add 2, Add 3 and so on, up to a maximum of 5 (adjustable). The suggested stop is in the tooltip and can also be drawn as a line.
7. **Invalidation**: a trend ends when the last swing breaks. This can optionally be marked with a small ×.
8. **Golden rule filter** (charts below 1H): signals against the 1H bias are hidden. A spike candle overrides the filter for its own candle, which is the "absolutely sure" case. Without that override the V90 11:20 drop was blocked.
9. **Clean look** (you asked for this): only small **B / S** labels are shown.
   - Full-size B/S = trend start, or an aligned signal.
   - Lighter, smaller B/S = re-entry or spike.
   - Hover a label to see what it is and its stop.
   - Faint dotted 1H range in green (high) and red (low), like the original.
10. **Your 6 EMAs (9/21/50/100/150/200) are built in.** Your Basic plan only allows 2 indicators, so I removed the public "6 EMA" script from the chart. It can be re-added any time. The TradesbySci strategy stayed on the chart, because its source can't be recovered if it is removed.
11. **Alerts**: trend start buy/sell, re-entry buy/sell, spike buy/sell, trend invalid, aligned buy/sell, and a bias change for each timeframe. There is also one detailed "Any alert() function call" alert.

### Filters removed or loosened (from the old ORB+ v2)
- **The 15m swing-flip gate is gone.** The old version only flipped B/S on a 15m SuperTrend flip or on the single 09:00–09:15 New York range.
- **The single NY session range is gone.** Every period's o'clock candle now counts.
- **The grade "X (against 1H)" no longer hides signals.** The golden rule now blocks only below 1H, and spikes override it.
- **No cooldowns, RSI filters or retest requirements.** The old script had none either, apart from the stop-and-reverse rule that allowed only one signal per direction.

## Test cases
| Test | Result |
|---|---|
| Step 2H, Wed 25 Nov sell from 08:00 | **Early.** S spike on the 08:00 candle, trend start at 10:00, re-entry sells at 12:00 and 18:00 |
| Step 2H, Thu 26 18:00 to Fri 27 06:00 buy | **Early.** Trend start B on the 18:00 candle, re-entry B's at 20:00, 22:00, 00:00, 04:00 and 06:00 |
| Step 2H, Fri 27 08:00–22:00 sell | **Fixed.** Before: first S at 20:00, which was late. Now: S on the 08:00 candle, then re-entry sells at 10:00, 12:00, 14:00, 16:00, 20:00 and 22:00 |
| Step 5m, ~08:55 buy with a pullback (28 Nov) | **Caught.** Re-entry B's at 08:40, 08:45, **08:55** (plus a spike) and 09:05. The 08:35 trend start itself was hidden by the 1H golden rule |
| V90 5m, ~11:15 spike sell (28 Nov) | **Caught at the start** after the fix: S on the 11:20 candle, the first big red candle of the drop. Before, it was blocked by the 1H buy bias |

Screenshots are in `screens/`. The original ORB+ wasn't on the chart before today, so the "before" shots show the first v4 build.

## Last week (21–28 Nov)
How these were scored: a signal is **correct** if price moves 1×ATR its way before 1×ATR against it, within 6 bars on the 2H or 12 bars (3h) on the 15m. A signal is **late** if price had already moved 2×ATR its way over the 3 bars before it. A big move (4×ATR) is **missed** if no same-direction signal came near its start.

| Chart | Signals | Correct | Wrong (false) | Late | Big moves | Missed |
|---|---|---|---|---|---|---|
| Step 2H | 37 | 25 (69%) | 11 | 5 | 1 | 0 |
| V90 2H | 42 | 20 (51%) | 19 | 5 | 0 | 0 |
| Step 15m | 324 | 134 (42%) | 188 | 32 | 15 | 1 |
| V90 15m | 308 | 146 (48%) | 157 | 39 | 19 | 2 |

**Honest read:** it now catches almost every big move, which was the brief. But on the 15m, most signals are roughly a coin flip at 1:1. The 2H on Step Index is the strongest. Trade the lower timeframes only in the direction of the 2H/4H bias (the golden rule), and treat the small light B/S as optional adds.
