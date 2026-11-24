// Royal Trades: entry lab (24 Nov 2026). Looks for the most accurate entries: highest share of trades reaching TP1,
// fewest full stop-outs, positive total R.
// Every setup trades only with the 1H trend (EMA50 slope and side) and with the 15m close on the trade side of its EMA50.
// Confirmation entries also need the 1m EMA9/21 in the trade direction at the moment of entry.
// Entry models (15m setups):
//   OB      ICT order block: a displacement candle (body >= 1 ATR) closes through the last 15m swing (break of structure);
//           the last opposite candle before it is the block. Limit at its top (OBtop) or middle (OBmid), or touch + 5m
//           confirmation (OBc5). Stop below the block. TP1 = the leg high made before the retrace (liquidity).
//   FVG     Fair value gap left by the displacement: limit at the gap edge (FVGtop) or its middle (FVGce), or touch + 5m
//           confirmation (FVGc5). Stop below the candle before the displacement. TP1 = the leg high.
//   OTE     Fibonacci optimal trade entry on a confirmed impulse leg (>= 1.5 ATR, broke the prior swing): limit at 70.5% or
//           61.8%, or touch of 61.8% + 5m confirmation (OTEc5). Stop beyond the leg start. TP1 = the leg high (0%).
//   CONF    Order block inside the 61.8–78.6% zone of its own leg (OB + Fib confluence); limit (CONF) or 5m confirmation (CONFc5).
//   SRc5    Support/resistance flip: a 1H swing level broken by a 15m close, retested, 5m confirmation. TP1 = the leg high.
//   SWEEP   Liquidity sweep with the trend: a 15m candle runs a prior 15m swing low/high and closes back inside; market
//           at its close (SWEEP) or the next 5m confirmation (SWEEPc5). Stop beyond the sweep wick. TP1 = the last opposite swing.
// Filter sets: base, h4 (4H trend agrees), disc (buy in the lower half / sell in the upper half of the 1H dealing range),
// h4disc (both).
// Management: 50% closes at TP1, the stop moves to entry, the rest runs to TP2 (TP1 + the TP1 distance). 24h time exit.
// 1m bars decide; stop first when stop and target share a bar; no spread. One trade at a time per model and market.
// Resumable: results are saved to localStorage under opts.key (default 'rt.ent').
(async (opts = {}) => {
  const M = window.MoxieEngine;
  const KEY = opts.key || 'rt.ent', N1 = opts.m1Bars || 40000;
  const lab = (window.__ent = JSON.parse(localStorage.getItem(KEY) || 'null') || { done: {}, err: {}, fin: false });
  lab.fin = false;
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(lab)); } catch (e) { lab.saveErr = String(e); } };
  const ema = (a, n) => { const k = 2 / (n + 1); let e = null; return a.map((v) => (e = e == null ? v : e + k * (v - e))); };
  const atrOf = (b, n = 14) => { let a = null; return b.map((x, i) => { const tr = i ? Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)) : x.h - x.l; return (a = a == null ? tr : (a * (n - 1) + tr) / n); }); };
  const lb = (a, t) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m].t < t) lo = m + 1; else hi = m; } return lo; };
  const lastClosed = (a, g, T) => lb(a, T - g + 1) - 1;
  const pivots = (b, w) => {
    const H = [], L = [];
    for (let i = w; i < b.length - w; i++) {
      let ph = true, pl = true;
      for (let k = 1; k <= w; k++) { if (!(b[i].h > b[i - k].h && b[i].h >= b[i + k].h)) ph = false; if (!(b[i].l < b[i - k].l && b[i].l <= b[i + k].l)) pl = false; }
      if (ph) H.push({ i, p: b[i].h, conf: i + w }); if (pl) L.push({ i, p: b[i].l, conf: i + w });
    }
    return { H, L };
  };
  const markets = opts.markets || M.DEFAULT_SYMBOLS.filter((x) => x.source !== 'mt5');
  const feed = new M.DerivFeed(); await feed.connect();
  const FILTERS = ['base', 'h4', 'disc', 'h4disc'];

  for (const mk of markets) {
    const sym = mk.symbol;
    if (lab.done[sym]) continue;
    lab.progress = sym;
    try {
      const raw1 = await feed.candlesBack(sym, 60, N1);
      if (!raw1.candles.length) throw new Error('no data');
      const m1 = raw1.candles.map(M.toBar), nowT = m1[m1.length - 1].t + 60;
      const m5 = M.aggCandles(raw1.candles, 300).map(M.toBar).filter((x) => x.t + 300 <= nowT);
      const m15 = (await feed.candlesBack(sym, 900, 4200)).candles.map(M.toBar).filter((x) => x.t + 900 <= nowT);
      const h1 = (await feed.candles(sym, 3600, 2500)).candles.map(M.toBar).filter((x) => x.t + 3600 <= nowT);
      const h4 = (await feed.candles(sym, 14400, 1000)).candles.map(M.toBar).filter((x) => x.t + 14400 <= nowT);
      const winStart = m1[0].t + 6 * 3600, mid = (winStart + nowT) / 2;
      const c1 = m1.map((x) => x.c), e9 = ema(c1, 9), e21 = ema(c1, 21);
      const atr15 = atrOf(m15), e15 = ema(m15.map((x) => x.c), 50), e1h = ema(h1.map((x) => x.c), 50), e4h = ema(h4.map((x) => x.c), 50);
      const trendAt = (arr, e, g, T) => { const j = lastClosed(arr, g, T); if (j < 55) return 0; if (arr[j].c > e[j] && e[j] > e[j - 3]) return 1; if (arr[j].c < e[j] && e[j] < e[j - 3]) return -1; return 0; };
      const pv15 = pivots(m15, 3), pv1h = pivots(h1, 3);
      const mom1 = (t, d) => { const j = lb(m1, t) - 1; return j > 30 && (d > 0 ? e9[j] > e21[j] : e9[j] < e21[j]); };
      // 1H dealing range at time T: last confirmed 1H swing high and low
      const dealing = (T) => { const j = lastClosed(h1, 3600, T); const Hs = pv1h.H.filter((p) => p.conf <= j), Ls = pv1h.L.filter((p) => p.conf <= j); const H = Hs[Hs.length - 1], L = Ls[Ls.length - 1]; return H && L ? { hi: H.p, lo: L.p } : null; };

      // ---- trade management on 1m from the entry ----
      const manage = (j, entry, sl, tp1, tp2, d) => {
        const risk = Math.abs(entry - sl), r1 = Math.abs(tp1 - entry) / risk, r2 = Math.abs(tp2 - entry) / risk, t0 = m1[j] ? m1[j].t : nowT;
        let stage = 0;
        for (let k = j; k < m1.length; k++) {
          const b = m1[k];
          if (b.t - t0 > 86400) { const u = ((b.o - entry) * d) / risk; return { R: stage ? 0.5 * r1 + 0.5 * u : u, t1: stage > 0, full: false, end: b.t }; }
          if (stage === 0) {
            if (d > 0 ? b.l <= sl : b.h >= sl) return { R: -1, t1: false, full: true, end: b.t + 60 };
            if (d > 0 ? b.h >= tp1 : b.l <= tp1) { stage = 1; if (d > 0 ? b.h >= tp2 : b.l <= tp2) return { R: 0.5 * r1 + 0.5 * r2, t1: true, tp2: true, full: false, end: b.t + 60 }; continue; }
          } else {
            if (d > 0 ? b.l <= entry : b.h >= entry) return { R: 0.5 * r1, t1: true, be: true, full: false, end: b.t + 60 };
            if (d > 0 ? b.h >= tp2 : b.l <= tp2) return { R: 0.5 * r1 + 0.5 * r2, t1: true, tp2: true, full: false, end: b.t + 60 };
          }
        }
        const last = m1[m1.length - 1], u = ((last.c - entry) * d) / risk;
        return { R: stage ? 0.5 * r1 + 0.5 * u : u, t1: stage > 0, full: false, end: nowT, open: true };
      };
      // o: { d, kind: 'limit'|'market'|'confirm', entry (limit price / touch level), top (confirm: close beyond this), sl,
      //      tp1 (number) or legHigh: true (TP1 = extreme between start and the touch), start, expiry, cancel (limit only) }
      const run = (o) => {
        const d = o.d; let j = lb(m1, o.start), touchT = null, ext = null;
        if (o.kind === 'market') return finish(j, o.entry, o.tp1);
        for (; j < m1.length; j++) {
          const b = m1[j];
          if (b.t >= o.expiry) return null;
          if (!touchT) {
            if (o.cancel != null && (d > 0 ? b.h > o.cancel : b.l < o.cancel)) return null;
            ext = ext == null ? (d > 0 ? b.h : b.l) : d > 0 ? Math.max(ext, b.h) : Math.min(ext, b.l);
            if (d > 0 ? b.l <= o.entry : b.h >= o.entry) {
              if (o.kind === 'limit') { if (d > 0 ? b.l <= o.sl : b.h >= o.sl) return rec({ R: -1, t1: false, full: true, end: b.t + 60 }, b.t); return finish(j + 1, o.entry, o.legHigh ? ext : o.tp1, b.t); }
              touchT = b.t; break;
            }
          }
        }
        if (!touchT) return null;
        // 5m confirmation after the touch
        for (let k = lb(m5, touchT - 299); k < m5.length; k++) {
          const b = m5[k], T = b.t + 300;
          if (T <= touchT) continue;
          if (T > o.expiry) return null;
          if (d > 0 ? b.l <= o.sl : b.h >= o.sl) return null;            // stop level traded before any confirmation: no trade
          if ((d > 0 ? b.c > b.o && b.c > o.top : b.c < b.o && b.c < o.top) && mom1(T, d)) {
            const risk = Math.abs(b.c - o.sl), base = Math.abs(o.entry - o.sl);
            if (risk > 1.8 * base) return null;
            return finish(lb(m1, T), b.c, o.legHigh ? ext : o.tp1, T);
          }
        }
        return null;
      };
      const finish = (j, entry, tp1, t) => {
        const o = cur, d = o.d, risk = Math.abs(entry - o.sl);
        if (!(risk > 0) || tp1 == null || (tp1 - entry) * d / risk < 0.6) return null; // TP1 must be worth at least 0.6R
        const tp2 = tp1 + d * Math.abs(tp1 - entry);
        return rec(manage(j, entry, o.sl, tp1, tp2, d), t || (m1[j] ? m1[j].t : nowT));
      };
      const rec = (r, t) => Object.assign(r, { t });
      let cur = null;
      const res = {}, busy = {};
      const take = (name, o, filt) => {
        for (const f of FILTERS) {
          if (!filt[f]) continue;
          const key = name + '|' + f;
          if ((busy[key] || 0) > o.start) continue;
          cur = o; const r = run(o);
          if (!r) continue;
          busy[key] = r.end;
          const a = (res[key] = res[key] || { n: 0, t1: 0, full: 0, be: 0, tp2: 0, w: 0, R: 0, h1: 0, h2: 0, gw: 0, gl: 0 });
          a.n++; if (r.t1) a.t1++; if (r.full) a.full++; if (r.be) a.be++; if (r.tp2) a.tp2++; if (r.R > 0) a.w++;
          if (r.R > 0) a.gw += r.R; else a.gl -= r.R; a.R += r.R; if (r.t < mid) a.h1 += r.R; else a.h2 += r.R;
        }
      };

      const H = [], L = []; let ph = 0, pl = 0; // confirmed 15m pivots so far
      const usedOTE = new Set(), sr = { 1: [], '-1': [] };
      const i0 = Math.max(lb(m15, winStart), 210);
      for (let i = i0; i < m15.length - 1; i++) {
        while (ph < pv15.H.length && pv15.H[ph].conf <= i) H.push(pv15.H[ph++]);
        while (pl < pv15.L.length && pv15.L[pl].conf <= i) L.push(pv15.L[pl++]);
        const b = m15[i], T = b.t + 900, atr = atr15[i], tr = trendAt(h1, e1h, 3600, T);
        if (!tr || !(atr > 0)) continue;
        if ((b.c - e15[i]) * tr <= 0) continue;
        const d = tr, t4 = trendAt(h4, e4h, 14400, T), dr = dealing(T);
        const filt = (price) => { const inDisc = dr && dr.hi > dr.lo && (d > 0 ? price <= (dr.hi + dr.lo) / 2 : price >= (dr.hi + dr.lo) / 2); const h4ok = t4 === d; return { base: true, h4: h4ok, disc: !!inDisc, h4disc: h4ok && !!inDisc }; };
        const lastH = H[H.length - 1], lastL = L[L.length - 1];
        const body = (b.c - b.o) * d;
        const exp = T + 24 * 900;

        // ---------- displacement through structure: OB, FVG, CONF ----------
        const swing = d > 0 ? lastH : lastL;
        if (swing && body >= 1.0 * atr && (b.c - swing.p) * d > 0 && (m15[i - 1].c - swing.p) * d <= 0) {
          let ob = null;
          for (let k = i - 1; k >= i - 6; k--) if ((m15[k].c - m15[k].o) * d < 0) { ob = m15[k]; break; }
          if (ob) {
            const top = d > 0 ? ob.h : ob.l, bot = d > 0 ? ob.l : ob.h, sl = bot - d * 0.1 * atr, midp = (ob.h + ob.l) / 2;
            take('OBtop', { d, kind: 'limit', entry: top, sl, legHigh: true, start: T, expiry: exp }, filt(top));
            take('OBmid', { d, kind: 'limit', entry: midp, sl, legHigh: true, start: T, expiry: exp }, filt(midp));
            take('OBc5', { d, kind: 'confirm', entry: top, top, sl, legHigh: true, start: T, expiry: exp }, filt(top));
            // OB + Fib: the leg runs from the lowest low of the 12 bars before the displacement to the displacement high
            let origin = d > 0 ? Infinity : -Infinity; for (let k = i - 12; k <= i; k++) origin = d > 0 ? Math.min(origin, m15[k].l) : Math.max(origin, m15[k].h);
            const legEnd = d > 0 ? b.h : b.l, rg = Math.abs(legEnd - origin);
            const f618 = legEnd - d * 0.618 * rg, f786 = legEnd - d * 0.786 * rg;
            const lo = Math.min(f618, f786), hi = Math.max(f618, f786);
            if (rg > 0 && Math.max(ob.l, lo) <= Math.min(ob.h, hi)) {
              const entry = d > 0 ? Math.min(ob.h, hi) : Math.max(ob.l, lo), sl2 = (d > 0 ? Math.min(ob.l, origin) : Math.max(ob.h, origin)) - d * 0.1 * atr;
              take('CONF', { d, kind: 'limit', entry, sl: sl2, legHigh: true, start: T, expiry: exp }, filt(entry));
              take('CONFc5', { d, kind: 'confirm', entry, top: entry, sl: sl2, legHigh: true, start: T, expiry: exp }, filt(entry));
            }
          }
          // FVG: candle before the displacement vs the candle after it is not known yet; use displacement + previous two
          const a2 = m15[i - 2], gapTop = d > 0 ? b.l : b.h, gapBot = d > 0 ? a2.h : a2.l;
          if ((gapTop - gapBot) * d > 0) {
            const sl = (d > 0 ? Math.min(a2.l, m15[i - 1].l) : Math.max(a2.h, m15[i - 1].h)) - d * 0.1 * atr, ce = (gapTop + gapBot) / 2;
            take('FVGtop', { d, kind: 'limit', entry: gapTop, sl, legHigh: true, start: T, expiry: exp }, filt(gapTop));
            take('FVGce', { d, kind: 'limit', entry: ce, sl, legHigh: true, start: T, expiry: exp }, filt(ce));
            take('FVGc5', { d, kind: 'confirm', entry: gapTop, top: gapTop, sl, legHigh: true, start: T, expiry: exp }, filt(gapTop));
          }
        }

        // ---------- OTE on a freshly confirmed impulse leg ----------
        const z = d > 0 ? lastH : lastL, zs = d > 0 ? H : L;
        if (z && z.conf === i && !usedOTE.has(z.i)) {
          const prev = zs[zs.length - 2], starts = (d > 0 ? L : H).filter((p) => p.i < z.i), a = starts[starts.length - 1];
          if (a && prev && (z.p - prev.p) * d > 0) {
            const rg = Math.abs(z.p - a.p);
            if (rg >= 1.5 * atr) {
              usedOTE.add(z.i);
              const sl = a.p - d * 0.1 * atr, f705 = z.p - d * 0.705 * rg, f618 = z.p - d * 0.618 * rg;
              take('OTE705', { d, kind: 'limit', entry: f705, sl, tp1: z.p, start: T, expiry: exp, cancel: z.p }, filt(f705));
              take('OTE618', { d, kind: 'limit', entry: f618, sl, tp1: z.p, start: T, expiry: exp, cancel: z.p }, filt(f618));
              take('OTEc5', { d, kind: 'confirm', entry: f618, top: f618, sl, tp1: z.p, start: T, expiry: exp }, filt(f618));
            }
          }
        }

        // ---------- support/resistance flip (1H swing levels) ----------
        {
          const jh = lastClosed(h1, 3600, T), lv = (d > 0 ? pv1h.H : pv1h.L).filter((p) => p.conf <= jh).slice(-6);
          for (const p of lv) {
            if ((b.c - p.p) * d > 0 && (m15[i - 1].c - p.p) * d <= 0 && !sr[d].includes(p.i)) {
              sr[d].push(p.i);
              const sl = p.p - d * 0.6 * atr, touch = p.p + d * 0.1 * atr;
              take('SRc5', { d, kind: 'confirm', entry: touch, top: p.p, sl, legHigh: true, start: T, expiry: exp }, filt(p.p));
            }
          }
        }

        // ---------- liquidity sweep with the trend ----------
        {
          const sw = d > 0 ? lastL : lastH, opp = d > 0 ? lastH : lastL;
          if (sw && opp && (d > 0 ? b.l < sw.p && b.c > sw.p : b.h > sw.p && b.c < sw.p) && body > 0) {
            const sl = (d > 0 ? b.l : b.h) - d * 0.1 * atr;
            take('SWEEP', { d, kind: 'market', entry: b.c, sl, tp1: opp.p, start: T, expiry: T + 60 }, filt(b.c));
            take('SWEEPc5', { d, kind: 'confirm', entry: b.c, top: b.c, sl, tp1: opp.p, start: T, expiry: T + 8 * 900 }, filt(b.c));
          }
        }
      }
      for (const k in res) for (const f of ['R', 'h1', 'h2', 'gw', 'gl']) res[k][f] = Math.round(res[k][f] * 100) / 100;
      lab.done[sym] = { name: mk.name, market: mk.market, days: Math.round(((nowT - winStart) / 86400) * 10) / 10, res };
    } catch (e) { lab.err[sym] = String((e && e.message) || e); }
    save();
  }
  lab.fin = true; lab.progress = 'finished'; save();
  try { feed.ws.onclose = null; feed.ws.close(); } catch (e) {}
  return 'done';
});
