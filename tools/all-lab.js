// Royal Trades all-strategies lab (24 Nov 2026).
// Every Deriv market (synthetics, metals, forex, BTC/USD, ETH/USD) through every strategy built so far, on one shared
// download of ~30,000 1m bars per market (about 21 days of synthetics, ~4 weeks of forex trading days).
// Fill rules: 1m bars decide fills; stop counts first when a stop and a target share a bar; no spread is charged.
// Engine strategies run through the real engine's backtest(). Results are saved per market in localStorage
// (resumable) and on window.__all as per-trade logs [fillTime, R, reachedTP1]. Usage: (0,eval)(src)({ m1Bars: 30000 })
(async (opts = {}) => {
  const M = window.MoxieEngine;
  if (!M) throw new Error('Royal Trades engine not loaded');
  const markets = opts.markets || M.DEFAULT_SYMBOLS.filter((x) => x.source !== 'mt5');
  const N1 = opts.m1Bars || 30000, KEY = opts.key || 'rt.all';
  const lab = (window.__all = JSON.parse(localStorage.getItem(KEY) || 'null') || { done: {}, err: {} });
  lab.fin = false; lab.started = Date.now();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(lab)); } catch (e) { lab.saveErr = String(e); } };
  const feed = new M.DerivFeed();
  await feed.connect();

  // ---------- helpers ----------
  const ema = (arr, n) => { const k = 2 / (n + 1); let e = null; return arr.map((v) => (e = e == null ? v : e + k * (v - e))); };
  const atrOf = (b, n = 14) => { let a = null; return b.map((x, i) => { const tr = i ? Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)) : x.h - x.l; return (a = a == null ? tr : (a * (n - 1) + tr) / n); }); };
  const lb = (arr, t) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].t < t) lo = m + 1; else hi = m; } return lo; };
  const pivots = (b, w) => {
    const H = [], L = [];
    for (let i = w; i < b.length - w; i++) {
      let ph = true, pl = true;
      for (let k = 1; k <= w; k++) {
        if (!(b[i].h > b[i - k].h && b[i].h >= b[i + k].h)) ph = false;
        if (!(b[i].l < b[i - k].l && b[i].l <= b[i + k].l)) pl = false;
      }
      if (ph) H.push({ i, p: b[i].h, conf: i + w });
      if (pl) L.push({ i, p: b[i].l, conf: i + w });
    }
    return { H, L };
  };

  // Simulates one order on 1m bars. o: { dir: 1|-1, kind: 'limit'|'market', entry, sl, tp1, tp2, start, expiry, cancel, maxHold }
  function sim(m1, o) {
    const risk = Math.abs(o.entry - o.sl);
    if (!(risk > 0)) return null;
    const r1 = Math.abs(o.tp1 - o.entry) / risk, r2 = Math.abs(o.tp2 - o.entry) / risk;
    const d = o.dir, maxHold = o.maxHold || 86400;
    let i = lb(m1, o.start), filled = o.kind === 'market', fillT = filled ? o.start : null, stage = 0, sl = o.sl;
    const res = (R, t1, how) => ({ R, r1, r2, t0: fillT, t1, how, dir: d, tp1: stage || how === 'TP2' ? 1 : 0 }) ;
    for (; i < m1.length; i++) {
      const b = m1[i];
      if (!filled) {
        if (b.t >= o.expiry) return null;
        if (o.cancel != null && (d > 0 ? b.h > o.cancel : b.l < o.cancel)) return null; // setup broken before the fill
        if (d > 0 ? b.l <= o.entry : b.h >= o.entry) {
          filled = true; fillT = b.t;
          if (d > 0 ? b.l <= sl : b.h >= sl) return res(-1, b.t + 60, 'SL');
        }
        continue;
      }
      if (b.t - fillT > maxHold) { const u = ((b.o - o.entry) * d) / risk; return res(stage ? 0.5 * r1 + 0.5 * u : u, b.t, 'TIME'); }
      if (stage === 0) {
        if (d > 0 ? b.l <= sl : b.h >= sl) return res(-1, b.t + 60, 'SL');
        if (d > 0 ? b.h >= o.tp1 : b.l <= o.tp1) {
          stage = 1; sl = o.entry;
          if (d > 0 ? b.h >= o.tp2 : b.l <= o.tp2) return res(0.5 * r1 + 0.5 * r2, b.t + 60, 'TP2');
        }
      } else {
        if (d > 0 ? b.l <= sl : b.h >= sl) return res(0.5 * r1, b.t + 60, 'BE');
        if (d > 0 ? b.h >= o.tp2 : b.l <= o.tp2) return res(0.5 * r1 + 0.5 * r2, b.t + 60, 'TP2');
      }
    }
    if (!filled) return null;
    const last = m1[m1.length - 1], u = ((last.c - o.entry) * d) / risk;
    return res(stage ? 0.5 * r1 + 0.5 * Math.max(u, 0) : u, last.t + 60, 'OPEN');
  }

  const pack = (trades) => trades.map((x) => [x.t0, +x.R.toFixed(3), x.tp1 ? 1 : 0]);

  for (const mk of markets) {
    const sym = mk.symbol;
    if (lab.done[sym]) continue;
    lab.progress = sym;
    try {
      // ---------- data (fetched once, shared by every strategy) ----------
      const raw1 = await feed.candlesBack(sym, 60, N1);
      if (!raw1.candles.length) throw new Error('no data');
      const m1 = raw1.candles.map(M.toBar);
      const nowT = m1[m1.length - 1].t + 60;
      const m5 = M.aggCandles(raw1.candles, 300).map(M.toBar).filter((x) => x.t + 300 <= nowT);
      const m15 = (await feed.candles(sym, 900, 2000)).candles.map(M.toBar).filter((x) => x.t + 900 <= nowT);
      const h1 = (await feed.candles(sym, 3600, 1500)).candles.map(M.toBar).filter((x) => x.t + 3600 <= nowT);
      const winStart = m1[0].t + 6 * 3600; // decisions only inside the 1m window, after a 6h buffer
      const days = (nowT - winStart) / 86400;

      // indicators
      const c15 = m15.map((x) => x.c), e15 = { 8: ema(c15, 8), 9: ema(c15, 9), 21: ema(c15, 21), 50: ema(c15, 50), 100: ema(c15, 100), 200: ema(c15, 200) };
      const atr15 = atrOf(m15);
      const c1h = h1.map((x) => x.c), e1h50 = ema(c1h, 50);
      const trend1h = (T) => { // last closed 1H bar at time T
        const j = lb(h1, T - 3600 + 1) - 1; if (j < 53) return 0;
        const k = Math.min(j, h1.length - 1);
        if (h1[k].c > e1h50[k] && e1h50[k] > e1h50[k - 3]) return 1;
        if (h1[k].c < e1h50[k] && e1h50[k] < e1h50[k - 3]) return -1;
        return 0;
      };
      const pv = pivots(m15, 3);
      const res = {};

      // ---------- 1) engine strategies: ORB+ variants and the Royal Ladder ----------
      {
        const memo = {};
        const cache = { candlesBack: async () => raw1, candles: (s, g, c, e) => (memo[g + ':' + c + ':' + e] = memo[g + ':' + c + ':' + e] || feed.candles(s, g, c, e)) };
        const off = { beAtR: 0, beLockR: 0, tp1Lock: 0, softStop: null, dyn: null, trail: { mode: 'off' } };
        const V = {
          'ORB+ v1.10 (as live)': {},
          'ORB+ v1.10, every market': { orbOff: [] },
          'ORB+ More signals': Object.assign({}, M.MANAGEMENT.volume, { orbOff: [] }),
          'ORB+ classic (TP1 half, BE, TP2)': Object.assign({ orbOff: [], minOrAtr: 0, maxOrAtr: 1.5, hours: null }, off),
          'Royal Ladder': { orbOff: [sym], ladderOff: [], ladder: Object.assign({}, M.DEFAULTS.ladder, { on: true, markets: ['synthetic', 'forex', 'crypto'] }) },
        };
        for (const [nm, cfg] of Object.entries(V)) {
          lab.progress = sym + ' ' + nm;
          const bt = await M.backtest(cache, Object.assign({}, mk, { source: 'deriv' }), Math.ceil(N1 / 1440), Object.assign({}, M.DEFAULTS, cfg));
          res[nm] = bt.signals.filter((x) => x.result != null && x.filledAt).map((x) => [x.filledAt, x.result, x.tp1At ? 1 : 0]);
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      // the 15m loop shared by the 15m strategies
      const i0 = Math.max(lb(m15, winStart), 210);
      const busy = {};
      const tradesOf = {};
      const take = (name, o) => {
        if ((busy[name] || 0) > o.start) return;
        const r = sim(m1, o);
        if (!r) return;
        (tradesOf[name] = tradesOf[name] || []).push(r);
        busy[name] = r.t1;
      };

      let usedPB = new Set(), usedSw = new Set();
      for (let i = i0; i < m15.length; i++) {
        const b = m15[i], T = b.t + 900, atr = atr15[i], tr = trend1h(T);
        if (!tr || !(atr > 0)) continue;
        const side15 = b.c > e15[50][i] ? 1 : b.c < e15[50][i] ? -1 : 0;

        // latest confirmed pivots at this bar
        const Hs = pv.H.filter((p) => p.conf <= i), Ls = pv.L.filter((p) => p.conf <= i);
        const H = Hs[Hs.length - 1], L = Ls[Ls.length - 1];

        // ---------- 2) & 3) Fib pullback: impulse leg in the 1H direction, limit in the 38.2–23.6 zone ----------
        if (H && L && side15 === tr) {
          const up = tr > 0;
          const a = up ? L : H, z = up ? H : L; // swing start -> swing end
          const justConfirmed = z.conf === i;
          const rg = Math.abs(z.p - a.p);
          if (justConfirmed && a.i < z.i && rg >= 1.5 * atr15[z.i] && !usedPB.has(z.i)) {
            usedPB.add(z.i);
            const d = up ? 1 : -1;
            let touched = false; for (let k = z.i + 1; k <= i; k++) if (up ? m15[k].l <= z.p - 0.309 * rg : m15[k].h >= z.p + 0.309 * rg) touched = true;
            if (!touched) {
              // "shallow" reads the zone as 23.6–38.2 retracement from the swing end (TradingView default);
              // "deep" reads it with 0% at the swing start, i.e. 61.8–76.4 retracement, stop beyond the swing start.
              const entry = z.p - d * 0.309 * rg, tp1 = z.p, tp2 = a.p + d * 1.272 * rg;
              const base = { dir: d, kind: 'limit', entry, tp1, tp2, start: T, expiry: T + 16 * 900, cancel: z.p };
              take('Fib pullback shallow, SL 61.8', Object.assign({}, base, { sl: z.p - d * 0.618 * rg - d * 0.1 * atr }));
              take('Fib pullback shallow, SL 78.6', Object.assign({}, base, { sl: z.p - d * 0.786 * rg - d * 0.1 * atr }));
              take('Fib pullback deep', Object.assign({}, base, { entry: z.p - d * 0.691 * rg, sl: a.p - d * 0.1 * atr }));
            }
          }
        }

        // ---------- 4) EMA 9/21 cross + Fib filter (the MQL5 EA logic) ----------
        {
          const f = e15[9], s = e15[21];
          const crossUp = f[i - 1] <= s[i - 1] && f[i] > s[i], crossDn = f[i - 1] >= s[i - 1] && f[i] < s[i];
          const d = crossUp ? 1 : crossDn ? -1 : 0;
          if (d && d === tr && H && L) {
            const lo = Math.min(H.p, L.p), hi = Math.max(H.p, L.p), rg = hi - lo;
            const retr = d > 0 ? (hi - b.c) / rg : (b.c - lo) / rg; // how deep the pullback went into the last swing
            if (rg > 0 && retr >= 0.236 && retr <= 0.786) {
              let ext = d > 0 ? Infinity : -Infinity; for (let k = i - 5; k <= i; k++) ext = d > 0 ? Math.min(ext, m15[k].l) : Math.max(ext, m15[k].h);
              let sl = ext - d * 0.1 * atr, risk = Math.abs(b.c - sl);
              if (risk < 0.5 * atr) { risk = 0.5 * atr; sl = b.c - d * risk; }
              if (risk <= 2.5 * atr) take('EMA cross + Fib', { dir: d, kind: 'market', entry: b.c, sl, tp1: b.c + d * 1.5 * risk, tp2: b.c + d * 3 * risk, start: T, expiry: T + 60 });
            }
          }
        }

        // ---------- 5) EMA layers: stacked 8/21/50/100/200, pullback touch of the 21 with a rejection close ----------
        {
          const E = e15, d = tr;
          const stacked = d > 0 ? E[8][i] > E[21][i] && E[21][i] > E[50][i] && E[50][i] > E[100][i] && E[100][i] > E[200][i]
            : E[8][i] < E[21][i] && E[21][i] < E[50][i] && E[50][i] < E[100][i] && E[100][i] < E[200][i];
          const touch = d > 0 ? b.l <= E[21][i] && b.c > E[21][i] && b.c > b.o : b.h >= E[21][i] && b.c < E[21][i] && b.c < b.o;
          if (stacked && touch) {
            let sl = E[50][i] - d * 0.3 * atr, risk = Math.abs(b.c - sl);
            if (risk < 0.5 * atr) { risk = 0.5 * atr; sl = b.c - d * risk; }
            if (risk <= 2.5 * atr) take('EMA layers', { dir: d, kind: 'market', entry: b.c, sl, tp1: b.c + d * 1.5 * risk, tp2: b.c + d * 3 * risk, start: T, expiry: T + 60 });
          }
        }
      }

      // ---------- 6) Fib sweep reversal: price sweeps past the 100% of a counter-trend leg, 5m rejection, enter the 38.2–23.6 of the bounce ----------
      {
        const j0 = lb(m5, winStart);
        for (let j = j0; j < m5.length; j++) {
          const b = m5[j], T = b.t + 300, tr = trend1h(T);
          if (!tr) continue;
          const i = lb(m15, T - 900 + 1) - 1; if (i < 210) continue; // last closed 15m bar
          const atr = atr15[i];
          const Hs = pv.H.filter((p) => p.conf <= i), Ls = pv.L.filter((p) => p.conf <= i);
          const H = Hs[Hs.length - 1], L = Ls[Ls.length - 1];
          if (!H || !L) continue;
          // counter-trend leg: for a SELL (1H down) an up-leg L->H; for a BUY (1H up) a down-leg H->L
          const sell = tr < 0;
          const a = sell ? L : H, z = sell ? H : L;
          if (!(a.i < z.i)) continue;
          const key = z.i;
          if (usedSw.has(key)) continue;
          // did price sweep beyond z (100%) after it was confirmed, and is this 5m bar a close back inside?
          const zT = m15[z.conf].t + 900;
          if (b.t < zT) continue;
          const k0 = lb(m5, zT);
          let S = null;
          for (let k = k0; k < j; k++) { const x = m5[k]; if (sell ? x.h > z.p : x.l < z.p) S = S == null ? (sell ? x.h : x.l) : sell ? Math.max(S, x.h) : Math.min(S, x.l); }
          if (S == null) continue;
          const back = sell ? b.c < z.p : b.c > z.p;
          if (!back) continue;
          usedSw.add(key);
          let B = sell ? Infinity : -Infinity; for (let k = k0; k <= j; k++) B = sell ? Math.min(B, m5[k].l) : Math.max(B, m5[k].h);
          if (sell ? B >= S : B <= S) continue;
          const d = sell ? -1 : 1;
          const sl = S - d * 0.1 * atr;
          // main-swing targets with 0% at the swing start: TP1 = the 61.8 level, TP2 = the 38.2 level
          const tp1 = a.p + 0.618 * (z.p - a.p), tp2 = a.p + 0.382 * (z.p - a.p);
          // the bounce leg runs S (sweep extreme) -> B; "deep" = 23.6–38.2 measured from S, "shallow" = measured from B
          for (const [nm, entry] of [['Fib sweep reversal, deep entry', S + 0.309 * (B - S)], ['Fib sweep reversal, shallow entry', B + 0.309 * (S - B)]]) {
            const risk = Math.abs(entry - sl);
            if (!(risk > 0) || (tp1 - entry) * d < 0.5 * risk) continue;
            take(nm, { dir: d, kind: 'limit', entry, sl, tp1, tp2, start: T, expiry: T + 12 * 300, cancel: S });
          }
        }
      }

      for (const [name, tr] of Object.entries(tradesOf)) res[name] = pack(tr);
      lab.done[sym] = { name: mk.name, market: mk.market, from: winStart, to: nowT, days: +days.toFixed(1), res };
    } catch (e) {
      lab.err[sym] = String((e && e.message) || e);
    }
    save();
  }
  try { feed.ws.onclose = null; feed.ws.close(); } catch (e) {}
  lab.fin = true; lab.progress = 'finished'; save();
  return 'done';
});
