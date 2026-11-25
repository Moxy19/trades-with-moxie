// Royal Trades: version lab (25 Nov 2026). Same Deriv 1m history through several engines/configs, 3 windows of ~21 days.
// opts.runs: { name: { url: engine source, cfg: {...} | 'stored' (this browser's twm.cfg), mgmt: 'volume' } }
// Logs each closed trade as [createdAt, R, tp1Hit, window, ladder?1:0]. Resumable (localStorage opts.key).
(async (opts = {}) => {
  const mods = {};
  const load = async (u) => { if (mods[u]) return mods[u]; const src = await (await fetch(u)).text(); const m = { exports: {} }; new Function('module', 'exports', src)(m, m.exports); return (mods[u] = m.exports); };
  const KEY = opts.key || 'rt.ver1', N1 = opts.m1Bars || 30000, W = opts.windows || 3;
  const lab = (window.__ver = JSON.parse(localStorage.getItem(KEY) || 'null') || { done: {}, err: {}, fin: false });
  lab.fin = false;
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(lab)); } catch (e) { lab.saveErr = String(e); } };
  const runs = {};
  for (const [k, r] of Object.entries(opts.runs)) {
    const E = await load(r.url);
    const stored = r.cfg === 'stored' ? JSON.parse(localStorage.getItem('twm.cfg') || '{}') : r.cfg || {};
    runs[k] = { E, cfg: Object.assign({}, E.DEFAULTS, r.mgmt && E.MANAGEMENT ? E.MANAGEMENT[r.mgmt] : {}, stored, r.extra || {}) };
    delete runs[k].cfg.signalsEnabledFrom;
  }
  const M = Object.values(runs)[0].E;
  const markets = opts.markets || M.DEFAULT_SYMBOLS.filter((x) => x.source !== 'mt5');
  let feed = new M.DerivFeed(); await feed.connect();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const yieldNow = () => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
  const retry = async (fn) => { for (let k = 0; ; k++) { try { return await fn(); } catch (e) { const m = String((e && e.message) || e); if (k >= 6) throw e;
    if (/rate limit/i.test(m)) await sleep(65000); else { await sleep(5000); try { feed.ws.onclose = null; feed.ws.close(); } catch (x) {} feed = new M.DerivFeed(); await feed.connect(); } } } };
  for (const mk of markets) {
    const sym = mk.symbol; if (lab.done[sym]) continue; lab.progress = sym;
    try {
      const all = await retry(() => feed.candlesBack(sym, 60, N1 * W));
      if (!all.candles.length) throw new Error('no data');
      const res = {}, memo = {};
      for (let w = 0; w < W; w++) {
        const end = all.candles.length - w * N1, c = all.candles.slice(Math.max(0, end - N1), end); if (c.length < 5000) continue;
        const raw1 = { candles: c, pip: all.pip };
        const cache = { candlesBack: async () => raw1, candles: (s, g, n, e) => (memo[g + ':' + n + ':' + e] = memo[g + ':' + n + ':' + e] || retry(() => feed.candles(s, g, n, e))) };
        for (const [k, r] of Object.entries(runs)) {
          lab.progress = sym + ' w' + w + ' ' + k;
          const bt = await r.E.backtest(cache, Object.assign({}, mk, { source: 'deriv' }), Math.ceil(N1 / 1440), r.cfg);
          (res[k] = res[k] || []).push(bt.signals.filter((s) => s.result != null && s.filledAt).map((s) => [s.createdAt, s.result, s.tp1At || (s.stage > 0) ? 1 : 0, w, s.strategy === 'LADDER' ? 1 : 0]));
          await yieldNow();
        }
      }
      lab.done[sym] = { name: mk.name, market: mk.market, res };
    } catch (e) { lab.err[sym] = String((e && e.message) || e); }
    save();
  }
  lab.fin = true; lab.progress = 'finished'; save();
  try { feed.ws.onclose = null; feed.ws.close(); } catch (e) {}
  return 'done';
})
