// Royal Trades: Weltrade SyntX scan.
// Runs inside a weltradecharts.com tab, where the chart's own price history is same-origin.
// Requests are paced (default 1.8s apart), and each pair needs 3 of them.
// Usage: (0,eval)(engineSrc); const r = await (0,eval)(thisSrc)({ symbols: [...] });
(async (opts = {}) => {
  const M = window.MoxieEngine;
  if (!M) throw new Error('Royal Trades engine not loaded');
  const syms = opts.symbols || ['FlipX-1', 'FlipX-2', 'FlipX-3', 'FlipX-4', 'FlipX-5', 'FiboX', 'PlusX-1', 'QuadX',
    'FX-Vol-20', 'FX-Vol-40', 'SFX-Vol-20', 'SFX-Vol-40', 'GainX-400', 'GainX-600', 'PainX-400', 'PainX-600'];
  const gap = opts.gap || 1800;
  const now = Math.floor(Date.now() / 1000);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const get = async (sym, res, limit) => {
    const r = await fetch(`/v1/charts/history?symbol=${encodeURIComponent(sym)}&to=${now}&resolution=${res}&limit=${limit}`);
    await sleep(gap);
    if (r.status === 429) throw new Error('rate-limited, slow down');
    const j = await r.json();
    return (j.data || []).map((x) => ({ epoch: x.t, open: +x.o, high: +x.h, low: +x.l, close: +x.c }));
  };
  const T = (t) => new Date(t * 1000).toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit' });
  const ema = (a, n) => { let e = null; const k = 2 / (n + 1); return a.map((v) => (e = e == null ? v : e + k * (v - e))); };
  const dirOf = (b) => {
    if (b.length < 22) return 'n/a';
    const a = b.map((x) => x.c), c = a[a.length - 1], e9 = ema(a, 9).pop(), e21 = ema(a, 21).pop();
    return c > e9 && e9 > e21 ? 'UP' : c < e9 && e9 < e21 ? 'DOWN' : 'MIXED';
  };
  const F = (p) => M.fmt(p, 2);
  const results = [];

  for (const sym of syms) {
    const row = { sym, name: sym.replace(/-/g, ' ') };
    try {
      const m1 = await get(sym, 1, 2000);
      const h1 = await get(sym, 60, 1500);
      const m15 = await get(sym, 15, 1500);
      if (m1.length < 400 || h1.length < 210) { row.err = 'not enough history'; results.push(row); continue; }

      const eng = new M.Engine(opts.cfg || {});
      eng.mode = 'backtest'; // bar extremes, stop counted first when TP and SL share a bar
      eng.addSymbol(sym, { name: row.name, source: 'mt5', decimals: 2 });
      const st = eng.sym[sym];
      const lastT = m1[m1.length - 1].epoch;
      const replayFrom = Math.floor((lastT - (opts.replayH || 8) * 3600) / 3600) * 3600;
      const before = (arr, g) => arr.filter((c) => c.epoch + g <= replayFrom);
      st.series[M.G.H4].seed(before(M.aggCandles(h1, M.G.H4), M.G.H4), false);
      st.series[M.G.H2].seed(before(M.aggCandles(h1, M.G.H2), M.G.H2), false);
      st.series[M.G.H1].seed(before(h1, M.G.H1), false);
      st.series[M.G.M15].seed(before(m15, M.G.M15), false);
      st.series[M.G.M5].seed(before(M.aggCandles(m1, M.G.M5), M.G.M5), false);
      st.ready = true;
      eng.cfg.signalsEnabledFrom = replayFrom + 3600; // let 1m/2m indicators warm up first
      const bars = m1.map(M.toBar);
      for (const b of bars) if (b.t >= replayFrom) eng.onBar(sym, b); // last bar is the forming one
      const px = bars[bars.length - 1].c;
      st.price = px;
      const snap = eng.snapshot(sym);
      row.px = px;
      row.trend = snap.trend;
      row.m2 = dirOf(st.series[M.G.M2].bars.slice(-60));
      row.m1 = dirOf(st.series[M.G.M1].bars.slice(-60));
      row.or = snap.or;
      row.look = snap.look;

      // signals: still open, or created in the last 3 hours
      row.signals = eng.signals.filter((s) => ['PENDING', 'ACTIVE', 'TP1_HIT'].includes(s.status) || s.createdAt >= now - 3 * 3600).map((s) =>
        `${s.dir} ${s.grade}(${s.score}) ${s.kind} ${s.status} @${T(s.createdAt)} E ${F(s.entry)} SL ${F(s.sl)} TP1 ${F(s.tp1)} TP2 ${F(s.tp2)}` +
        (s.result != null ? ` result ${s.result.toFixed(2)}R` : ` now ${(((px - s.entry) * (s.dir === 'BUY' ? 1 : -1)) / s.risk).toFixed(2)}R`));

      // Fibonacci swing on closed 15m bars, in the direction of the 1H bias (15m when 1H is flat)
      const b15 = st.series[M.G.M15].bars.slice(-(opts.swingBars || 24)); // last 6 hours of closed 15m bars
      const bias = snap.trend.H1 !== 'FLAT' ? snap.trend.H1 : snap.trend.M15;
      if (b15.length >= 20 && bias !== 'FLAT') {
        let hiI = 0, loI = 0;
        if (bias === 'UP') {
          b15.forEach((b, i) => { if (b.h >= b15[hiI].h) hiI = i; });
          loI = 0; for (let i = 0; i <= hiI; i++) if (b15[i].l <= b15[loI].l) loI = i;
        } else {
          b15.forEach((b, i) => { if (b.l <= b15[loI].l) loI = i; });
          hiI = 0; for (let i = 0; i <= loI; i++) if (b15[i].h >= b15[hiI].h) hiI = i;
        }
        const hi = b15[hiI].h, lo = b15[loI].l, rg = hi - lo;
        if (rg > 0) {
          const up = bias === 'UP';
          const lvl = (f) => (up ? hi - f * rg : lo + f * rg);
          const ext = (f) => (up ? lo + f * rg : hi - f * rg);
          row.fib = {
            dir: up ? 'BUY' : 'SELL', from: up ? lo : hi, fromT: T(up ? b15[loI].t : b15[hiI].t), to: up ? hi : lo,
            l236: lvl(0.236), l382: lvl(0.382), l50: lvl(0.5), l618: lvl(0.618), l786: lvl(0.786), e127: ext(1.272), e162: ext(1.618),
            retr: Math.round(((up ? hi - px : px - lo) / rg) * 100),
          };
        }
      }

      // ORB plan (same sizing as the Deriv scan) when the range is locked and the 1H trend allows a break
      const cfg = eng._cfgFor(st);
      const want = /Watching for (BUY|SELL) break/.exec(snap.look);
      if (want && snap.or && snap.or.done && !snap.open) {
        const dir = want[1], b = st.series[M.G.M15].bars.slice(-40);
        let atr = null;
        for (let i = 1; i < b.length; i++) { const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)); atr = atr == null ? tr : (atr * 13 + tr) / 14; }
        const h = snap.or.hi - snap.or.lo, buf = h * cfg.bufferFrac, mid = (snap.or.hi + snap.or.lo) / 2, sg = dir === 'BUY' ? 1 : -1;
        const entry = dir === 'BUY' ? snap.or.hi + buf : snap.or.lo - buf;
        let sl = mid - sg * 0.05 * atr, risk = Math.abs(entry - sl);
        if (risk < cfg.minRiskAtr * atr) { risk = cfg.minRiskAtr * atr; sl = entry - sg * risk; }
        if (risk > cfg.maxRiskAtr * atr) row.plan = `${dir}: opening range too wide for a safe stop`;
        else {
          const r1 = Math.min(Math.max(h / risk, cfg.r1Min), cfg.r1Max), r2 = Math.min(Math.max((2 * h) / risk, Math.max(cfg.r2Min, r1 + 0.8)), cfg.r2Max);
          row.plan = `${dir} trigger 2m close ${dir === 'BUY' ? 'above' : 'below'} ${F(entry)} SL ${F(sl)} TP1 ${F(entry + sg * r1 * risk)} (${r1.toFixed(2)}R) TP2 ${F(entry + sg * r2 * risk)} (${r2.toFixed(2)}R)`;
        }
      }
    } catch (e) {
      row.err = String(e.message || e);
      if (/rate-limited/.test(row.err)) { results.push(row); break; }
    }
    results.push(row);
  }

  // one line per pair, ready to read
  return results.map((r) => {
    if (r.err) return `${r.name} | ${r.err}`;
    const t = r.trend, f = r.fib;
    return [
      `${r.name} | px ${F(r.px)} | 4H ${t.H4} 2H ${t.H2} 1H ${t.H1} 15m ${t.M15} 5m ${t.M5} 2m ${r.m2} 1m ${r.m1}`,
      r.or ? `OR ${F(r.or.lo)}-${F(r.or.hi)} ${r.or.done ? r.or.state : 'forming'}` : 'OR none',
      r.look,
      f ? `${f.dir} swing ${F(f.from)}@${f.fromT}->${F(f.to)} | 23.6 ${F(f.l236)} 38.2 ${F(f.l382)} 50 ${F(f.l50)} 61.8 ${F(f.l618)} 78.6 ${F(f.l786)} | ext127 ${F(f.e127)} ext162 ${F(f.e162)} | retr ${f.retr}%` : 'no clean swing',
      r.plan ? `PLAN ${r.plan}` : '',
      r.signals && r.signals.length ? `SIGNALS ${r.signals.join(' ; ')}` : '',
    ].filter(Boolean).join(' | ');
  }).join('\n');
});
