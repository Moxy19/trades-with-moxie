// TradesbySci v2 engine tests (offline, synthetic data): levels are ordered, signals are well-formed, live path runs.
const M = require('../sci2/moxie-engine.js');
const ORB = require('../engine/moxie-engine.js');
const { agg, MockFeed } = require('./mockfeed.js');
// Swingier synthetic market than mockfeed's gen (which trends one way for weeks): waves of 6-48h with pullbacks.
function gen(seed = 7, minutes = 60 * 24 * 75, start = 1795000000 - (1795000000 % 86400) - minutes * 60) {
  let a = seed >>> 0; const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const bars = []; let p = 1000, drift = 0, left = 0;
  for (let i = 0; i < minutes; i++) {
    if (left-- <= 0) { drift = (rnd() - 0.5) * 0.12; left = 360 + Math.floor(rnd() * 2500); }
    const t = start + i * 60, o = p; let h = o, l = o;
    for (let k = 0; k < 6; k++) { p += drift / 6 + (rnd() - 0.5) * 0.5; h = Math.max(h, p); l = Math.min(l, p); }
    bars.push({ epoch: t, open: o, high: h, low: l, close: p });
  }
  return bars;
}
const assert = require('assert');

(async () => {
  let total = 0;
  for (const seed of [1, 2, 4, 9, 10, 12]) {
    const m1 = gen(seed, 60 * 24 * 75);
    const feed = new MockFeed(m1);
    const rejects = {};
    const r = await M.backtest(feed, { symbol: 'TEST', name: 'Test ' + seed }, 20, {});
    const s = M.stats(r.signals);
    const o = ORB.stats((await ORB.backtest(new MockFeed(m1), { symbol: 'TEST', name: 'Test ' + seed }, 20, {})).signals);
    console.log(`seed ${String(seed).padEnd(2)} Sci: signals=${s.total} win=${(s.winRate * 100).toFixed(0)}% R=${s.totalR} PF=${s.profitFactor.toFixed(2)} | ORB+: signals=${o.total} R=${o.totalR}`);
    for (const sig of r.signals) {
      total++;
      assert.strictEqual(sig.strategy, 'SCI', 'Sci only (ORB+ off by default)');
      assert(sig.risk > 0, 'risk > 0');
      if (sig.dir === 'BUY') assert(sig.sl < sig.entry && sig.tp1 > sig.entry && sig.tp2 > sig.tp1, 'buy levels ordered');
      else assert(sig.sl > sig.entry && sig.tp1 < sig.entry && sig.tp2 < sig.tp1, 'sell levels ordered');
      assert(sig.r1 >= 1.0, 'TP1 at least 1R');
      assert(!['PENDING', 'ACTIVE', 'TP1_HIT'].includes(sig.status), 'all closed at end');
      if (sig.status === 'EXPIRED' || sig.status === 'CANCELLED') continue;
      assert(sig.text && sig.text.includes('Location'), 'narrative');
      assert(sig.zone && sig.zone.level != null, 'zone recorded');
    }
  }
  assert(total > 0, 'Sci produced signals on synthetic data');

  // both strategies together when orb: true
  const both = await M.backtest(new MockFeed(gen(7, 60 * 24 * 75)), { symbol: 'TEST', name: 'Both' }, 20, { orb: true });
  const kinds = new Set(both.signals.map((x) => x.strategy || 'ORB'));
  console.log('orb:true strategies', [...kinds].join(', '));
  assert(kinds.has('ORB') || both.signals.length === 0, 'ORB+ can run beside Sci');

  // live path with ticks
  const m1 = gen(5, 60 * 24 * 75), cut = m1.length - 2000, hist = m1.slice(0, cut), future = m1.slice(cut);
  const events = [];
  const eng = new M.Engine({}, { onSignal: (s) => events.push('NEW ' + s.dir + ' ' + s.grade), onUpdate: (s, p) => events.push(p + '->' + s.status) });
  eng.mode = 'backtest';
  eng.addSymbol('LIVE', { name: 'Live', decimals: 2 });
  for (const g of [120, 300, 900, 3600, 7200, 14400, 86400]) eng.seed('LIVE', g, agg(hist, g));
  eng.seed('LIVE', 60, hist); eng.finishSeed('LIVE');
  for (const b of future) for (let k = 1; k <= 3; k++) eng.onBar('LIVE', { open_time: b.epoch, open: b.open, high: b.high, low: b.low, close: k === 3 ? b.close : b.open + (b.close - b.open) * k / 3 });
  const snap = eng.snapshot('LIVE');
  console.log('live events', events.length, '| look:', snap.look);
  assert(typeof snap.look === 'string');
  console.log('SCI2 TESTS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
