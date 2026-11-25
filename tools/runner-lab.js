// Royal Trades: runner lab (25 Nov 2026). What happens after TP1 under the 3-position plan.
// Entries are v1.15 (TP1 0.3R, golden rule, strict 1H, soft stop off, 'More signals' preset). Only cfg.after changes.
// Downloads opts.windows x opts.m1Bars of Deriv 1m history per market once, replays every config on each window
// (window 0 = most recent). Logs each closed ORB+ trade as [createdAt, R, tp1Hit]. Resumable (localStorage opts.key).
(async (opts = {}) => {
  const src = await (await fetch(opts.engineUrl)).text();
  const mod = { exports: {} }; new Function('module', 'exports', src)(mod, mod.exports);
  const M = mod.exports; if (!/runner/.test(M.version)) throw new Error('wrong engine ' + M.version);
  const KEY = opts.key || 'rt.run1', N1 = opts.m1Bars || 30000, W = opts.windows || 3;
  const lab = (window.__run = JSON.parse(localStorage.getItem(KEY) || 'null') || { done: {}, err: {}, fin: false });
  lab.fin = false;
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(lab)); } catch (e) { lab.saveErr = String(e); } };
  const base = Object.assign({}, M.DEFAULTS, M.MANAGEMENT.volume, opts.base || {});
  const CONFIGS = opts.configs;
  const markets = opts.markets || M.DEFAULT_SYMBOLS.filter((x) => x.source !== 'mt5');
  let feed = new M.DerivFeed(); await feed.connect();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const retry = async (fn) => {
    for (let k = 0; ; k++) {
      try { return await fn(); } catch (e) {
        const m = String((e && e.message) || e);
        if (k >= 6) throw e;
        lab.progress = (lab.progress || '').split(' · ')[0] + ' · waiting (' + m.slice(0, 40) + ')';
        if (/rate limit/i.test(m)) await sleep(65000);
        else { await sleep(5000); try { feed.ws.onclose = null; feed.ws.close(); } catch (x) {} feed = new M.DerivFeed(); await feed.connect(); }
      }
    }
  };
  for (const mk of markets) {
    const sym = mk.symbol;
    if (lab.done[sym]) continue;
    lab.progress = sym;
    try {
      const all = await retry(() => feed.candlesBack(sym, 60, N1 * W));
      if (!all.candles.length) throw new Error('no data');
      const res = {}; const memo = {};
      for (let w = 0; w < W; w++) {
        const end = all.candles.length - w * N1, c = all.candles.slice(Math.max(0, end - N1), end);
        if (c.length < 5000) continue;
        const raw1 = { candles: c, pip: all.pip };
        const cache = { candlesBack: async () => raw1, candles: (s, g, n, e) => (memo[g + ':' + n + ':' + e] = memo[g + ':' + n + ':' + e] || retry(() => feed.candles(s, g, n, e))) };
        for (const [k, a] of Object.entries(CONFIGS)) {
          lab.progress = sym + ' w' + w + ' ' + k;
          const bt = await M.backtest(cache, Object.assign({}, mk, { source: 'deriv' }), Math.ceil(N1 / 1440), Object.assign({}, base, a ? { after: a } : {}));
          (res[k] = res[k] || []).push(bt.signals.filter((s) => s.result != null && s.filledAt).map((s) => [s.createdAt, s.result, s.tp1At ? 1 : 0, w]));
          await sleep(0);
        }
      }
      lab.done[sym] = { name: mk.name, market: mk.market, bars: all.candles.length, res };
    } catch (e) { lab.err[sym] = String((e && e.message) || e); }
    save();
  }
  lab.fin = true; lab.progress = 'finished'; save();
  try { feed.ws.onclose = null; feed.ws.close(); } catch (e) {}
  return 'done';
})
