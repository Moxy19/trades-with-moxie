const M = require('../engine/moxie-engine.js');
const { gen, agg, MockFeed } = require('./mockfeed.js');
const assert = require('assert');

(async () => {
  // 1) backtest end to end on synthetic data, both modes
  for (const seed of [3, 7, 11]) {
    const feed = new MockFeed(gen(seed));
    for (const mode of ['strict', 'adaptive']) {
      const r = await M.backtest(feed, { symbol: 'TEST', name: 'Test ' + seed }, 7, { trendMode: mode });
      const s = M.stats(r.signals);
      console.log(`seed ${seed} ${mode.padEnd(8)} signals=${s.total} closed=${s.closed} win=${(s.winRate * 100).toFixed(0)}% R=${s.totalR} PF=${s.profitFactor.toFixed(2)} DD=${s.maxDD} kinds=${JSON.stringify(s.byKind)}`);
      for (const sig of r.signals) {
        assert(sig.risk > 0, 'risk>0');
        if (sig.dir === 'BUY') assert(sig.sl < sig.entry && sig.tp1 > sig.entry && sig.tp2 > sig.tp1, 'buy levels ordered');
        else assert(sig.sl > sig.entry && sig.tp1 < sig.entry && sig.tp2 < sig.tp1, 'sell levels ordered');
        assert(!['PENDING', 'ACTIVE', 'TP1_HIT'].includes(sig.status), 'all closed at end');
        if (mode === 'strict') assert(sig.kind === 'TREND' && sig.bias.H1 === (sig.dir === 'BUY' ? 'UP' : 'DOWN'), 'strict never against 1H');
        assert(sig.r1 >= M.DEFAULTS.r1Min - 0.01, 'TP1 at least the configured minimum');
      }
    }
  }

  // 2) live path: seed + stream ticks (split each 1m bar into ticks), check no look-ahead crashes
  const m1 = gen(5);
  const cut = m1.length - 600; const hist = m1.slice(0, cut), future = m1.slice(cut);
  const events = [];
  const eng = new M.Engine({ trendMode: 'adaptive' }, { onSignal: (s) => events.push(['NEW', s.dir, s.grade]), onUpdate: (s, p) => events.push([p + '->' + s.status]) });
  eng.mode = 'backtest'; // use bar extremes for this synthetic tick test
  eng.addSymbol('LIVE', { name: 'Live test', decimals: 2 });
  for (const g of [120, 900, 3600, 7200, 14400]) eng.seed('LIVE', g, agg(hist, g));
  eng.seed('LIVE', 60, hist); eng.finishSeed('LIVE');
  for (const b of future) for (let k = 1; k <= 3; k++) eng.onBar('LIVE', { open_time: b.epoch, open: b.open, high: b.high, low: b.low, close: k === 3 ? b.close : b.open + (b.close - b.open) * k / 3 });
  console.log('live events', events.length, events.slice(0, 8).map((e) => e.join(' ')).join(' | '));
  const snap = eng.snapshot('LIVE'); console.log('snapshot', JSON.stringify(snap).slice(0, 300));
  console.log('ALL TESTS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
