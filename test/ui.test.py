# Headless UI test: loads the built single-file terminal with a mocked Deriv/Weltrade world
# (the sandbox can't reach the real feeds), lets the engine fire signals, and screenshots each view.
import json, sys, time
from playwright.sync_api import sync_playwright

MOCK = r"""
(() => {
  // deterministic trending market, 1m bars
  let seed = 9; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const now = Math.floor(Date.now() / 1000), N = 6000, start = Math.floor((now - N * 60) / 60) * 60;
  const m1 = []; let p = 1000, drift = 0;
  for (let i = 0; i < N + 400; i++) { if (i % 240 === 0) drift = (rnd() - 0.45) * 0.08; const t = start + i * 60, o = p; let h = o, l = o;
    for (let k = 0; k < 30; k++) { p += drift / 30 + (rnd() - 0.5) * 0.35; h = Math.max(h, p); l = Math.min(l, p); } m1.push({ epoch: t, open: o, high: h, low: l, close: p }); }
  const agg = (g, upto) => { const o = []; let c = null; for (const b of m1) { if (b.epoch > upto) break; const t = Math.floor(b.epoch / g) * g; if (!c || c.epoch !== t) { if (c) o.push(c); c = { ...b, epoch: t }; } else { c.high = Math.max(c.high, b.high); c.low = Math.min(c.low, b.low); c.close = b.close; } } if (c) o.push(c); return o; };
  let cursor = N; // index of "current" bar
  window.__mockAdvance = (n) => { cursor = Math.min(m1.length - 1, cursor + n); };
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 20); FakeWS.all.push(this); }
    send(raw) { const m = JSON.parse(raw); const r = (d) => setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify(Object.assign({ req_id: m.req_id, echo_req: m }, d)) }), 5);
      if (m.ping) return r({ msg_type: 'ping', ping: 'pong' });
      if (m.active_symbols) return r({ msg_type: 'active_symbols', active_symbols: [{ underlying_symbol: 'R_75', underlying_symbol_name: 'Volatility 75 Index', market: 'synthetic_index', submarket: 'random_index' }] });
      if (m.forget) return r({ msg_type: 'forget' });
      if (m.ticks_history) { const g = m.granularity || 60; const upto = m.end === 'latest' ? m1[cursor].epoch : +m.end; const all = agg(g, upto); const c = all.slice(-(m.count || 500));
        r({ msg_type: 'candles', candles: c, pip_size: 2, subscription: m.subscribe ? { id: 'x' + m.req_id } : undefined });
        if (m.subscribe) { const sym = m.ticks_history; this.timer = setInterval(() => { window.__mockAdvance(1); const b = m1[cursor]; const bb = agg(g, b.epoch).slice(-1)[0];
          this.onmessage && this.onmessage({ data: JSON.stringify({ msg_type: 'ohlc', ohlc: { symbol: sym, granularity: g, open_time: bb.epoch, epoch: b.epoch, open: String(bb.open), high: String(bb.high), low: String(bb.low), close: String(bb.close) } }) }); }, 15); }
        return; }
    }
    close() { clearInterval(this.timer); this.readyState = 3; }
  }
  FakeWS.all = []; window.WebSocket = FakeWS;
  // weltrade REST mocked as empty (offline)
  const of = window.fetch; window.fetch = async (u, o) => { if (String(u).includes('sharewt') ) return new Response(JSON.stringify({ data: { accountTypeList: { syntx: { symbols: { 'FlipX-4': { code: 'FlipX-4', contractSize: 1, volumeMin: 0.01, volumeStep: 0.01 } } } } } })); if (String(u).includes('weltradecharts')) return new Response(JSON.stringify({ status: 'ok', data: [] })); return of(u, o); };
  localStorage.setItem('twm.symbols', JSON.stringify([{ symbol: 'R_75', name: 'Volatility 75', market: 'synthetic', source: 'deriv' }]));
})();
"""

def main():
    errors = []
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = b.new_page(viewport={'width': 1360, 'height': 900})
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' and 'fonts' not in m.text and 'unpkg' not in m.text and 'ERR_' not in m.text else None)
        pg.add_init_script(MOCK)
        pg.goto('file:///home/claude/trades-with-moxie/dist/TradesWithMoxie.html')
        pg.wait_for_timeout(9000)
        n = pg.evaluate('TWM.signals.length'); st = pg.evaluate('TWM.signals.map(s=>s.status).join(",")')
        print('signals', n, st[:300])
        pg.screenshot(path='test/shot-signals.png', full_page=False)
        for v in ['scanner', 'perf', 'risk', 'settings']:
            pg.click(f'#tabs button[data-v="{v}"]'); pg.wait_for_timeout(600)
            pg.screenshot(path=f'test/shot-{v}.png')
        pg.click('#tabs button[data-v="signals"]'); pg.click('#viewSeg button[data-k="history"]'); pg.wait_for_timeout(400)
        pg.screenshot(path='test/shot-history.png')
        cards = pg.evaluate('document.querySelectorAll(".card").length'); print('history cards', cards)
        if cards:
            pg.click('.card [data-act="why"]'); pg.wait_for_timeout(200); pg.screenshot(path='test/shot-why.png')
        b.close()
    print('errors:', json.dumps(errors[:10], indent=1))
    return 0 if not [e for e in errors if not e.startswith('console:')] else 1

sys.exit(main())
