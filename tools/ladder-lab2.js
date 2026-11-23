// Royal Trades: Royal Ladder variants lab (setup timeframe, ATR timeframe, distance cap, 5m confirmation entry).
// Same rules as the live Ladder unless a parameter says otherwise. 1m bars decide fills; stop first on ties;
// position split equally across five TPs; stop to entry after TP2.
// Params: tf (setup swing timeframe, 900 or 300), atrTf (ATR timeframe), unit (fixed price units instead of ATR),
// maxAway (skip when price is more than this many ATRs from the level; 0 = off),
// confirm (1 = after price touches the level, wait for a 5m candle to close back in the trade direction and enter at its close).
// Pass raw (candlesBack result) and h1 (bars) to reuse downloaded data.
(async (cfg = {}) => {
  const M = window.MoxieEngine;
  const P = Object.assign({ tf: 900, atrTf: 900, w: 5, front: 0.41, sl: 1.63, tps: [0.54, 1.09, 1.76, 2.44, 3.80], beAt: 2, expH: 4, holdH: 24, away: 0.41, maxAway: 0, confirm: 0, m1Bars: 20000 }, cfg);
  let raw = cfg.raw, h1 = cfg.h1;
  if (!raw) {
    const feed = new M.DerivFeed(); await feed.connect();
    raw = await feed.candlesBack(P.symbol, 60, P.m1Bars);
    h1 = (await feed.candles(P.symbol, 3600, 2000)).candles.map(M.toBar);
    try { feed.ws.onclose = null; feed.ws.close(); } catch (e) {}
  }
  const lb = (a, t) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m].t < t) lo = m + 1; else hi = m; } return lo; };
  const closedAt = (arr, g, T) => lb(arr, T - g + 1) - 1; // index of the last bar closed by time T
  const ema = (a, n) => { const k = 2 / (n + 1); let e = null; return a.map((v) => (e = e == null ? v : e + k * (v - e))); };
  const wilder = (b) => { let a = null; return b.map((x, i) => { const tr = i ? Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)) : x.h - x.l; return (a = a == null ? tr : (a * 13 + tr) / 14); }); };
  const m1 = raw.candles.map(M.toBar);
  const agg = (g) => M.aggCandles(raw.candles, g).map(M.toBar);
  const B = agg(P.tf), m15 = P.tf === 900 ? B : agg(900), m5 = P.tf === 300 ? B : agg(300), A = P.atrTf === P.tf ? B : P.atrTf === 900 ? m15 : m5;
  const atrA = wilder(A), e15 = ema(m15.map((x) => x.c), 50), e1h = ema(h1.map((x) => x.c), 50);
  const tr1h = (T) => { const j = closedAt(h1, 3600, T); if (j < 55) return 0; if (h1[j].c > e1h[j] && e1h[j] > e1h[j - 3]) return 1; if (h1[j].c < e1h[j] && e1h[j] < e1h[j - 3]) return -1; return 0; };
  const w = P.w, out = [], start = m1[0].t + 86400, endT = m1[m1.length - 1].t;
  let busy = 0, signals = 0, delays = 0;
  for (let i = Math.max(w, 60); i < B.length - w; i++) {
    for (const d of [1, -1]) {
      let ok = true;
      for (let k = 1; k <= w; k++) {
        if (d > 0) { if (!(B[i].l < B[i - k].l && B[i].l <= B[i + k].l)) ok = false; }
        else if (!(B[i].h > B[i - k].h && B[i].h >= B[i + k].h)) ok = false;
      }
      if (!ok) continue;
      const c = i + w, T = B[c].t + P.tf;
      if (T < start || T < busy || T > endT) continue;
      const ia = closedAt(A, P.atrTf, T), i15 = closedAt(m15, 900, T);
      if (ia < 20 || i15 < 60) continue;
      const atr = P.unit || atrA[ia], lvl = d > 0 ? B[i].l : B[i].h, px = B[c].c;
      if ((px - lvl) * d < P.away * atr) continue;
      if (P.maxAway && (px - lvl) * d > P.maxAway * atr) continue;
      const tr = tr1h(T);
      if (tr === -d) continue;
      if ((m15[i15].c - e15[i15]) * d < 0) continue;
      signals++; delays += T - B[i].t;
      const E = lvl + d * P.front * atr, SL = E - d * P.sl * atr, TPs = P.tps.map((x) => E + d * x * atr);
      const exp = T + P.expH * 3600;
      // ---- entry ----
      let j = lb(m1, T), entry = null, fillT = null;
      if (!P.confirm) {
        for (; j < m1.length; j++) {
          const b = m1[j];
          if (b.t >= exp) break;
          if (d > 0 ? b.l <= E : b.h >= E) { entry = E; fillT = b.t; break; }
        }
      } else {
        let touchT = null;
        for (; j < m1.length; j++) { const b = m1[j]; if (b.t >= exp) break; if (d > 0 ? b.l <= E : b.h >= E) { touchT = b.t; break; } }
        if (touchT != null) {
          for (let k = lb(m5, Math.floor(touchT / 300) * 300); k < m5.length; k++) {
            const x = m5[k];
            if (x.t + 300 > exp) break;
            if (d > 0 ? x.l <= SL : x.h >= SL) break;                                         // stop level reached before confirmation: no trade
            if (d > 0 ? x.c > x.o && x.c > E : x.c < x.o && x.c < E) { entry = x.c; fillT = x.t + 300; break; }
          }
        }
      }
      if (entry == null) continue;
      const risk = Math.abs(entry - SL);
      if (risk > 1.5 * P.sl * atr || (TPs[0] - entry) * d <= 0) continue;              // confirmation came too late
      // ---- management ----
      let stage = 0, sl = SL, res = null, k = lb(m1, fillT);
      if (!P.confirm) { const b = m1[k]; if (b && (d > 0 ? b.l <= sl : b.h >= sl)) res = 'SL'; k++; }
      for (; !res && k < m1.length; k++) {
        const b = m1[k];
        if (b.t - fillT > P.holdH * 3600) { res = 'TIME'; break; }
        if (d > 0 ? b.l <= sl : b.h >= sl) { res = stage >= P.beAt ? 'BE' : 'SL'; break; }
        while (stage < TPs.length && (d > 0 ? b.h >= TPs[stage] : b.l <= TPs[stage])) { stage++; if (stage === P.beAt) sl = entry; }
        if (stage === TPs.length) { res = 'ALL'; break; }
      }
      const last = m1[Math.min(k, m1.length - 1)], n = TPs.length;
      let R = 0;
      for (let s = 0; s < stage; s++) R += ((TPs[s] - entry) * d / risk) / n;
      const rem = (n - stage) / n;
      if (res === 'SL' || res === 'BE') R += ((sl - entry) * d / risk) * rem; // sl is the entry only once TP2 has moved it
      else R += ((last.c - entry) * d / risk) * rem;
      out.push({ t: fillT, d, stage, res, R, wait: fillT - T });
      busy = last.t + 60;
    }
  }
  const n = out.length, pct = (f) => (n ? Math.round((100 * out.filter(f).length) / n) : 0);
  const R = out.reduce((s, x) => s + x.R, 0), gw = out.filter((x) => x.R > 0).reduce((s, x) => s + x.R, 0), gl = -out.filter((x) => x.R < 0).reduce((s, x) => s + x.R, 0);
  const mid = (m1[0].t + endT) / 2, h = (o) => +o.reduce((s, x) => s + x.R, 0).toFixed(1);
  return {
    symbol: P.symbol, signals, n, fill: signals ? Math.round((100 * n) / signals) : 0, delayMin: signals ? Math.round(delays / signals / 60) : 0,
    waitMin: n ? Math.round(out.reduce((s, x) => s + x.wait, 0) / n / 60) : 0,
    tp1: pct((x) => x.stage >= 1), tp2: pct((x) => x.stage >= 2), tp3: pct((x) => x.stage >= 3), profit: pct((x) => x.R > 0.001), stop: pct((x) => x.res === 'SL'),
    R: +R.toFixed(1), avg: n ? +(R / n).toFixed(3) : 0, pf: gl ? +(gw / gl).toFixed(2) : 0, h1: h(out.filter((x) => x.t < mid)), h2: h(out.filter((x) => x.t >= mid)),
    days: +((endT - m1[0].t) / 86400).toFixed(1),
  };
});
