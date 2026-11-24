// Royal Trades: fresh comparison lab (24 Nov 2026).
// Runs several engines/configurations on the same downloaded Deriv history, each with its own backtest():
//   opts.engines: { name: { file: 'engine-next.js' | 'v12/engine.js', cfg: {...} } }
// Windows: opts.skipBars drops the most recent N 1m bars so earlier windows can be tested.
// Logs every closed ORB+ trade as [closedAt, R, createdAt, tp1Hit, status]. Resumable via localStorage (opts.key).
(async (opts = {}) => {
  const base = 'https://moxy19.github.io/trades-with-moxie/tools/';
  const mods = {};
  const load = async (f) => { if (mods[f]) return mods[f]; const src = await (await fetch(base + f + '?' + Date.now())).text(); const mod = { exports: {} }; new Function('module', 'exports', src)(mod, mod.exports); return (mods[f] = mod.exports); };
  const M = await load('engine-next.js');
  for (const e of Object.values(opts.engines)) await load(e.file);
  const KEY = opts.key || 'rt.fresh', N1 = opts.m1Bars || 30000;
  const lab = (window.__fresh = JSON.parse(localStorage.getItem(KEY) || 'null') || { done: {}, err: {}, fin: false });
  lab.fin = false;
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(lab)); } catch (e) { lab.saveErr = String(e); } };
  const markets = opts.markets || M.DEFAULT_SYMBOLS.filter((x) => x.source !== 'mt5');
  const feed = new M.DerivFeed(); await feed.connect();
  for (const mk of markets) {
    const sym = mk.symbol;
    if (lab.done[sym]) continue;
    lab.progress = sym;
    try {
      let raw1 = await feed.candlesBack(sym, 60, N1 + (opts.skipBars || 0));
      if (opts.skipBars) raw1 = Object.assign({}, raw1, { candles: raw1.candles.slice(0, -opts.skipBars) });
      if (!raw1.candles.length) throw new Error('no data');
      const memo = {};
      const cache = { candlesBack: async () => raw1, candles: (s, g, c, e) => (memo[g + ':' + c + ':' + e] = memo[g + ':' + c + ':' + e] || feed.candles(s, g, c, e)) };
      const res = {};
      for (const [k, e] of Object.entries(opts.engines)) {
        lab.progress = sym + ' ' + k;
        const E = mods[e.file];
        const bt = await E.backtest(cache, Object.assign({}, mk, { source: 'deriv' }), Math.ceil(N1 / 1440), Object.assign({}, E.DEFAULTS, e.cfg || {}));
        res[k] = bt.signals.filter((s) => s.strategy !== 'LADDER' && s.result != null && s.filledAt).map((s) => [s.closedAt, s.result, s.createdAt, s.tp1At ? 1 : 0, s.status]);
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
