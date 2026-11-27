# TradesbySci SMC — Deriv signal engine

Connects to Deriv over WebSocket, runs the EMA 9/21 + Smart Money Concepts logic
(BOS/CHoCH, order blocks, FVG, liquidity sweeps) with a 1H/2H/4H bias stack
anchored on the 3am/3pm hourly candle, and writes live BUY/SELL signals into your
Supabase `live_signals` table — which the Royal Trades terminal reads in realtime.

The EMA lines are the trigger; SMC adds confluence to the score; the new 1H candle
sets the hour's direction. Signals fire on 1m/2m/3m/5m.

## 1. Configure
Create a `.env` file in this folder with:
```
SUPABASE_URL=https://tefnlckonillljlttizy.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key   # Supabase → Project Settings → API → service_role (secret)
DERIV_APP_ID=1089
DERIV_SYMBOLS=BOOM1000:Boom 1000,CRASH500:Crash 500,R_75:Volatility 75,R_100:Volatility 100
TBS_MIN_SCORE=55
TBS_CROSS_MODE=1
POLL_MS=20000
```
Keep the service key private. (For GitHub Actions you set these in the repo instead — see GITHUB.md.)

## 2. Run it
Pick ONE host. All it needs is Node 18+ and the two env vars.

**A. Your own computer (quickest test)**
```
npm install
npm start
```
Signals go live whenever this is running. Leave the terminal open.

**B. A 24/7 container host (Railway / Render / Fly / any VPS with Docker)**
```
docker build -t tbs-engine .
docker run -d --env-file .env --restart unless-stopped tbs-engine
```
Or on Railway/Render: create a new service from this folder, set the env vars from
`.env.example` in their dashboard, and deploy. `npm start` is the start command.

**C. A plain VPS without Docker**
```
npm install
nohup node worker.js > engine.log 2>&1 &   # or run under pm2 / systemd
```

## 3. Confirm it's live
The console prints a line each cycle, e.g.
`2026-11-27T19:05:00Z candidates=2 inserted=1 advanced=0 symbols=4`
and new rows appear in `live_signals` → the terminal updates instantly.

## Tuning (all in .env)
- `DERIV_SYMBOLS` — add/remove pairs (Boom, Crash, Volatility 10/25/50/75/100…).
- `TBS_MIN_SCORE` — raise for fewer/higher-quality signals, lower to catch more.
- `POLL_MS` — scan frequency (default 20s).
- `DERIV_APP_ID` — register your own at https://api.deriv.com for reliability.

Notes: read-only market data (no Deriv token or trading permission needed). The
engine never places trades — it only generates signals.
