// Royal Trades: robot backtest lab (24 Nov 2026).
// Phase 1 (per market): replays real Deriv 1m history through the live engine (stop first on ties) and records every
//   signal event plus the 1m closes while a signal is open.
// Phase 2: merges every market in time order and runs the real Robot (Paper broker) over it with the robot's own
//   settings and safety limits, starting from a chosen balance. Multipliers sizing, broker stop/take profit in $,
//   half at TP1, engine-driven exits, daily limits, drawdown rule: all the same code as live.
// Not modelled: Deriv commission and spread, per-market multiplier lists (Paper uses a generic list).
// Run in Chrome on https://moxy19.github.io/trades-with-moxie/ (needs Deriv's feed):
//   fetch(RAW + 'tools/robot-lab.js').then(r => r.text()).then(t => eval(t)({ m1Bars: 30000 }))
// Results: window.__rlab (events, in memory) and localStorage 'rt.robotlab' (summaries).
(async (opts = {}) => {
  const RAW = opts.raw || 'https://raw.githubusercontent.com/Moxy19/trades-with-moxie/claude/project-thread-b7b3gn/'; // engine from this branch (= main + robot)
  const load = async (f) => { const src = await (await fetch(RAW + f + '?' + Date.now())).text(); const mod = { exports: {} }; new Function('module', 'exports', src)(mod, mod.exports); return mod.exports; };
  const M = opts.M || await load('engine/moxie-engine.js'), R = opts.R || await load('engine/royal-robot.js');
  const W = typeof window !== 'undefined' ? window : globalThis;
  if (W.__rlab && !W.__rlab.raw) W.__rlab = null; // older lab object without raw data
  const lab = (W.__rlab = W.__rlab || { data: {}, err: {}, progress: '', fin: false });
  lab.M = M; lab.R = R; lab.fin = false;
  const N1 = opts.m1Bars || 30000;
  const markets = opts.markets || M.DEFAULT_SYMBOLS.filter((x) => x.source !== 'mt5');
  let feed = opts.feed || new M.DerivFeed(); await feed.connect();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const retry = async (fn) => {
    for (let k = 0; ; k++) {
      try { return await fn(); } catch (e) {
        const m = String((e && e.message) || e); if (k >= 6) throw e;
        lab.progress = (lab.progress || '').split(' · ')[0] + ' · waiting (' + m.slice(0, 40) + ')';
        if (/rate limit/i.test(m)) await sleep(65000);
        else { await sleep(5000); try { feed.ws.onclose = null; feed.ws.close(); } catch (x) {} feed = new M.DerivFeed(); await feed.connect(); }
      }
    }
  };
  const copy = (s) => ({ id: s.id, symbol: s.symbol, name: s.name, market: s.market, source: 'deriv', dir: s.dir, grade: s.grade, unproven: s.unproven, status: s.status, entry: s.entry, price: s.price, sl: s.sl, slLive: s.slLive, tp1: s.tp1, tp2: s.tp2, risk: s.risk, r1: s.r1, r2: s.r2, createdAt: s.createdAt, filledAt: s.filledAt, result: s.result, exit: s.exit, sl12: s.sl12, sl3: s.sl3, open12: s.open12, threeR: s.threeR });

  // ---------- phase 1a: download (kept in memory so the engine can be replayed with other settings) ----------
  lab.raw = lab.raw || {};
  for (const mk of markets) {
    const sym = mk.symbol; if (lab.raw[sym]) continue;
    lab.progress = 'download ' + sym + ' (' + (Object.keys(lab.raw).length + 1) + '/' + markets.length + ')';
    try {
      const m1 = await retry(() => feed.candlesBack(sym, 60, N1));
      if (!m1.candles.length) throw new Error('no data');
      const bars = m1.candles.map(M.toBar);
      const startFeed = Math.ceil(bars[0].t / M.G.H4) * M.G.H4;
      const htf = {};
      for (const g of [M.G.M5, M.G.M15, M.G.H1, M.G.H2, M.G.H4]) {
        const r = await retry(() => feed.candles(sym, g, 1500, String(startFeed - 1)));
        htf[g] = r.candles.filter((c) => c.epoch + g <= startFeed);
      }
      lab.raw[sym] = { mk, pip: m1.pip, bars, startFeed, htf };
      delete lab.err[sym];
    } catch (e) { lab.err[sym] = String((e && e.message) || e); }
    await sleep(0);
  }
  // ---------- phase 1b: engine replay per market (stop first on ties) ----------
  lab.replay = (E = M, cfg = {}) => {
    lab.data = {};
    for (const sym in lab.raw) {
      const { mk, pip, bars, startFeed, htf } = lab.raw[sym];
      const ev = [];   // [t, kind, payload]  kind: 'S' signal, 'U' update, 'P' price
      const open = new Set();
      let cur = 0;
      const eng = new E.Engine(Object.assign({}, E.DEFAULTS, cfg, { signalsEnabledFrom: startFeed + 3 * 3600 }), {
        onSignal: (s) => { ev.push([cur + 60, 'S', copy(s)]); if (['ACTIVE', 'PENDING'].includes(s.status)) open.add(s.id); },
        onUpdate: (s, prev) => { ev.push([cur + 60, 'U', copy(s), prev]); if (!['ACTIVE', 'PENDING', 'TP1_HIT'].includes(s.status)) open.delete(s.id); },
      });
      eng.mode = 'backtest';
      eng.addSymbol(sym, Object.assign({}, mk, { source: 'deriv', decimals: pip }));
      const st = eng.sym[sym];
      for (const g in htf) st.series[g].seed(htf[g], false);
      st.ready = true;
      for (const b of bars) {
        if (b.t < startFeed) continue;
        cur = b.t;
        const pre = open.size ? [...open] : null;
        eng.onBar(sym, b);
        // 1m close for the Paper broker, after the engine settled this bar. Only signals open before the bar see it.
        if (pre) ev.push([b.t + 60, 'P', [b.o, b.h, b.l, b.c], pre]);
      }
      const lastBar = bars[bars.length - 1];
      cur = lastBar.t + 60;
      for (const s of eng.openSignals(sym)) eng._close(s, st, s.status === 'PENDING' ? 'EXPIRED' : 'TIME_EXIT', lastBar.c, lastBar.t + 60);
      lab.data[sym] = { market: mk.market, name: mk.name, from: startFeed, to: lastBar.t, ev, sigs: eng.signals.map(copy) };
    }
    return Object.keys(lab.data).length;
  };
  lab.load = load;
  lab.replay(M, opts.engineCfg || {});
  try { feed.ws.onclose = null; feed.ws.close(); } catch (e) {}

  // ---------- phase 2: run the robot over every market in time order ----------
  lab.run = (set = {}, balance = 10) => {
    const all = [];
    for (const sym in lab.data) for (const e of lab.data[sym].ev) all.push([e[0], sym, e[1], e[2], e[3]]);
    all.sort((a, b) => a[0] - b[0]); // stable: keeps each market's own event order
    let now = all.length ? all[0][0] * 1000 : 0;
    const robot = new R.Robot(Object.assign({}, R.ROBOT_DEFAULTS, { mode: 'paper', paperBalance: balance }, set), { now: () => now });
    const paper = new R.PaperBroker({ balance });
    const sigs = {}; // live signal objects so the robot sees engine status changes
    let peak = balance, dd = 0;
    return (async () => {
      await robot.start(paper);
      for (const [t, sym, kind, p, prev] of all) {
        now = t * 1000;
        if (kind === 'P') {
          // the engine already settled this bar's highs and lows (stop first) and its exits arrive as events, which the
          // robot mirrors; the broker's own stop and TP sit at the same levels. Mark positions at the bar close only.
          const pos = Object.values(robot.pos).find((x) => x.sig.symbol === sym && prev.includes(x.sig.id));
          if (!pos) continue;
          robot.tick(sym, p[3]);
          await null;
        } else {
          const was12 = sigs[p.id] ? sigs[p.id].open12 : undefined;
          const s = sigs[p.id] = Object.assign(sigs[p.id] || {}, p);
          // in a replay the engine's exit happens inside the bar: let the Paper broker see that exit price first (live, the robot acts on the same tick)
          if (kind === 'U' && p.status === 'TP1_HIT' && p.sl12 != null && p.open12 === false && was12 !== false) robot.tick(sym, p.sl12);
          else if (kind === 'U' && p.status === 'TP1_HIT') robot.tick(sym, p.tp1);
          else if (kind === 'U' && p.exit != null) robot.tick(sym, p.exit);
          if (kind === 'S') await robot.onSignal(s); else await robot.onUpdate(s, prev);
          const eq = paper.balance + Object.values(robot.pos).reduce((a, x) => a + x.legs.filter((l) => l.open).reduce((b, l) => b + l.stake + (l.profit || 0), 0), 0);
          peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
        }
      }
      for (const k in robot.pos) await robot._closeLegs(robot.pos[k], () => true, 'end of test');
      const closes = robot.journal.filter((j) => j.type === 'close');
      const skips = {}; robot.journal.filter((j) => j.type === 'skip').forEach((j) => { const why = j.msg.split(': ').slice(1).join(': ').replace(/[\d.]+/g, '#'); skips[why] = (skips[why] || 0) + 1; });
      const wins = closes.filter((j) => j.pnl > 0).length, gw = closes.filter((j) => j.pnl > 0).reduce((a, j) => a + j.pnl, 0), gl = -closes.filter((j) => j.pnl < 0).reduce((a, j) => a + j.pnl, 0);
      const days = all.length ? (all[all.length - 1][0] - all[0][0]) / 86400 : 0;
      return {
        balanceStart: balance, balanceEnd: Math.round(paper.balance * 100) / 100, trades: closes.length, wins, flat: closes.filter((j) => j.pnl === 0).length, losses: closes.filter((j) => j.pnl < 0).length,
        avgR: closes.length ? Math.round(closes.reduce((a, j) => a + (+((j.msg.match(/\(([+-][\d.]+)R\)/) || [])[1] || 0)), 0) / closes.length * 100) / 100 : 0, winRate: closes.length ? Math.round((wins / closes.length) * 1000) / 10 : 0,
        net: Math.round((gw - gl) * 100) / 100, profitFactor: gl ? Math.round((gw / gl) * 100) / 100 : null, maxDD: Math.round(dd * 100) / 100, maxDDPct: Math.round((dd / balance) * 1000) / 10,
        halts: robot.journal.filter((j) => j.type === 'halt').length, days: Math.round(days * 10) / 10, skips, journal: robot.journal,
      };
    })();
  };
  // engine-only stats on the same signals, for comparison
  lab.engineStats = (filter = () => true) => {
    const s = []; for (const sym in lab.data) for (const x of lab.data[sym].sigs) if (x.result != null && x.filledAt && filter(x)) s.push(x);
    const w = s.filter((x) => x.result > 0).length, gw = s.filter((x) => x.result > 0).reduce((a, x) => a + x.result, 0), gl = -s.filter((x) => x.result < 0).reduce((a, x) => a + x.result, 0);
    return { trades: s.length, inProfit: s.length ? Math.round((w / s.length) * 1000) / 10 : 0, netR: Math.round((gw - gl) * 100) / 100, pf: gl ? Math.round((gw / gl) * 100) / 100 : null };
  };
  lab.fin = true; lab.progress = 'data ready: ' + Object.keys(lab.data).length + ' markets, errors ' + Object.keys(lab.err).length;
  try { if (typeof localStorage !== 'undefined') localStorage.setItem('rt.robotlab', JSON.stringify({ progress: lab.progress, err: lab.err })); } catch (e) {}
  return lab.progress;
});
