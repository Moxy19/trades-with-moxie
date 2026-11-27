# Run the engine on GitHub (Actions) — live, free, no server

GitHub runs the engine for you on a schedule. Nothing to host yourself.

## One-time setup
1. **Create a new repo** (make it **Public** — Actions is then free & unlimited).
2. **Upload these files** to the repo root: `worker.js`, `package.json`, and the
   `.github/` folder (keep the path `.github/workflows/engine.yml`).
3. **Add the secret** — repo → Settings → Secrets and variables → Actions → *Secrets* → New:
   - `SUPABASE_SERVICE_ROLE_KEY` = your service_role key (Supabase → Project Settings → API)
   - `SUPABASE_URL` = `https://tefnlckonillljlttizy.supabase.co`
4. **Add variables** (same screen → *Variables* tab) — optional, these have defaults:
   - `DERIV_SYMBOLS` = `BOOM1000:Boom 1000,CRASH500:Crash 500,R_75:Volatility 75,R_100:Volatility 100`
   - `DERIV_APP_ID` = `1089`  ·  `TBS_MIN_SCORE` = `55`  ·  `TBS_CROSS_MODE` = `1`
5. Repo → **Actions** tab → enable workflows → open **TradesbySci engine** → **Run workflow**
   to start it immediately. After that it runs every 5 minutes on its own.

## Confirm it works
Open the latest run → the `node worker.js` step logs lines like
`...candidates=2 inserted=1 advanced=0 symbols=4`, and new rows appear in
`live_signals` → the Royal Trades terminal updates.

## Notes
- The code holds **no secrets** — safe in a public repo. Keys live only in GitHub Secrets.
- Each run scans ~every 20s for ~4.8 min, so coverage is effectively continuous.
- If a run fails with a Deriv connection error, GitHub's runner IP may be blocked by
  Deriv (rare); if so, use the VPS/Railway option in README.md instead — same code.
