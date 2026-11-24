// Royal Trades: Pro V2 comparison lab (24 Nov 2026).
// Runs, on the same downloaded Deriv history: (1) the uploaded Pro V2 package as shipped (its v1.0.0 engine with the
// Pro V2 gate as the beforeSignal hook and its outcome recorder), and (2) the current engine (tools/engine-next.js) under
// several configurations. Logs every closed trade as [closedAt, R, createdAt, tp1Hit, status].
// opts: { key, configs: { name: cfg }, skipBars (earlier window), m1Bars }. Resumable via localStorage.
(async (opts = {}) => {
  const base = 'https://moxy19.github.io/trades-with-moxie/tools/';
  const load = async (f) => { const src = await (await fetch(base + f + '?' + Date.now())).text(); const mod = { exports: {} }; new Function('module', 'exports', src)(mod, mod.exports); return mod.exports; };
  const M = await load('engine-next.js'), P = await load('pro-v2/engine-v1.js'), GATE = await load('pro-v2/gate.js');
  if (!M.Engine || !P.Engine || !GATE.ProV2Gate) throw new Error('engines not loaded');
  const KEY = opts.key || 'rt.cmp', N1 = opts.m1Bars || 30000;
  const lab = (window.__cmp = JSON.parse(localStorage.getItem(KEY) || 'null') || { done: {}, err: {}, fin: false });
  lab.fin = false;
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(lab)); } catch (e) { lab.saveErr = String(e); } };
  const markets = opts.markets || M.DEFAULT_SYMBOLS.filter((x) => x.source !== 'mt5');
  const feed = new M.DerivFeed(); await feed.connect();
  const log = (sigs) => sigs.filter((s) => s.result != null && s.filledAt).map((s) => [s.closedAt, s.result, s.createdAt, s.tp1At ? 1 : 0, s.status]);
  for (const mk of markets) {
    const sym = mk.symbol;
    if (lab.done[sym]) continue;
    lab.progress = sym;
    try {
      let raw1 = await feed.candlesBack(sym, 60, N1 + (opts.skipBars || 0));
      if (opts.skipBars) raw1 = Object.assign({}, raw1, { candles: raw1.candles.slice(0, -opts.skipBars) });
      if (!raw1.candles.length) throw new Error('no data');
      const memo = {};
      const cache = { candlesBack: async () => raw1, candles: (s, g, c, e) => (memo[g + ':' + e] = memo[g + ':' + e] || feed.candles(s, g, c, e)) };
      const res = {};
      // ---- Pro V2 as shipped ----
      {
        lab.progress = sym + ' ProV2';
        const PG = P.G, bars = raw1.candles.map(P.toBar), startFeed = Math.ceil(bars[0].t / PG.H4) * PG.H4;
        const gate = new GATE.ProV2Gate({ enabled: true });
        const eng = new P.Engine({ signalsEnabledFrom: startFeed + 3 * 3600 }, { beforeSignal: (s) => gate.assess(s), onUpdate: (s) => gate.record(s) });
        eng.mode = 'backtest';
        eng.addSymbol(sym, Object.assign({}, mk, { source: 'deriv', decimals: raw1.pip }));
        const st = eng.sym[sym];
        for (const g of [PG.M15, PG.H1, PG.H2, PG.H4]) { const r = await cache.candles(sym, g, 1500, String(startFeed - 1)); st.series[g].seed(r.candles.filter((c) => c.epoch + g <= startFeed), false); }
        st.ready = true;
        for (const b of bars) { if (b.t < startFeed) continue; eng.onBar(sym, b); }
        const lastBar = bars[bars.length - 1];
        for (const s of eng.openSignals(sym)) eng._close(s, st, s.status === 'PENDING' ? 'EXPIRED' : 'TIME_EXIT', lastBar.c, lastBar.t + 60);
        res.ProV2 = log(eng.signals);
        await new Promise((r) => setTimeout(r, 0));
      }
      // ---- current engine, each configuration ----
      for (const [k, cfg] of Object.entries(opts.configs || { cur: {} })) {
        lab.progress = sym + ' ' + k;
        const bt = await M.backtest(cache, Object.assign({}, mk, { source: 'deriv' }), Math.ceil(N1 / 1440), Object.assign({}, M.DEFAULTS, cfg));
        res[k] = log(bt.signals.filter((s) => s.strategy !== 'LADDER'));
        await new Promise((r) => setTimeout(r, 0));
      }
      lab.done[sym] = { market: mk.market, res };
    } catch (e) { lab.err[sym] = String((e && e.message) || e); }
    save();
  }
  lab.fin = true; lab.progress = 'finished'; save();
  try { feed.ws.onclose = null; feed.ws.close(); } catch (e) {}
  return 'done';
});
