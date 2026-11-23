// Royal Trades: Royal Ladder backtest (the refined, decoded gold-signal strategy), on any Deriv market.
// Rules: 5-bar 15m swing points; trade only when the 1H trend is not against the trade and the 15m close is on the
// trade's side of the 15m EMA50; limit order set "front" before the swing level; SL, and five TPs at fixed ATR multiples
// (calibrated on gold: median 15m ATR $7.37, so $3/$12/$4/$8/$13/$18/$28 = 0.41/1.63/0.54/1.09/1.76/2.44/3.80 ATR);
// stop to breakeven after TP2; position split equally across the five TPs. 1m bars decide fills; stop first on ties.
// Usage: const r = await (0,eval)(src)({ symbol, m1Bars, ...overrides })  -> { s: summary, out: trades }
(async (cfg = {}) => {
  const M = window.MoxieEngine;
  const P = Object.assign({ w: 5, front: 0.41, sl: 1.63, tps: [0.54, 1.09, 1.76, 2.44, 3.80], beAt: 2, expH: 4, holdH: 24, away: 0.41, m1Bars: 20000 }, cfg);
  const feed = new M.DerivFeed();
  await feed.connect();
  const raw = await feed.candlesBack(P.symbol, 60, P.m1Bars);
  const h1 = (await feed.candles(P.symbol, 3600, 2000)).candles.map(M.toBar);
  try { feed.ws.onclose = null; feed.ws.close(); } catch (e) {}
  const m1 = raw.candles.map(M.toBar);
  const m15 = M.aggCandles(raw.candles, 900).map(M.toBar);
  const lb = (a, t) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m].t < t) lo = m + 1; else hi = m; } return lo; };
  const ema = (a, n) => { const k = 2 / (n + 1); let e = null; return a.map((v) => (e = e == null ? v : e + k * (v - e))); };
  const e1h = ema(h1.map((x) => x.c), 50), e15 = ema(m15.map((x) => x.c), 50);
  let a = null;
  const atr15 = m15.map((x, i) => { const tr = i ? Math.max(x.h - x.l, Math.abs(x.h - m15[i - 1].c), Math.abs(x.l - m15[i - 1].c)) : x.h - x.l; return (a = a == null ? tr : (a * 13 + tr) / 14); });
  const tr1h = (T) => { const j = lb(h1, T - 3600 + 1) - 1; if (j < 55) return 0; if (h1[j].c > e1h[j] && e1h[j] > e1h[j - 3]) return 1; if (h1[j].c < e1h[j] && e1h[j] < e1h[j - 3]) return -1; return 0; };
  const w = P.w, out = [], start = m1[0].t + 86400;
  let busy = 0;
  for (let i = Math.max(w, 60); i < m15.length - w; i++) {
    for (const d of [1, -1]) {
      let ok = true;
      for (let k = 1; k <= w; k++) {
        if (d > 0) { if (!(m15[i].l < m15[i - k].l && m15[i].l <= m15[i + k].l)) ok = false; }
        else if (!(m15[i].h > m15[i - k].h && m15[i].h >= m15[i + k].h)) ok = false;
      }
      if (!ok) continue;
      const c = i + w, T = m15[c].t + 900;
      if (T < start || T < busy || m15[c].t + 900 > m1[m1.length - 1].t) continue;
      const atr = atr15[c], lvl = d > 0 ? m15[i].l : m15[i].h, px = m15[c].c;
      if ((px - lvl) * d < P.away * atr) continue;               // price has left the level, so a limit makes sense
      const tr = tr1h(T);
      if (tr === -d) continue;                                     // never against the 1H
      if ((m15[c].c - e15[c]) * d < 0) continue;                   // 15m on the trade's side of its EMA50
      const E = lvl + d * P.front * atr, SL = E - d * P.sl * atr, TPs = P.tps.map((x) => E + d * x * atr);
      let j = lb(m1, T), fill = null, stage = 0, sl = SL, res = null;
      const exp = T + P.expH * 3600;
      for (; j < m1.length; j++) {
        const b = m1[j];
        if (fill == null) {
          if (b.t >= exp) break;
          if (d > 0 ? b.l <= E : b.h >= E) { fill = b.t; if (d > 0 ? b.l <= sl : b.h >= sl) { res = 'SL'; break; } }
          continue;
        }
        if (b.t - fill > P.holdH * 3600) { res = 'TIME'; break; }
        if (d > 0 ? b.l <= sl : b.h >= sl) { res = stage ? 'BE' : 'SL'; break; }
        while (stage < TPs.length && (d > 0 ? b.h >= TPs[stage] : b.l <= TPs[stage])) { stage++; if (stage === P.beAt) sl = E; }
        if (stage === TPs.length) { res = 'ALL'; break; }
      }
      if (fill == null) continue;
      const risk = P.sl * atr, last = m1[Math.min(j, m1.length - 1)], n = TPs.length;
      let R = 0;
      for (let s = 0; s < stage; s++) R += ((TPs[s] - E) * d / risk) / n;
      const rem = (n - stage) / n;
      if (res === 'SL') R -= rem; else if (res === 'BE') R += ((sl - E) * d / risk) * rem; else R += ((last.c - E) * d / risk) * rem;
      out.push({ t: fill, d, stage, res, R });
      busy = last.t + 60;
    }
  }
  const n = out.length, pct = (f) => (n ? Math.round((100 * out.filter(f).length) / n) : 0);
  const R = out.reduce((s, x) => s + x.R, 0);
  const gw = out.filter((x) => x.R > 0).reduce((s, x) => s + x.R, 0), gl = -out.filter((x) => x.R < 0).reduce((s, x) => s + x.R, 0);
  const mid = (m1[0].t + m1[m1.length - 1].t) / 2, h = (o) => o.reduce((s, x) => s + x.R, 0).toFixed(1);
  return {
    s: { symbol: P.symbol, n, tp1: pct((x) => x.stage >= 1), tp2: pct((x) => x.stage >= 2), tp3: pct((x) => x.stage >= 3), all: pct((x) => x.stage >= 5),
      profit: pct((x) => x.R > 0.001), stop: pct((x) => x.res === 'SL' && x.stage === 0), R: +R.toFixed(1), avg: n ? +(R / n).toFixed(3) : 0,
      pf: gl ? +(gw / gl).toFixed(2) : 0, h1: h(out.filter((x) => x.t < mid)), h2: h(out.filter((x) => x.t >= mid)),
      days: +((m1[m1.length - 1].t - m1[0].t) / 86400).toFixed(1) },
    out,
  };
});
