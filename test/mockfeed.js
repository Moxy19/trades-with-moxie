// Synthetic market generator + mock Deriv feed for offline testing (the sandbox cannot reach Deriv).
function gen(seed = 7, minutes = 60 * 24 * 12, start = 1795000000 - (1795000000 % 14400) - 60 * 24 * 12 * 60) {
  let x = seed; const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const bars = []; let p = 1000, drift = 0;
  for (let i = 0; i < minutes; i++) {
    if (i % 240 === 0) drift = (rnd() - 0.5) * 0.06; // regime every 4h
    const t = start + i * 60; const o = p; let h = o, l = o;
    for (let k = 0; k < 30; k++) { p += drift / 30 + (rnd() - 0.5) * 0.35; h = Math.max(h, p); l = Math.min(l, p); }
    bars.push({ epoch: t, open: o, high: h, low: l, close: p });
  }
  return bars;
}
function agg(m1, g) {
  const out = []; let cur = null;
  for (const b of m1) {
    const t = Math.floor(b.epoch / g) * g;
    if (!cur || cur.epoch !== t) { if (cur) out.push(cur); cur = { epoch: t, open: b.open, high: b.high, low: b.low, close: b.close }; }
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; }
  }
  if (cur) out.push(cur); return out;
}
class MockFeed {
  constructor(m1) { this.m1 = m1; this.cache = {}; }
  series(g) { return this.cache[g] || (this.cache[g] = g === 60 ? this.m1 : agg(this.m1, g)); }
  async candles(sym, g, count = 2000, end = 'latest') {
    let s = this.series(g); if (end !== 'latest') s = s.filter((c) => c.epoch <= +end);
    return { candles: s.slice(-Math.min(count, 2000)), pip: 2 };
  }
  async candlesBack(sym, g, total) { const s = this.series(g); return { candles: s.slice(-total), pip: 2 }; }
}
module.exports = { gen, agg, MockFeed };
