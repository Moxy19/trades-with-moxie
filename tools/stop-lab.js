// Royal Trades: stop-out lab (23 Nov 2026).
// Replays ~20 days of real Deriv 1m history through the candidate engine (tools/engine-next.js) once per configuration.
// Each configuration pairs one ORB+ variant with one Royal Ladder variant (the two strategies don't interact).
// Counts per strategy: trades, wins (result > 0), losses, FULL stop-outs (original stop hit with the whole position),
// soft exits (cut early at a candle close), total R, and R in each half of the window.
// Pessimistic fills (stop first on ties), no spread. Resumable: results are saved to localStorage 'rt.ss'.
(async (opts = {}) => {
  const src = await (await fetch('https://moxy19.github.io/trades-with-moxie/tools/engine-next.js?' + Date.now())).text();
  if (!src.includes(opts.need || '_softStops')) throw new Error('engine-next not deployed yet');
  const mod = { exports: {} }; new Function('module', 'exports', src)(mod, mod.exports);
  const M = mod.exports && mod.exports.Engine ? mod.exports : window.MoxieEngine;
  const KEY = opts.key || 'rt.ss', N1 = opts.m1Bars || 30000;
  const lab = (window.__ss = JSON.parse(localStorage.getItem(KEY) || 'null') || { done: {}, err: {}, fin: false });
  lab.fin = false;
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(lab)); } catch (e) {} };
  const L = (o) => Object.assign({}, M.DEFAULTS.ladder, o);
  const CONFIGS = {
    base: {},
    A: { beAtR: 0.3, beLockR: 0.05, ladder: L({ beAt: 2 }) },
    B: { softStop: { r: 0.4, tf: 300 }, ladder: L({ tp1Stop: 0.5 }) },
    C: { softStop: { r: 0.6, tf: 300 }, ladder: L({ tp1Stop: 0.5, beAt: 2 }) },
    D: { softStop: { r: 0.5, tf: 900 }, ladder: L({ softLevel: 0.25 }) },
    E: { beAtR: 0.3, beLockR: 0.05, softStop: { r: 0.6, tf: 300 }, ladder: L({ softLevel: 0.25, tp1Stop: 0.5 }) },
    F: { minScore: 85, minScalpScore: 85, ladder: L({ softStop: { r: 0.5, tf: 300 } }) },
    G: { minScore: 85, minScalpScore: 85, softStop: { r: 0.5, tf: 300 }, ladder: L({ beAt: 99, stepTrail: true, stepFrom: 3, stepLock: 0.1 }) },
    H: { softStop: { r: 0.3, tf: 300 }, ladder: L({ softLevel: 0, tp1Stop: 0.5 }) },
    I: { beAtR: 0.35, beLockR: 0.05, softStop: { r: 0.5, tf: 300 }, ladder: L({ softLevel: 0.5 }) },
    // "stop = 50% of the target": ORB+ vs TP2 (1:2) or TP1; Ladder vs TP5, TP3, TP4, TP2
    J: { slOfTp: { ref: 'tp2', k: 0.5 }, ladder: L({ sl: 1.90 }) },
    K: { slOfTp: { ref: 'tp1', k: 0.5 }, ladder: L({ sl: 0.88 }) },
    M: { slOfTp: { ref: 'tp2', k: 0.5 }, softStop: { r: 0.5, tf: 300 }, ladder: L({ sl: 1.22 }) },
    N: { ladder: L({ sl: 0.545 }) },
  };
  if (opts.configs) { for (const k in CONFIGS) delete CONFIGS[k]; for (const [k, c] of Object.entries(opts.configs)) CONFIGS[k] = Object.assign({}, c, c.ladder ? { ladder: L(c.ladder) } : {}); }
  const markets = opts.markets || M.DEFAULT_SYMBOLS.filter((x) => x.source !== 'mt5');
  const feed = new M.DerivFeed(); await feed.connect();
  const sum = (list, mid) => {
    const r = { n: list.length, w: 0, l: 0, full: 0, soft: 0, R: 0, h1: 0, h2: 0, t1: 0, t2: 0, t3: 0, t4: 0, t5: 0, lossAfterT1: 0 };
    for (const s of list) {
      if (s.result > 0) r.w++; else if (s.result < 0) r.l++;
      if (s.status === 'SL_HIT' && !(s.strategy === 'LADDER' && s.stage > 0)) r.full++;
      if (s.status === 'SOFT_EXIT') r.soft++;
      const st = s.strategy === 'LADDER' ? s.stage || 0 : (s.tp1At ? 1 : 0) + (s.tp1At && s.mfeR >= s.r2 - 1e-9 ? 1 : 0);
      for (let k = 1; k <= 5; k++) if (st >= k) r['t' + k]++;
      if (st >= 1 && s.result < 0) r.lossAfterT1++;
      r.R += s.result; if (s.createdAt < mid) r.h1 += s.result; else r.h2 += s.result;
    }
    for (const k of ['R', 'h1', 'h2']) r[k] = Math.round(r[k] * 100) / 100;
    return r;
  };
  for (const mk of markets) {
    const sym = mk.symbol;
    if (lab.done[sym]) continue;
    lab.progress = sym;
    try {
      const raw1 = await feed.candlesBack(sym, 60, N1);
      if (!raw1.candles.length) throw new Error('no data');
      const memo = {};
      const cache = { candlesBack: async () => raw1, candles: (s, g, c, e) => (memo[g + ':' + e] = memo[g + ':' + e] || feed.candles(s, g, c, e)) };
      const res = {};
      for (const [k, cfg] of Object.entries(CONFIGS)) {
        lab.progress = sym + ' ' + k;
        const bt = await M.backtest(cache, Object.assign({}, mk, { source: 'deriv' }), Math.ceil(N1 / 1440), Object.assign({}, M.DEFAULTS, cfg));
        const mid = (bt.from + bt.to) / 2, fil = bt.signals.filter((s) => s.result != null && s.filledAt);
        res[k] = { O: sum(fil.filter((s) => s.strategy !== 'LADDER'), mid), L: sum(fil.filter((s) => s.strategy === 'LADDER'), mid) };
        await new Promise((r) => setTimeout(r, 0));
      }
      lab.done[sym] = { name: mk.name, market: mk.market, days: Math.round((raw1.candles.length / 1440) * 10) / 10, res };
    } catch (e) { lab.err[sym] = String(e && e.message || e); }
    save();
  }
  lab.fin = true; lab.progress = 'finished'; save();
  try { feed.ws.onclose = null; feed.ws.close(); } catch (e) {}
  return 'done';
})
