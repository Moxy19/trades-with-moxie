/*!
 * TradesbySci — Past Floor Retest engine (built on the Royal Trades v1.4.3 engine)
 * Strategy decoded from the "Synthetic Indices Trader" YouTube channel: higher-timeframe structure sets the bias,
 * the opposing move is mapped, and past floors/ceilings inside it become entries (break + retest) and targets.
 * ORB+ is still in here (cfg.orb) so both strategies can run side by side, but it is OFF by default in this version.
 *
 * Royal Trades — ORB+ Engine
 * Multi-timeframe Opening Range Breakout engine with live trade capture.
 * Runs identically in the browser (window.MoxieEngine) and in Node (require).
 *
 * Pipeline per symbol:
 *   1m ticks  ->  aggregate into 2m / 15m / 1H / 2H / 4H  ->  closed-bar indicators (no repaint)
 *   every closed 2m bar -> ORB+ setups (Break, Retest) -> multi-TF filters & score -> signal
 *   every tick -> track open signals (pending fill, SL, TP1 -> BE, TP2, expiry, time exit)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MoxieEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const G = { M1: 60, M2: 120, M5: 300, M15: 900, H1: 3600, H2: 7200, H4: 14400, D1: 86400 };
  const TF_LIST = [G.M1, G.M2, G.M5, G.M15, G.H1, G.H2, G.H4, G.D1];
  const TF_NAME = { 60: '1m', 120: '2m', 300: '5m', 900: '15m', 3600: '1H', 7200: '2H', 14400: '4H', 86400: '1D' };
  const EMA_LENS = [9, 21, 50, 200];

  const DEFAULTS = {
    orb: false,             // TradesbySci: ORB+ off, so its results measure the Sci strategy alone. true = run ORB+ as well
    // ---------- TradesbySci: Past Floor Retest (PFR) ----------
    // Bias from swing structure on biasTf (low then higher low = BUY, high then lower high = SELL), confirmed by confTf not against.
    // Opposing move = the last leg against the bias on biasTf (e.g. the fall into the higher low). Inside it, on floorTfs,
    // a past floor is a swing low that held once and was later broken (ceiling: the mirror for sells).
    // Signal: on a closed 5m bar, price has broken back through a floor and comes back to retest it, and the 5m candle closes
    // away from it in the bias direction. SL beyond the previous floor (or the retest low), TP1 the next floor, TP2 the one after.
    sci: {
      on: true,
      biasTf: 'auto',       // 'auto' = 1D when enough daily bars, else 4H; or 86400 / 14400 / 3600
      confTf: 'auto',       // timeframe that must not be against the bias ('auto' = one step below biasTf)
      pivotW: 2,            // swing pivot width on the bias timeframe
      floorTfs: [3600, 900],// timeframes scanned for past floors/ceilings inside the opposing move
      mergeAtr: 0.35,       // floors closer than this x 1H ATR count as one (the creator: "label it as one floor")
      breakAtr: 0.10,       // a 5m close this far (x 15m ATR) through a floor counts as broken
      retestAtr: 0.30,      // the retest must come back within this distance of the floor
      failAtr: 0.40,        // a close this far back through the floor cancels the break
      slBufAtr: 0.15,       // stop buffer beyond the previous floor / retest swing
      maxRiskAtr: 2.5,      // skip if the stop is wider than this x 15m ATR
      minRiskAtr: 0.5,      // stop never tighter than this x 15m ATR
      minR1: 1.0,           // TP1 (next floor) must be at least this many R away, or it is a trade into the next floor: skip
      r1Max: 3.0,           // TP1 capped here in R
      r2Max: 6.0,           // TP2 capped here in R
      need5m: true,         // retest candle must close beyond the 5m EMA9 in the trade direction
      minScore: 60,         // publish threshold (B grade)
      maxHoldMin: 1440,     // swing-style trades get 24h before a time exit
    },
    orBlock: 3600,          // session block in seconds (3600 = new opening range every hour)
    orMinutes: 15,          // opening range length
    bufferFrac: 0.15,       // breakout must clear the edge by this fraction of range height (tuned on 7d real data)
    trendMode: 'adaptive',  // 'strict' = only with 1H trend; 'adaptive' = also counter-1H scalps when 1H is weak
    minScore: 62,           // publish threshold (B grade)
    minScalpScore: 72,      // counter-1H scalps need more confluence
    chopMin: 0,             // optional 15m efficiency floor (0..1). Off by default: in walk-forward tests it removed more winners than losers
    maxRiskAtr: 1.8,        // stop distance cap in 15m ATRs
    minRiskAtr: 0.35,       // stop distance floor in 15m ATRs (avoid noise stops)
    minRoomR: 1.0,          // need at least 1R to nearest 1H obstacle
    pendingExpiryMin: 30,   // unfilled limit orders expire
    maxHoldMin: 360,        // time exit after 6h
    partialAtTp1: 0.5,      // fraction closed at TP1 (rest runs to TP2)
    three: true,            // ORB+ 3-position plan (Moxy, 24 Nov): 3 equal positions, all aim for TP2. At TP1: positions 1-2 SL -> TP1, position 3 SL -> halfway entry/TP1
    // Runner lab, 25 Nov 2026 (23 markets, 3 windows of ~21 days, ~20 trades/day): after TP1 the user's stops still move as planned
    // (1-2 to TP1, 3 halfway), but there is no fixed TP2: once the best price is +0.6R, every open position's stop trails 0.3R behind it.
    // v1.15 entries: +301R vs +224R, profit factor 2.13 vs 1.86, better in all 3 windows; TP1 rate 78.2% vs 79.2% (runners hold the pair longer). null = old fixed TP2.
    after: { tgt: [5, 5, 5], trail: { from: 0.6, dist: 0.3 } },
    lockAtTp1: 0.5,         // Royal Ladder: after TP1 the stop moves this far from entry towards TP1 (0 = entry, 0.5 = halfway)
    lossGuard: true,        // block same-direction re-entry after SL until structure resets
    retest: false,          // ORB retest continuation setups (off: they lost money in real-data tests)
    triggerTf: 120,         // candle that must close beyond the range: 120 = 2m, 300 = 5m
    m5Filter: 'momentum',   // 5m gate (default momentum: best in real-data tests, both halves): 'off' | 'aligned' (5m trend with trade) | 'notAgainst' | 'side' (5m close on right side of EMA21) | 'momentum' (last 5m candle with trade)
    m5Score: true,          // add +5 score when the 5m trend agrees
    // Per-market profiles from real-data backtests (22 Nov 2026). Keys: a symbol, or a source ('mt5' = Weltrade via MT5 bridge).
    overrides: { mt5: { m5Filter: 'off', m5Score: false } },     // 5m gate hurt Weltrade SyntX (34% vs 43% win)
    // "Royalty" markets: ORB+ lost money in the 23 Nov 2026 strategy lab (20,000 1m bars each: ~14 days synthetics,
    // ~20 days forex/crypto) or, for Weltrade SyntX, in the 7-day test. Signals carry a Royalty tag: watch or minimum size.
    unproven: ['mt5', 'stpRNG', 'R_75', '1HZ25V', 'frxEURUSD', 'frxUSDJPY', 'frxUSDCHF', 'frxNZDUSD', 'frxGBPJPY', 'frxEURGBP', 'cryETHUSD'],
    entryMode: 'auto',      // 'auto' = limit back at the edge when the trigger candle over-extends; 'market' = always market; 'skip' = skip over-extended breaks
    r1Min: 1.0, r1Max: 1.5, // TP1 bounds in R (measured move = range height; tuned: losers often reached 0.5-0.9R first)
    r2Min: 1.8, r2Max: 3,   // TP2 bounds in R (2x range height)
    // Royal Ladder: OFF since v1.4.3 (25 Nov 2026 lab: 1464 trades, -40R; removing it lifted PF 1.34 -> 1.70).
    // The decoded + refined gold-signal strategy (limit at fresh 15m swing points, 5-TP ladder).
    // Distances are 15m-ATR multiples calibrated on gold (median ATR $7.37: $3 front-run, $12 SL, $4/$8/$13/$18/$28 TPs).
    ladder: { on: false, markets: ['forex', 'crypto'], symbols: [], units: { frxXAUUSD: 7.37 }, w: 5, front: 0.41, sl: 1.63, tps: [0.54, 1.09, 1.76, 2.44, 3.80], beAt: 2, expH: 4, holdH: 24, away: 0.41 },
    // Ladder lab, 23 Nov 2026 (20,000 1m bars each; gold uses fixed $ distances: 41 days, 48 trades, 85% TP1, +12.5R):
    // losing or flat markets carry the Royalty tag.
    ladderRoyalty: ['frxEURUSD', 'frxUSDCHF', 'frxEURGBP', 'cryBTCUSD', 'cryETHUSD'],
    signalsEnabledFrom: 0,  // epoch; used by backtests to warm up
  };

  // ---------- helpers ----------
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const last = (a, k = 1) => a[a.length - k];
  const num = (x) => (typeof x === 'string' ? parseFloat(x) : x);
  const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  function decimalsOf(pip) {
    if (pip == null) return 2;
    if (pip >= 1 && Number.isInteger(pip)) return pip; // ticks_history gives decimals count
    const s = String(pip);
    if (s.includes('e-')) return parseInt(s.split('e-')[1], 10);
    const i = s.indexOf('.');
    return i < 0 ? 0 : s.length - i - 1;
  }
  function fmt(p, d) { return p == null || isNaN(p) ? '—' : Number(p).toFixed(d == null ? 2 : d); }
  function toBar(c) {
    return { t: num(c.open_time != null ? c.open_time : c.epoch), o: num(c.open), h: num(c.high), l: num(c.low), c: num(c.close) };
  }

  // ---------- Series: closed bars + incremental indicators ----------
  class Series {
    constructor(g, max = 3000) {
      this.g = g; this.max = max; this.bars = []; this.forming = null;
      this.ema = {}; EMA_LENS.forEach((n) => (this.ema[n] = []));
      this.atr = [];
    }
    pushClosed(b) {
      const prev = last(this.bars);
      this.bars.push(b);
      for (const n of EMA_LENS) {
        const arr = this.ema[n]; const p = last(arr);
        arr.push(p == null ? b.c : p + (2 / (n + 1)) * (b.c - p));
      }
      const tr = prev ? Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c)) : b.h - b.l;
      const pa = last(this.atr);
      this.atr.push(pa == null ? tr : (pa * 13 + tr) / 14);
      if (this.bars.length > this.max) {
        const cut = this.bars.length - Math.floor(this.max * 0.8);
        this.bars.splice(0, cut); this.atr.splice(0, cut);
        for (const n of EMA_LENS) this.ema[n].splice(0, cut);
      }
    }
    // Feed a (possibly partial) 1m bar. Returns the bar that just closed, if any.
    update(b) {
      const bucket = Math.floor(b.t / this.g) * this.g;
      const f = this.forming;
      if (!f) { this.forming = { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c }; return null; }
      if (bucket > f.t) {
        this.pushClosed(f);
        this.forming = { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c };
        return f;
      }
      if (bucket === f.t) {
        if (this.g === 60) { f.h = Math.max(f.h, b.h); f.l = Math.min(f.l, b.l); f.c = b.c; }
        else { f.h = Math.max(f.h, b.h); f.l = Math.min(f.l, b.l); f.c = b.c; }
      }
      return null;
    }
    seed(candles, treatLastAsForming = true) {
      const bars = candles.map(toBar).sort((a, b) => a.t - b.t);
      const closed = treatLastAsForming ? bars.slice(0, -1) : bars;
      for (const b of closed) this.pushClosed(b);
      this.forming = treatLastAsForming && bars.length ? { ...last(bars) } : null;
    }
    get n() { return this.bars.length; }
    e(n, k = 1) { return last(this.ema[n], k); }
    get atrv() { return last(this.atr); }
    get close() { return this.forming ? this.forming.c : (last(this.bars) || {}).c; }
  }

  // fractal pivots on closed bars (left=right=2)
  function pivots(s, lookback = 150, w = 2) {
    const b = s.bars, n = b.length, highs = [], lows = [];
    for (let i = Math.max(w, n - lookback); i < n - w; i++) {
      let hi = true, lo = true;
      for (let k = 1; k <= w; k++) {
        if (b[i].h <= b[i - k].h || b[i].h < b[i + k].h) hi = false;
        if (b[i].l >= b[i - k].l || b[i].l > b[i + k].l) lo = false;
      }
      if (hi) highs.push({ i, t: b[i].t, p: b[i].h });
      if (lo) lows.push({ i, t: b[i].t, p: b[i].l });
    }
    return { highs, lows };
  }

  // Trend read for one timeframe (closed bars only)
  function trendOf(s) {
    const out = { dir: 'FLAT', score: 0, strength: 0, parts: {} };
    if (!s || s.n < 30) return out;
    const c = last(s.bars).c, e21 = s.e(21), e50 = s.e(50), e200 = s.e(200);
    const slope = e50 - (s.ema[50][s.n - 6] != null ? s.ema[50][s.n - 6] : e50);
    let sc = 0;
    if (s.n >= 200) { sc += e50 > e200 ? 1 : -1; out.parts.stack = e50 > e200 ? 'EMA50>200' : 'EMA50<200'; }
    sc += c > e50 ? 1 : -1;
    sc += slope > 0 ? 1 : -1;
    const pv = pivots(s, 120);
    if (pv.highs.length >= 2 && pv.lows.length >= 2) {
      const hh = last(pv.highs).p > last(pv.highs, 2).p, hl = last(pv.lows).p > last(pv.lows, 2).p;
      if (hh && hl) { sc += 1; out.parts.structure = 'HH/HL'; }
      else if (!hh && !hl) { sc -= 1; out.parts.structure = 'LH/LL'; }
      else out.parts.structure = 'mixed';
    }
    out.score = sc;
    out.dir = sc >= 2 ? 'UP' : sc <= -2 ? 'DOWN' : 'FLAT';
    out.strength = Math.min(1, Math.abs(sc) / 4);
    out.above21 = c > e21; out.e21over50 = e21 > e50; out.close = c; out.e21 = e21; out.e50 = e50;
    return out;
  }

  // Kaufman efficiency ratio over n closed bars: 1 = clean trend, 0 = pure chop
  function efficiency(s, n = 16) {
    if (!s || s.n < n + 1) return 0.5;
    const b = s.bars, end = b.length - 1;
    const change = Math.abs(b[end].c - b[end - n].c);
    let path = 0; for (let i = end - n + 1; i <= end; i++) path += Math.abs(b[i].c - b[i - 1].c);
    return path === 0 ? 0 : change / path;
  }

  const dirSign = (d) => (d === 'BUY' ? 1 : -1);
  const want = (d) => (d === 'BUY' ? 'UP' : 'DOWN');
  const against = (d) => (d === 'BUY' ? 'DOWN' : 'UP');

  // ---------- Engine ----------
  class Engine {
    constructor(cfg = {}, hooks = {}) {
      this.cfg = Object.assign({}, DEFAULTS, cfg);
      this.hooks = hooks; // onSignal(sig), onUpdate(sig, prevStatus), onReject(info)
      this.sym = {};      // symbol state
      this.signals = [];  // all signals (open + closed)
      this.mode = 'live'; // 'live' (exact tick order) | 'backtest' (bar extremes, pessimistic)
    }
    setConfig(c) { Object.assign(this.cfg, c); }

    addSymbol(symbol, meta = {}) {
      if (this.sym[symbol]) return this.sym[symbol];
      const st = {
        symbol, name: meta.name || symbol, market: meta.market || 'synthetic', source: meta.source || 'deriv', dec: decimalsOf(meta.pip != null ? meta.pip : meta.decimals),
        series: {}, block: null, price: null, lastT: 0, guard: { BUY: null, SELL: null }, ready: false,
      };
      for (const g of TF_LIST) st.series[g] = new Series(g, g === 60 ? 3000 : 2500);
      this.sym[symbol] = st; return st;
    }

    // seed history for one timeframe. For g=60 also rebuilds the current opening range.
    seed(symbol, g, candles, opts = {}) {
      const st = this.sym[symbol]; if (!st || !candles || !candles.length) return;
      if (opts.decimals != null) st.dec = decimalsOf(opts.decimals);
      const s = st.series[g];
      s.seed(candles, opts.forming !== false);
      if (g === 60) {
        for (const b of s.bars) this._orUpdate(st, b, true);
        if (s.forming) { st.price = s.forming.c; st.lastT = s.forming.t; }
      }
    }
    // after all timeframes seeded: mark breakouts that already happened in the current block
    finishSeed(symbol) {
      const st = this.sym[symbol]; if (!st) return;
      const tg = this.cfg.triggerTf === G.M5 ? G.M5 : G.M2;
      const b = st.block, s2 = st.series[tg];
      if (b && b.done) {
        const buf = (b.hi - b.lo) * this.cfg.bufferFrac;
        for (const x of s2.bars) {
          if (x.t + tg <= b.orEnd || x.t < b.start) continue;
          if (x.c > b.hi + buf) b.brokeUp = b.retestUp = true;
          if (x.c < b.lo - buf) b.brokeDn = b.retestDn = true;
        }
      }
      st.ready = true;
      // replay closed 1m history through open signals restored from storage
      for (const sig of this.openSignals(symbol)) {
        for (const x of st.series[60].bars) if (x.t >= (sig.lastT || sig.createdAt)) { if (sig.strategy === 'LADDER') this._trackLadder(sig, st, x.h, x.l, x.t + 60, x.c); else this._track(sig, st, x.h, x.l, x.t + 60, x.c, true); }
      }
    }

    restoreSignals(list) {
      for (const s of list || []) if (!this.signals.find((x) => x.id === s.id)) this.signals.push(s);
      this.signals.sort((a, b) => a.createdAt - b.createdAt);
    }
    openSignals(symbol) {
      return this.signals.filter((s) => (!symbol || s.symbol === symbol) && ['PENDING', 'ACTIVE', 'TP1_HIT'].includes(s.status));
    }

    // Live: feed every 1m ohlc update (Deriv 'ohlc' message or candle). Backtest: feed each closed 1m bar.
    onBar(symbol, raw) {
      const st = this.sym[symbol]; if (!st) return;
      const bar = raw.t != null ? raw : toBar(raw);
      if (!isFinite(bar.c)) return;
      const s1 = st.series[60];
      const prevForming = s1.forming;
      // 1) aggregate into every timeframe, collecting closures
      const closed = {};
      for (const g of TF_LIST) { const c = st.series[g].update(bar); if (c) closed[g] = c; }
      if (closed[60]) this._orUpdate(st, closed[60], false);
      st.price = bar.c; st.lastT = bar.t;
      // 2) strategy on closed 2m bar
      const trig = this.cfg.triggerTf === G.M5 ? G.M5 : G.M2;
      if (closed[trig] && st.ready && this.cfg.orb !== false) this._evaluate(st, closed[trig], trig);
      if (closed[G.M5] && st.ready && this.cfg.sci && this.cfg.sci.on) this._sci(st, closed[G.M5]);
      if (closed[G.M15] && st.ready && this._ladderOn(st)) this._ladder(st, closed[G.M15]);
      // 3) track open signals with the newest data
      const isNewMinute = !prevForming || bar.t > prevForming.t;
      let hi = bar.c, lo = bar.c;
      if (this.mode === 'backtest') { hi = bar.h; lo = bar.l; }
      const now = this.mode === 'backtest' ? bar.t + 60 : Math.max(bar.t, Math.floor(Date.now() / 1000));
      for (const sig of this.openSignals(symbol)) {
        if (sig.createdAt > now) continue;
        if (sig.strategy === 'LADDER') this._trackLadder(sig, st, hi, lo, now, bar.c);
        else this._track(sig, st, hi, lo, now, bar.c, isNewMinute);
      }
    }

    // ---------- opening range ----------
    _orUpdate(st, b1, seeding) {
      const cfg = this.cfg;
      const start = Math.floor(b1.t / cfg.orBlock) * cfg.orBlock;
      if (!st.block || st.block.start !== start) {
        st.block = { start, end: start + cfg.orBlock, orEnd: start + cfg.orMinutes * 60, hi: null, lo: null, done: false,
          brokeUp: false, brokeDn: false, retestUp: false, retestDn: false };
        // new block resets the loss guard only if structure changed (handled in guard check)
      }
      const b = st.block;
      if (b1.t < b.orEnd) {
        b.hi = b.hi == null ? b1.h : Math.max(b.hi, b1.h);
        b.lo = b.lo == null ? b1.l : Math.min(b.lo, b1.l);
      }
      if (b1.t + 60 >= b.orEnd && b.hi != null) b.done = true;
    }

    // ---------- setups ----------
    _evaluate(st, bar2, tg = G.M2) {
      const cfg = this.cfg, b = st.block;
      const T = bar2.t + tg;
      if (!b || !b.done || T <= b.orEnd || T > b.end) return;
      if (T < cfg.signalsEnabledFrom) return;
      const h = b.hi - b.lo; if (!(h > 0)) return;
      const buf = h * cfg.bufferFrac, mid = (b.hi + b.lo) / 2;
      const cands = [];
      if (!b.brokeUp && bar2.c > b.hi + buf) { b.brokeUp = true; cands.push({ dir: 'BUY', setup: 'ORB Break' }); }
      if (!b.brokeDn && bar2.c < b.lo - buf) { b.brokeDn = true; cands.push({ dir: 'SELL', setup: 'ORB Break' }); }
      if (cfg.retest) {
        if (b.brokeUp && !b.retestUp && !cands.length && bar2.l <= b.hi + 0.25 * h && bar2.l > mid && bar2.c > b.hi && bar2.c > bar2.o) {
          b.retestUp = true; cands.push({ dir: 'BUY', setup: 'ORB Retest' });
        }
        if (b.brokeDn && !b.retestDn && !cands.length && bar2.h >= b.lo - 0.25 * h && bar2.h < mid && bar2.c < b.lo && bar2.c < bar2.o) {
          b.retestDn = true; cands.push({ dir: 'SELL', setup: 'ORB Retest' });
        }
      }
      for (const c of cands) this._consider(st, c, bar2, T, h, mid);
    }

    _cfgFor(st) {
      const o = this.cfg.overrides || {};
      return Object.assign({}, this.cfg, o[st.source] || {}, o[st.symbol] || {});
    }
    _consider(st, cand, bar2, T, h, mid) {
      const cfg = this._cfgFor(st), b = st.block, dir = cand.dir, sgn = dirSign(dir);
      const S = st.series;
      const reject = (why) => { this.hooks.onReject && this.hooks.onReject({ symbol: st.symbol, dir, setup: cand.setup, t: T, why }); return null; };
      if (this.openSignals(st.symbol).some((x) => x.strategy !== 'LADDER')) return reject('Trade already open on this pair');

      const tH4 = trendOf(S[G.H4]), tH2 = trendOf(S[G.H2]), tH1 = trendOf(S[G.H1]), t15 = trendOf(S[G.M15]);
      const atr15 = S[G.M15].atrv || h;
      const er15 = efficiency(S[G.M15], 16);
      const m1 = S[G.M1];
      const mom1 = m1.n > 21 && (sgn > 0 ? last(m1.bars).c > m1.e(9) && m1.e(9) > m1.e(21) : last(m1.bars).c < m1.e(9) && m1.e(9) < m1.e(21));
      // 5m read: trend, side of EMA21, last-candle momentum
      const s5 = S[G.M5], t5 = trendOf(s5), l5 = last(s5.bars);
      const side5 = !!l5 && s5.n > 21 && (sgn > 0 ? l5.c > s5.e(21) : l5.c < s5.e(21));
      const mom5 = !!l5 && s5.n > 9 && (sgn > 0 ? l5.c > l5.o && l5.c > s5.e(9) : l5.c < l5.o && l5.c < s5.e(9));
      if (cfg.m5Filter === 'aligned' && t5.dir !== want(dir)) return reject('5m trend not aligned');
      if (cfg.m5Filter === 'notAgainst' && t5.dir === against(dir)) return reject('5m trend against');
      if (cfg.m5Filter === 'side' && !side5) return reject('5m closed on the wrong side of EMA21');
      if (cfg.m5Filter === 'momentum' && !mom5) return reject('Last 5m candle not with the trade');

      // --- the 1H rule (strict or adaptive) ---
      let kind = 'TREND';
      if (tH1.dir === want(dir)) kind = 'TREND';
      else if (cfg.trendMode === 'strict') return reject('Against / without 1H trend (strict mode)');
      else {
        // adaptive: counter-1H scalp only if 1H is weak, 15m strongly with us, 1m momentum, 4H not against
        const h1Strong = tH1.dir === against(dir) && Math.abs(tH1.score) >= 3;
        if (h1Strong) return reject('Strong 1H trend against — blocked');
        if (t15.dir !== want(dir)) return reject('Counter-1H scalp needs 15m aligned');
        if (!mom1) return reject('Counter-1H scalp needs 1m momentum');
        if (tH4.dir === against(dir)) return reject('Counter-1H scalp with 4H against — blocked');
        kind = 'SCALP';
      }
      // --- 15m must not be against (check 15m and 1H always) ---
      const m15ok = t15.dir === want(dir) || (t15.dir === 'FLAT' && (sgn > 0 ? t15.above21 : !t15.above21));
      if (!m15ok) return reject('15m not aligned');
      // --- higher-TF veto: 2H and 4H both against ---
      if (tH4.dir === against(dir) && tH2.dir === against(dir)) return reject('2H and 4H both against');
      // --- chop filter ---
      if (er15 < cfg.chopMin) return reject('15m is ranging (efficiency ' + er15.toFixed(2) + ')');
      // --- loss guard: no same-direction re-entry after SL until a fresh opening range AND 15m swing confirms ---
      const g = st.guard[dir];
      if (cfg.lossGuard && g) {
        const pv = pivots(S[G.M15], 60);
        const fresh = sgn > 0 ? pv.lows.some((p) => p.t > g.t && p.p > g.level) : pv.highs.some((p) => p.t > g.t && p.p < g.level);
        if (b.start <= g.block || !fresh) return reject('Loss guard: waiting for structure reset after SL');
        st.guard[dir] = null;
      }

      // --- entry ---
      const edge = sgn > 0 ? b.hi : b.lo;
      const dist = Math.abs(bar2.c - edge);
      let entryType = 'MARKET', entry = bar2.c;
      if (cand.setup === 'ORB Break' && dist > 0.4 * h) {
        if (cfg.entryMode === 'skip') return reject('Breakout candle over-extended from the range');
        if (cfg.entryMode === 'auto') { entryType = 'LIMIT'; entry = edge + sgn * 0.15 * h; }
      }
      // --- stop: beyond range midpoint or the recent 2m swing, whichever protects better ---
      const s2 = S[G.M2].bars.slice(-3);
      const swing = sgn > 0 ? Math.min(...s2.map((x) => x.l)) : Math.max(...s2.map((x) => x.h));
      let sl = sgn > 0 ? Math.min(mid, swing) : Math.max(mid, swing);
      sl -= sgn * 0.05 * atr15;
      let risk = Math.abs(entry - sl);
      if (risk > cfg.maxRiskAtr * atr15) {
        // try the tighter of the two references before giving up
        const alt = (sgn > 0 ? Math.max(mid, swing) : Math.min(mid, swing)) - sgn * 0.05 * atr15;
        if (Math.abs(entry - alt) <= cfg.maxRiskAtr * atr15 && sgn * (entry - alt) > 0) { sl = alt; risk = Math.abs(entry - sl); }
        else return reject('Stop would be too wide (' + (risk / atr15).toFixed(1) + '× ATR)');
      }
      if (risk < cfg.minRiskAtr * atr15) { risk = cfg.minRiskAtr * atr15; sl = entry - sgn * risk; }

      // --- room to the nearest 1H obstacle ---
      const pvH1 = pivots(S[G.H1], 200);
      const obs = sgn > 0 ? pvH1.highs.map((p) => p.p).filter((p) => p > entry) : pvH1.lows.map((p) => p.p).filter((p) => p < entry);
      const nearest = obs.length ? (sgn > 0 ? Math.min(...obs) : Math.max(...obs)) : null;
      const roomR = nearest == null ? 99 : Math.abs(nearest - entry) / risk;
      if (roomR < cfg.minRoomR) return reject('No room: 1H level ' + roomR.toFixed(2) + 'R away');

      // --- targets ---
      let r1 = clamp(h / risk, cfg.r1Min, kind === 'SCALP' ? Math.min(cfg.r1Max, cfg.r1Min + 0.2) : cfg.r1Max);
      let r2 = kind === 'SCALP' ? clamp(1.6 * h / risk, r1 + 0.3, Math.max(r1 + 0.3, cfg.r2Min)) : clamp((2 * h) / risk, Math.max(cfg.r2Min, r1 + 0.8), cfg.r2Max);
      if (nearest != null && roomR < r1) r1 = Math.max(1.0, roomR * 0.95);
      if (nearest != null && roomR < r2 && roomR > r1 + 0.3) r2 = roomR * 0.97;
      const tp1 = entry + sgn * r1 * risk, tp2 = entry + sgn * r2 * risk;

      // --- score (0..100) ---
      const reasons = [];
      let score = 0;
      const add = (pts, ok, label, detail) => { score += pts; reasons.push({ ok, pts, label, detail }); };
      if (kind === 'TREND') add(15 + Math.round(10 * tH1.strength), true, '1H trend ' + tH1.dir, tH1.parts.structure ? tH1.parts.structure + ', ' + (tH1.parts.stack || '') : tH1.parts.stack || '');
      else add(6, true, '1H weak/flat — scalp only', '1H score ' + tH1.score);
      add(tH4.dir === want(dir) ? 15 : tH4.dir === 'FLAT' ? 7 : 0, tH4.dir !== against(dir), '4H ' + tH4.dir, '');
      add(tH2.dir === want(dir) ? 10 : tH2.dir === 'FLAT' ? 5 : 0, tH2.dir !== against(dir), '2H ' + tH2.dir, '');
      add(t15.dir === want(dir) ? 15 : 8, true, '15m ' + (t15.dir === want(dir) ? 'aligned' : 'neutral, right side of EMA21'), '');
      add(mom1 ? 10 : 0, mom1, '1m momentum', mom1 ? 'EMA9 > EMA21 in trade direction' : 'not confirmed');
      add(cfg.m5Score && t5.dir === want(dir) ? 5 : 0, t5.dir !== against(dir), '5m ' + t5.dir + (side5 ? ', right side of EMA21' : ''), mom5 ? 'last 5m candle with the trade' : '');
      const body = Math.abs(bar2.c - bar2.o), rng = bar2.h - bar2.l || 1e-9;
      const closePos = sgn > 0 ? (bar2.c - bar2.l) / rng : (bar2.h - bar2.c) / rng;
      add((body / rng >= 0.5 ? 5 : 0) + (closePos >= 0.7 ? 5 : 0), body / rng >= 0.5, '2m trigger candle', Math.round((body / rng) * 100) + '% body, closed ' + Math.round(closePos * 100) + '% toward ' + (sgn > 0 ? 'high' : 'low'));
      const hq = h / atr15;
      add(hq >= 0.6 && hq <= 2.5 ? 10 : hq >= 0.4 && hq <= 3.5 ? 5 : 0, hq >= 0.4 && hq <= 3.5, 'Range quality', (hq).toFixed(2) + '× 15m ATR');
      add(roomR >= 2 ? 5 : 0, roomR >= 2, 'Room to 1H structure', roomR >= 99 ? 'open sky' : roomR.toFixed(1) + 'R');
      reasons.push({ ok: true, pts: 0, label: '15m trend quality', detail: 'efficiency ' + er15.toFixed(2) });
      score = Math.min(100, score);
      const minS = kind === 'SCALP' ? cfg.minScalpScore : cfg.minScore;
      if (score < minS) return reject('Score ' + score + ' below ' + minS);
      const grade = score >= 85 ? 'A+' : score >= 74 ? 'A' : 'B';

      const sig = {
        id: uid(), symbol: st.symbol, name: st.name, market: st.market, source: st.source, dec: st.dec,
        setup: cand.setup, kind, dir, tf: TF_NAME[cfg.triggerTf === G.M5 ? G.M5 : G.M2], entryType, entry, sl, slLive: sl, tp1, tp2, risk, r1, r2,
        score, grade, reasons, unproven: (cfg.unproven || []).includes(st.symbol) || (cfg.unproven || []).includes(st.source),
        bias: { H4: tH4.dir, H2: tH2.dir, H1: tH1.dir, M15: t15.dir, M5: t5.dir, M1: mom1 ? want(dir) : 'FLAT' },
        or: { hi: b.hi, lo: b.lo, start: b.start, end: b.end, orEnd: b.orEnd },
        status: entryType === 'LIMIT' ? 'PENDING' : 'ACTIVE',
        createdAt: T, filledAt: entryType === 'LIMIT' ? null : T, tp1At: null, closedAt: null, lastT: T,
        result: null, mfeR: 0, maeR: 0, price: bar2.c, exit: null,
      };
      sig.text = this.narrative(sig, { atr15, er15, h, roomR, nearest });
      this.signals.push(sig);
      if (this.cfg.three && this.cfg.after) sig.runTgtR = Math.max.apply(null, (this.cfg.after.tgt || []).map((x) => (x == null ? sig.r2 : x)).concat([sig.r2])); // furthest target: the robot's broker take profit
      this.hooks.onSignal && this.hooks.onSignal(sig);
      return sig;
    }

    // ---------- live trade capture ----------
    // ---------- runner after TP1 (3-position plan, cfg.after) ----------
    // Each position keeps its own stop (in R) and target. Stops are checked first (pessimistic), then targets; new stops apply from the next bar/tick.
    _afterInit(sig, A, sgn) {
      const lock = A.lock || [1, 1, 0.5], tg = A.tgt || [null, null, null];
      sig.pos = [0, 1, 2].map((i) => ({ stopR: lock[i] * sig.r1, tgtR: tg[i] == null ? sig.r2 : tg[i], open: true, R: null, how: null }));
      sig.peakR = sig.r1; sig.trailFrom = A.trail ? (A.trail.from == null ? sig.r1 : A.trail.from) : null; sig.trailDist = A.trail ? A.trail.dist : null;
      sig.slLive = sig.entry + sgn * Math.min.apply(null, sig.pos.map((p) => p.stopR)) * sig.risk;
      sig.sl12 = sig.entry + sgn * sig.pos[0].stopR * sig.risk; sig.sl3 = sig.entry + sgn * sig.pos[2].stopR * sig.risk; sig.open12 = true; // older readers (cards, robot) still understand these
    }
    _after(sig, st, A, sgn, fav, adv, t, price, first) {
      const R = (px) => (sgn * (px - sig.entry)) / sig.risk;
      const favR = R(fav), advR = R(adv);
      const before = sig.pos.filter((p) => p.open).length;
      if (!first) for (const p of sig.pos) if (p.open && advR <= p.stopR + 1e-12) { p.open = false; p.R = p.stopR; p.how = 'stop'; }
      for (const p of sig.pos) if (p.open && favR >= p.tgtR - 1e-12) { p.open = false; p.R = p.tgtR; p.how = 'tgt'; }
      const timeUp = sig.filledAt && t - sig.filledAt > (sig.maxHoldMin || this.cfg.maxHoldMin) * 60;
      if (timeUp) for (const p of sig.pos) if (p.open) { p.open = false; p.R = Math.max(p.stopR, R(price)); p.how = 'time'; }
      if (!sig.pos.some((p) => p.open)) {
        sig.threeR = sig.pos.reduce((a, p) => a + p.R, 0) / 3;
        const how = sig.pos.every((p) => p.how === 'tgt') ? 'TP2_HIT' : timeUp ? 'TIME_EXIT' : 'TRAIL_EXIT';
        return this._close(sig, st, how, price, t);
      }
      sig.peakR = Math.max(sig.peakR, favR);
      let lvl = -Infinity;
      if (A.trail) { const from = A.trail.from == null ? sig.r1 : A.trail.from; if (sig.peakR >= from - 1e-12) lvl = sig.peakR - A.trail.dist; }
      let moved = false;
      for (const p of sig.pos) if (p.open && lvl > p.stopR + 1e-9) { p.stopR = lvl; moved = true; }
      const open = sig.pos.filter((p) => p.open);
      sig.slLive = sig.entry + sgn * Math.min.apply(null, open.map((p) => p.stopR)) * sig.risk;
      sig.open12 = sig.pos[0].open || sig.pos[1].open;
      if (open.length !== before || moved) this.hooks.onUpdate && this.hooks.onUpdate(sig, 'TP1_HIT');
    }

    _close(sig, st, status, exitPrice, t) {
      const prev = sig.status, sgn = dirSign(sig.dir);
      const rNow = (sgn * (exitPrice - sig.entry)) / sig.risk;
      const p = this.cfg.partialAtTp1;
      let R = 0;
      if (sig.threeR != null) R = sig.threeR; // 3-position plan sets its own result (average of the 3 positions)
      else if (status === 'SL_HIT') R = -1;
      else if (status === 'TP2_HIT') R = p * sig.r1 + (1 - p) * sig.r2;
      else if (status === 'BE_HIT') R = p * sig.r1 + (1 - p) * rNow; // rest closed at the locked stop (entry or part of TP1)
      else if (status === 'TIME_EXIT') R = sig.tp1At ? p * sig.r1 + (1 - p) * rNow : rNow;
      else R = 0; // EXPIRED / CANCELLED never filled
      sig.status = status; sig.closedAt = t; sig.exit = exitPrice; sig.result = Math.round(R * 100) / 100; sig.lastT = t;
      if (status === 'SL_HIT') {
        // arm the loss guard for this direction
        st.guard[sig.dir] = { t, block: st.block ? st.block.start : 0, level: sig.dir === 'BUY' ? Math.min(sig.sl, sig.entry) : Math.max(sig.sl, sig.entry) };
      }
      this.hooks.onUpdate && this.hooks.onUpdate(sig, prev);
    }

    _track(sig, st, hi, lo, t, price, _newMin) {
      const sgn = dirSign(sig.dir), cfg = this.cfg;
      const fav = sgn > 0 ? hi : lo, adv = sgn > 0 ? lo : hi;
      const prev = sig.status;
      sig.price = price; sig.lastT = t;
      if (sig.status === 'PENDING') {
        if (t - sig.createdAt > cfg.pendingExpiryMin * 60) return this._close(sig, st, 'EXPIRED', price, t);
        const filled = sgn > 0 ? adv <= sig.entry : adv >= sig.entry;
        if (!filled) {
          if (sgn > 0 ? fav >= sig.tp1 : fav <= sig.tp1) return this._close(sig, st, 'CANCELLED', price, t); // ran away without us
          return;
        }
        sig.status = 'ACTIVE'; sig.filledAt = t;
        this.hooks.onUpdate && this.hooks.onUpdate(sig, prev);
      }
      // excursions
      sig.mfeR = Math.max(sig.mfeR, (sgn * (fav - sig.entry)) / sig.risk);
      sig.maeR = Math.min(sig.maeR, (sgn * (adv - sig.entry)) / sig.risk);
      if (sig.status === 'ACTIVE') {
        const slHit = sgn > 0 ? adv <= sig.sl : adv >= sig.sl;
        const tp1Hit = sgn > 0 ? fav >= sig.tp1 : fav <= sig.tp1;
        if (slHit) return this._close(sig, st, 'SL_HIT', sig.sl, t); // pessimistic if both in one bar
        if (tp1Hit) {
          sig.status = 'TP1_HIT'; sig.tp1At = t; sig.slLive = sig.entry;
          if (cfg.three && cfg.after) { this._afterInit(sig, cfg.after, sgn); this.hooks.onUpdate && this.hooks.onUpdate(sig, 'ACTIVE'); return this._after(sig, st, cfg.after, sgn, fav, adv, t, price, true); }
          if (cfg.three) {
            sig.sl12 = sig.tp1; sig.sl3 = sig.entry + 0.5 * (sig.tp1 - sig.entry); sig.open12 = true; sig.slLive = sig.sl12;
            this.hooks.onUpdate && this.hooks.onUpdate(sig, 'ACTIVE');
            if (sgn > 0 ? fav >= sig.tp2 : fav <= sig.tp2) { sig.threeR = sig.r2; return this._close(sig, st, 'TP2_HIT', sig.tp2, t); }
            return; // the new stops apply from the next tick/bar
          }
          this.hooks.onUpdate && this.hooks.onUpdate(sig, 'ACTIVE');
          if (sgn > 0 ? fav >= sig.tp2 : fav <= sig.tp2) return this._close(sig, st, 'TP2_HIT', sig.tp2, t);
          if (this.mode === 'backtest') return; // BE can't be ordered inside the same bar; check next bar
        }
      }
      if (sig.status === 'TP1_HIT' && sig.pos) return this._after(sig, st, cfg.after || {}, sgn, fav, adv, t, price, false);
      if (sig.status === 'TP1_HIT') {
        if (sig.sl12 == null && (sgn > 0 ? fav >= sig.tp2 : fav <= sig.tp2)) return this._close(sig, st, 'TP2_HIT', sig.tp2, t);
        if (sig.sl12 != null) {
          // 3-position plan, stops first (pessimistic): positions 1-2 at TP1, position 3 halfway between entry and TP1
          if (sig.open12 && (sgn > 0 ? adv <= sig.sl12 : adv >= sig.sl12)) { sig.open12 = false; sig.slLive = sig.sl3; this.hooks.onUpdate && this.hooks.onUpdate(sig, 'TP1_HIT'); }
          const bank = 2 * sig.r1; // positions 1-2 closed at TP1
          if (!sig.open12 && (sgn > 0 ? adv <= sig.sl3 : adv >= sig.sl3)) { sig.threeR = (bank + 0.5 * sig.r1) / 3; return this._close(sig, st, 'BE_HIT', sig.sl3, t); }
          if (sgn > 0 ? fav >= sig.tp2 : fav <= sig.tp2) { sig.threeR = sig.open12 ? sig.r2 : (bank + sig.r2) / 3; return this._close(sig, st, 'TP2_HIT', sig.tp2, t); }
          if (sig.filledAt && t - sig.filledAt > (sig.maxHoldMin || cfg.maxHoldMin) * 60) { const rNow = (sgn * (price - sig.entry)) / sig.risk; sig.threeR = sig.open12 ? rNow : (bank + rNow) / 3; return this._close(sig, st, 'TIME_EXIT', price, t); }
          return;
        }
        // trades that reached TP1 before the 3-position plan keep their old rule: half closed, stop at entry
        if (sgn > 0 ? adv <= sig.entry : adv >= sig.entry) return this._close(sig, st, 'BE_HIT', sig.entry, t);
      }
      if ((sig.status === 'ACTIVE' || sig.status === 'TP1_HIT') && sig.filledAt && t - sig.filledAt > (sig.maxHoldMin || cfg.maxHoldMin) * 60) {
        return this._close(sig, st, 'TIME_EXIT', price, t);
      }
    }

    // ---------- Royal Ladder ----------
    _ladderOn(st) {
      const L = this.cfg.ladder;
      if (!L || !L.on) return false;
      return (L.symbols || []).includes(st.symbol) || (L.markets || []).includes(st.market);
    }
    _ladder(st, bar15) {
      const L = Object.assign({}, DEFAULTS.ladder, this.cfg.ladder), T = bar15.t + G.M15;
      if (T < this.cfg.signalsEnabledFrom) return;
      if (this.openSignals(st.symbol).some((x) => x.strategy === 'LADDER')) return;
      const b = st.series[G.M15].bars, h1 = st.series[G.H1].bars, w = L.w, n = b.length;
      if (n < 120 || h1.length < 60) return;
      const emaArr = (a, k) => { const m = 2 / (k + 1); let e = null; return a.map((v) => (e = e == null ? v : e + m * (v - e))); };
      const tail15 = b.slice(-400), e15 = emaArr(tail15.map((x) => x.c), 50), last15 = tail15.length - 1;
      let atr = null;
      for (let i = 0; i < tail15.length; i++) { const x = tail15[i]; const tr = i ? Math.max(x.h - x.l, Math.abs(x.h - tail15[i - 1].c), Math.abs(x.l - tail15[i - 1].c)) : x.h - x.l; atr = atr == null ? tr : (atr * 13 + tr) / 14; }
      const tail1h = h1.slice(-400), e1 = emaArr(tail1h.map((x) => x.c), 50), j = tail1h.length - 1;
      const tr1h = tail1h[j].c > e1[j] && e1[j] > e1[j - 3] ? 1 : tail1h[j].c < e1[j] && e1[j] < e1[j - 3] ? -1 : 0;
      if (L.units && L.units[st.symbol]) atr = L.units[st.symbol]; // fixed price distances (gold: the original $ ladder)
      const i = n - 1 - w, px = b[n - 1].c;
      for (const d of [1, -1]) {
        let ok = true;
        for (let k = 1; k <= w; k++) {
          if (d > 0) { if (!(b[i].l < b[i - k].l && b[i].l <= b[i + k].l)) ok = false; }
          else if (!(b[i].h > b[i - k].h && b[i].h >= b[i + k].h)) ok = false;
        }
        if (!ok) continue;
        const lvl = d > 0 ? b[i].l : b[i].h;
        if ((px - lvl) * d < L.away * atr) continue;          // price has moved away, so a limit back at the level makes sense
        if (tr1h === -d) continue;                             // never against the 1H
        if ((px - e15[last15]) * d < 0) continue;              // 15m closed on the trade's side of its EMA50
        const dir = d > 0 ? 'BUY' : 'SELL', S = st.series;
        const entry = lvl + d * L.front * atr, risk = L.sl * atr, sl = entry - d * risk;
        const tps = L.tps.map((x) => entry + d * x * atr), rs = L.tps.map((x) => x / L.sl);
        const bias = { H4: trendOf(S[G.H4]).dir, H2: trendOf(S[G.H2]).dir, H1: tr1h > 0 ? 'UP' : tr1h < 0 ? 'DOWN' : 'FLAT', M15: trendOf(S[G.M15]).dir, M5: trendOf(S[G.M5]).dir };
        const want = d > 0 ? 'UP' : 'DOWN';
        const reasons = [];
        let score = 60;
        const add = (pts, ok2, label, detail) => { if (ok2) score += pts; reasons.push({ ok: ok2, pts: ok2 ? pts : 0, label, detail }); };
        reasons.push({ ok: true, pts: 0, label: 'Fresh 15m swing ' + (d > 0 ? 'low' : 'high'), detail: fmt(lvl, st.dec) + ', confirmed by ' + w + ' candles each side' });
        add(15, bias.H1 === want, '1H trend with the trade', bias.H1);
        add(10, bias.H4 === want, '4H trend with the trade', bias.H4);
        add(5, bias.H2 === want, '2H trend with the trade', bias.H2);
        add(10, bias.M15 === want, '15m trend with the trade', bias.M15 + ', close on the right side of EMA50');
        score = Math.min(100, score);
        const grade = score >= 85 ? 'A+' : score >= 74 ? 'A' : 'B';
        const sig = {
          id: uid(), symbol: st.symbol, name: st.name, market: st.market, source: st.source, dec: st.dec,
          strategy: 'LADDER', setup: 'Royal Ladder', kind: bias.H1 === want ? 'TREND' : 'SCALP', dir, tf: '15m', entryType: 'LIMIT',
          entry, sl, slLive: sl, tp1: tps[0], tp2: tps[1], tps, rs, risk, r1: rs[0], r2: rs[1], stage: 0, beAt: L.beAt,
          expiresAt: T + L.expH * 3600, maxHold: L.holdH * 3600, level: lvl, atr,
          score, grade, reasons, unproven: (this.cfg.ladderRoyalty || []).includes(st.symbol),
          bias, or: null, status: 'PENDING', createdAt: T, filledAt: null, tp1At: null, closedAt: null, lastT: T,
          result: null, mfeR: 0, maeR: 0, price: px, exit: null,
        };
        const dd = st.dec;
        sig.text = [
          `${dir} ${st.name}: Royal Ladder, grade ${grade} (${score}/100).`,
          `A fresh 15m swing ${d > 0 ? 'low' : 'high'} formed at ${fmt(lvl, dd)} and price has moved away from it. The 1H trend is ${bias.H1.toLowerCase()} (never against the trade) and the 15m is on the right side of its EMA50.`,
          `Limit ${dir.toLowerCase()} at ${fmt(entry, dd)}, set just before the level so it fills even if price doesn't quite tag it. Stop ${fmt(sl, dd)}. The order is cancelled if it isn't filled within ${L.expH} hours.`,
          `Five targets: ${tps.map((x, k) => 'TP' + (k + 1) + ' ' + fmt(x, dd)).join(', ')}. Close a fifth at each. After TP1 the stop moves halfway to TP1, so the rest of the trade is locked in profit.`,
          sig.unproven ? 'Royalty: the ladder has no proven edge on this market yet. Watch it, or trade the smallest size only.' : '',
        ].filter(Boolean).join(' ');
        this.signals.push(sig);
        this.hooks.onSignal && this.hooks.onSignal(sig);
        return sig;
      }
    }
    _trackLadder(sig, st, hi, lo, t, price) {
      const d = dirSign(sig.dir), fav = d > 0 ? hi : lo, adv = d > 0 ? lo : hi, prev = sig.status;
      sig.price = price; sig.lastT = t;
      if (sig.status === 'PENDING') {
        if (t >= sig.expiresAt) return this._closeLadder(sig, st, 'EXPIRED', price, t);
        if (!(d > 0 ? adv <= sig.entry : adv >= sig.entry)) return;
        sig.status = 'ACTIVE'; sig.filledAt = t;
        if (d > 0 ? adv <= sig.sl : adv >= sig.sl) return this._closeLadder(sig, st, 'SL_HIT', sig.sl, t);
        this.hooks.onUpdate && this.hooks.onUpdate(sig, prev);
        return; // targets are checked from the next bar
      }
      sig.mfeR = Math.max(sig.mfeR, (d * (fav - sig.entry)) / sig.risk);
      sig.maeR = Math.min(sig.maeR, (d * (adv - sig.entry)) / sig.risk);
      if (t - sig.filledAt > sig.maxHold) return this._closeLadder(sig, st, 'TIME_EXIT', price, t);
      // after TP1 the stop moves to the lock level (halfway to TP1 by default); open trades from before the rule ratchet up
      const lock = sig.entry + (this.cfg.lockAtTp1 || 0) * (sig.tps[0] - sig.entry);
      if (sig.stage >= 1 && this.cfg.lockAtTp1 > 0 && d * (lock - sig.slLive) > 0 && d * (price - lock) > 0) sig.slLive = lock;
      if (d > 0 ? adv <= sig.slLive : adv >= sig.slLive) return this._closeLadder(sig, st, sig.stage >= 1 && d * (sig.slLive - sig.entry) >= 0 ? 'BE_HIT' : 'SL_HIT', sig.slLive, t);
      const before = sig.stage;
      while (sig.stage < sig.tps.length && (d > 0 ? fav >= sig.tps[sig.stage] : fav <= sig.tps[sig.stage])) {
        sig.stage++;
        if (sig.stage === 1) { sig.tp1At = t; const lk = sig.entry + (this.cfg.lockAtTp1 || 0) * (sig.tps[0] - sig.entry); if (d * (lk - sig.slLive) > 0) sig.slLive = lk; }
        if (sig.stage === sig.beAt && d * (sig.entry - sig.slLive) > 0) sig.slLive = sig.entry; // never lowers a locked stop
      }
      if (sig.stage === sig.tps.length) return this._closeLadder(sig, st, 'TP5_HIT', sig.tps[sig.tps.length - 1], t);
      if (sig.stage > before) { sig.status = 'TP1_HIT'; this.hooks.onUpdate && this.hooks.onUpdate(sig, prev === 'TP1_HIT' ? 'TP' + before : prev); }
    }
    _closeLadder(sig, st, status, exitPrice, t) {
      const prev = sig.status, d = dirSign(sig.dir), n = sig.tps.length;
      let R = 0;
      if (status !== 'EXPIRED' && status !== 'CANCELLED') {
        for (let k = 0; k < sig.stage; k++) R += sig.rs[k] / n;
        const rem = (n - sig.stage) / n;
        R += ((d * (exitPrice - sig.entry)) / sig.risk) * rem;
      }
      sig.status = status; sig.closedAt = t; sig.exit = exitPrice; sig.result = Math.round(R * 100) / 100; sig.lastT = t;
      this.hooks.onUpdate && this.hooks.onUpdate(sig, prev);
    }

    // ---------- TradesbySci: Past Floor Retest ----------
    _sciCfg(st) {
      const c = this._cfgFor(st);
      return Object.assign({}, DEFAULTS.sci, this.cfg.sci || {}, c.sci || {});
    }
    // Builds the plan for one symbol: bias, opposing move and the past floors/ceilings inside it. Rebuilt on every closed 1H bar.
    _sciPlan(st, C) {
      const S = st.series;
      let biasTf = C.biasTf === 'auto' ? (S[G.D1].n >= 30 ? G.D1 : G.H4) : +C.biasTf;
      const step = { 86400: G.H4, 14400: G.H1, 7200: G.H1, 3600: G.M15 };
      const confTf = C.confTf === 'auto' ? step[biasTf] || G.H1 : +C.confTf;
      const sB = S[biasTf]; if (!sB || sB.n < 30) return { why: 'Not enough ' + TF_NAME[biasTf] + ' history' };
      const pv = pivots(sB, 250, C.pivotW);
      if (pv.highs.length < 2 || pv.lows.length < 2) return { why: 'No clear ' + TF_NAME[biasTf] + ' swings yet' };
      const H1 = last(pv.highs), H0 = last(pv.highs, 2), L1 = last(pv.lows), L0 = last(pv.lows, 2);
      const price = st.price;
      let dir = null;
      // "a low and a higher low" (and no fresh lower high after it) = buy wave; the mirror = sell wave
      if (L1.p > L0.p && !(H1.p < H0.p && H1.t > L1.t) && price > L1.p) dir = 'BUY';
      else if (H1.p < H0.p && !(L1.p > L0.p && L1.t > H1.t) && price < H1.p) dir = 'SELL';
      if (!dir) return { why: TF_NAME[biasTf] + ' structure is mixed' };
      const tC = trendOf(S[confTf]);
      if (tC.dir === against(dir)) return { why: TF_NAME[confTf] + ' is against the ' + TF_NAME[biasTf] + ' ' + (dir === 'BUY' ? 'buy' : 'sell') + ' wave' };
      // opposing move: the leg into the higher low (BUY) or into the lower high (SELL). If price has already run through the
      // bias timeframe's leg, the wave continues and the most recent pullback leg one or two timeframes lower is used instead.
      let leg = null;
      for (const g of [biasTf, confTf, G.H1].filter((x, i, a) => a.indexOf(x) === i)) {
        const sg = S[g]; if (!sg || sg.n < 20) continue;
        const pg = g === biasTf ? pv : pivots(sg, 250, C.pivotW);
        const ends = dir === 'BUY' ? pg.lows : pg.highs; if (!ends.length) continue;
        const end = last(ends), starts = (dir === 'BUY' ? pg.highs : pg.lows).filter((p) => p.t < end.t); if (!starts.length) continue;
        const start = last(starts), top = Math.max(start.p, end.p), bot = Math.min(start.p, end.p);
        if (dir === 'BUY' ? price < top && price > bot : price > bot && price < top) { leg = { g, start, end, top, bot }; break; }
      }
      if (!leg) return { why: 'Price is already through the opposing move — waiting for a pullback' };
      const { start, end, top, bot } = leg;
      const legFrom = start.t, legTo = end.t + leg.g;
      // past floors (BUY) / ceilings (SELL) inside the opposing move
      const atrH1 = S[G.H1].atrv || (top - bot) / 20;
      const raw = [];
      for (const g of C.floorTfs) {
        const s = S[g]; if (!s || s.n < 10) continue;
        const b = s.bars, lo = b.findIndex((x) => x.t >= legFrom); if (lo < 0) continue;
        let hiI = b.length - 1; while (hiI > lo && b[hiI].t >= legTo) hiI--;
        for (let i = Math.max(lo, 2); i <= hiI - 2; i++) {
          if (dir === 'BUY') {
            const isLow = b[i].l < b[i - 1].l && b[i].l < b[i - 2].l && b[i].l <= b[i + 1].l && b[i].l <= b[i + 2].l;
            if (!isLow) continue;
            // held at least once, then finally broken inside the leg
            for (let j = i + 3; j <= hiI; j++) if (b[j].c < b[i].l) { raw.push({ p: b[i].l, t: b[i].t, tf: g }); break; }
          } else {
            const isHigh = b[i].h > b[i - 1].h && b[i].h > b[i - 2].h && b[i].h >= b[i + 1].h && b[i].h >= b[i + 2].h;
            if (!isHigh) continue;
            for (let j = i + 3; j <= hiI; j++) if (b[j].c > b[i].h) { raw.push({ p: b[i].h, t: b[i].t, tf: g }); break; }
          }
        }
      }
      raw.sort((a, b) => a.p - b.p);
      const levels = [];
      for (const r of raw) {
        const prev = last(levels);
        if (prev && Math.abs(r.p - prev.p) <= C.mergeAtr * atrH1) { prev.n++; prev.tfs.add(r.tf); prev.p = (prev.p * (prev.n - 1) + r.p) / prev.n; }
        else levels.push({ p: r.p, n: 1, tfs: new Set([r.tf]) });
      }
      for (const l of levels) l.tfs = [...l.tfs].map((g) => TF_NAME[g]);
      if (!levels.length) return { why: 'No past ' + (dir === 'BUY' ? 'floors' : 'ceilings') + ' inside the opposing move' };
      if (dir === 'SELL') levels.reverse(); // ordered in the trade direction: the first one is nearest the leg's end
      return { dir, biasTf, confTf, legTf: leg.g, conf: tC.dir, top, bot, legFrom, legTo, origin: start.p, levels, why: null };
    }

    _sci(st, bar5) {
      const C = this._sciCfg(st), S = st.series, T = bar5.t + G.M5;
      const sc = st.sci || (st.sci = { key: null, plan: null, lv: {} });
      const k = S[G.H1].n ? last(S[G.H1].bars).t : 0;
      if (sc.key !== k || !sc.plan) {
        sc.key = k; const prevDir = sc.plan && sc.plan.dir;
        sc.plan = this._sciPlan(st, C);
        if (sc.plan.dir !== prevDir) sc.lv = {}; // new wave: forget old level states
      }
      const P = sc.plan;
      if (T < this.cfg.signalsEnabledFrom || !P || !P.dir) return;
      const dir = P.dir, sgn = dirSign(dir), atr = S[G.M15].atrv; if (!(atr > 0)) return;
      const key = (l) => l.p.toFixed(st.dec + 1);
      // 1) update break / retest states of every level
      let hit = null;
      for (let i = 0; i < P.levels.length; i++) {
        const L = P.levels[i], kk = key(L);
        const s = sc.lv[kk] || (sc.lv[kk] = { state: sgn * (bar5.c - L.p) > C.breakAtr * atr ? 'broken' : 'idle', t: T });
        if (s.state === 'used') continue;
        const beyond = sgn * (bar5.c - L.p);
        if (s.state === 'idle') { if (beyond > C.breakAtr * atr) { s.state = 'broken'; s.t = T; } continue; }
        if (s.state === 'broken') {
          if (beyond < -C.failAtr * atr) { s.state = 'idle'; continue; }
          if (s.t === T) continue; // the break bar itself is not the retest
          const touch = sgn > 0 ? bar5.l <= L.p + C.retestAtr * atr : bar5.h >= L.p - C.retestAtr * atr;
          const closesAway = beyond > 0 && sgn * (bar5.c - bar5.o) > 0;
          if (touch && closesAway && (!hit || sgn * (L.p - hit.L.p) > 0)) hit = { L, i, s };
        }
      }
      if (!hit) return;
      const reject = (why) => { this.hooks.onReject && this.hooks.onReject({ symbol: st.symbol, dir, setup: 'Past Floor Retest', t: T, why }); return null; };
      hit.s.state = 'used';
      if (this.openSignals(st.symbol).some((x) => x.strategy !== 'LADDER')) return reject('Trade already open on this pair');
      // loss guard (shared with ORB+): after an SL, wait for a fresh 15m swing in our favour
      const gd = st.guard[dir];
      if (this.cfg.lossGuard && gd) {
        const pv15 = pivots(S[G.M15], 60);
        const fresh = sgn > 0 ? pv15.lows.some((p) => p.t > gd.t && p.p > gd.level) : pv15.highs.some((p) => p.t > gd.t && p.p < gd.level);
        if (!fresh) return reject('Loss guard: waiting for a fresh 15m swing after SL');
        st.guard[dir] = null;
      }
      const s5 = S[G.M5], mom5 = s5.n > 9 && sgn * (bar5.c - s5.e(9)) > 0;
      if (C.need5m && !mom5) return reject('Retest candle closed on the wrong side of the 5m EMA9');
      const L = hit.L, entry = bar5.c;
      // stop: beyond the previous floor (behind us) or the retest swing, within the risk cap
      const recent = s5.bars.slice(-3), swing = sgn > 0 ? Math.min(...recent.map((x) => x.l)) : Math.max(...recent.map((x) => x.h));
      const behind = P.levels.slice(0, hit.i).map((l) => l.p).filter((p) => sgn * (entry - p) > 0);
      const prevFloor = behind.length ? (sgn > 0 ? Math.max(...behind) : Math.min(...behind)) : null;
      const buf = C.slBufAtr * atr;
      const swingSl = (sgn > 0 ? Math.min(swing, L.p) : Math.max(swing, L.p)) - sgn * buf;
      let sl = prevFloor != null ? prevFloor - sgn * buf : swingSl, slWhy = prevFloor != null ? 'previous floor' : 'retest swing';
      if (Math.abs(entry - sl) > C.maxRiskAtr * atr) { sl = swingSl; slWhy = 'retest swing'; }
      let risk = Math.abs(entry - sl);
      if (risk > C.maxRiskAtr * atr) return reject('Stop would be too wide (' + (risk / atr).toFixed(1) + '× 15m ATR)');
      if (risk < C.minRiskAtr * atr) { risk = C.minRiskAtr * atr; sl = entry - sgn * risk; }
      // targets: next floor ahead, then the one after (or the origin of the opposing move)
      const ahead = P.levels.slice(hit.i + 1).map((l) => l.p).filter((p) => sgn * (p - entry) > 0.05 * atr).concat([P.origin]).filter((p) => sgn * (p - entry) > 0);
      if (!ahead.length) return reject('No target left inside the opposing move');
      let r1 = Math.abs(ahead[0] - entry) / risk;
      if (r1 < C.minR1) return reject('Next ' + (sgn > 0 ? 'floor' : 'ceiling') + ' only ' + r1.toFixed(2) + 'R away: trade would run into it');
      r1 = Math.min(r1, C.r1Max);
      let r2 = ahead[1] != null ? Math.abs(ahead[1] - entry) / risk : r1 * 1.6;
      r2 = clamp(r2, r1 + 0.5, Math.max(r1 + 0.5, C.r2Max));
      const tp1 = entry + sgn * r1 * risk, tp2 = entry + sgn * r2 * risk;
      // score
      const tH4 = trendOf(S[G.H4]), tH1 = trendOf(S[G.H1]), t15 = trendOf(S[G.M15]);
      const reasons = []; let score = 30;
      const add = (pts, ok, label, detail) => { score += pts; reasons.push({ ok, pts, label, detail }); };
      reasons.push({ ok: true, pts: 30, label: TF_NAME[P.biasTf] + ' structure: ' + (sgn > 0 ? 'low → higher low (buy wave)' : 'high → lower high (sell wave)'), detail: '' });
      add(P.conf === want(dir) ? 15 : 7, true, TF_NAME[P.confTf] + ' ' + P.conf, P.conf === want(dir) ? 'agrees' : 'neutral');
      add(tH1.dir === want(dir) ? 10 : tH1.dir === 'FLAT' ? 4 : 0, tH1.dir !== against(dir), '1H ' + tH1.dir, '');
      add(t15.dir === want(dir) ? 5 : 0, t15.dir !== against(dir), '15m ' + t15.dir, '');
      const rng = bar5.h - bar5.l || 1e-9, body = Math.abs(bar5.c - bar5.o), wick = sgn > 0 ? Math.min(bar5.o, bar5.c) - bar5.l : bar5.h - Math.max(bar5.o, bar5.c);
      add(wick / rng >= 0.35 ? 10 : 0, wick / rng >= 0.35, 'Rejection wick at the ' + (sgn > 0 ? 'floor' : 'ceiling'), Math.round((wick / rng) * 100) + '% of the candle');
      add(body / rng >= 0.5 ? 5 : 0, body / rng >= 0.5, '5m retest candle body', Math.round((body / rng) * 100) + '%');
      add(L.n > 1 ? 10 : 0, L.n > 1, 'Level confluence', L.n + ' swing' + (L.n > 1 ? 's' : '') + ' (' + L.tfs.join(', ') + ')');
      add(r1 >= 1.5 ? 10 : r1 >= 1.2 ? 5 : 0, r1 >= 1.2, 'Room to next ' + (sgn > 0 ? 'floor' : 'ceiling'), r1.toFixed(2) + 'R');
      add(tH4.dir === want(dir) ? 5 : 0, tH4.dir !== against(dir), '4H ' + tH4.dir, '');
      score = Math.min(100, score);
      if (score < C.minScore) return reject('Score ' + score + ' below ' + C.minScore);
      const grade = score >= 85 ? 'A+' : score >= 74 ? 'A' : 'B';
      const cfg = this._cfgFor(st), tol = C.retestAtr * atr;
      const sig = {
        id: uid(), symbol: st.symbol, name: st.name, market: st.market, source: st.source, dec: st.dec,
        strategy: 'SCI', setup: sgn > 0 ? 'Past Floor Retest' : 'Past Ceiling Retest', kind: 'TREND', dir, tf: '5m', entryType: 'MARKET', entry, sl, slLive: sl, tp1, tp2, risk, r1, r2,
        score, grade, reasons, unproven: (cfg.unproven || []).includes(st.symbol) || (cfg.unproven || []).includes(st.source),
        bias: { [TF_NAME[P.biasTf]]: want(dir), H4: tH4.dir, H1: tH1.dir, M15: t15.dir },
        or: { hi: L.p + tol, lo: L.p - tol, start: T, end: T, orEnd: T }, // the retest zone (drawn like the opening range)
        zone: { level: L.p, tfs: L.tfs, swings: L.n, biasTf: TF_NAME[P.biasTf], legTf: TF_NAME[P.legTf], legTop: P.top, legBot: P.bot, prevFloor, slWhy },
        maxHoldMin: C.maxHoldMin,
        status: 'ACTIVE', createdAt: T, filledAt: T, tp1At: null, closedAt: null, lastT: T,
        result: null, mfeR: 0, maeR: 0, price: entry, exit: null,
      };
      sig.text = this._sciNarrative(sig);
      this.signals.push(sig);
      if (this.cfg.three && this.cfg.after) sig.runTgtR = Math.max.apply(null, (this.cfg.after.tgt || []).map((x) => (x == null ? sig.r2 : x)).concat([sig.r2]));
      this.hooks.onSignal && this.hooks.onSignal(sig);
      return sig;
    }

    _sciNarrative(sig) {
      const d = sig.dec, z = sig.zone, buy = sig.dir === 'BUY', fl = buy ? 'floor' : 'ceiling';
      const lines = [];
      lines.push(`${sig.dir} ${sig.name} — ${sig.setup}, grade ${sig.grade} (${sig.score}/100).`);
      lines.push(`On the ${z.biasTf} the market printed ${buy ? 'a low and then a higher low, so the next high should be higher' : 'a high and then a lower high, so the next low should be lower'}. The opposing move on the ${z.legTf} (${fmt(z.legBot, d)}–${fmt(z.legTop, d)}) was mapped and scanned for past ${fl}s.`);
      lines.push(`Price broke back ${buy ? 'above' : 'below'} the past ${fl} at ${fmt(z.level, d)} (${z.swings} swing${z.swings > 1 ? 's' : ''} on ${z.tfs.join(', ')}), came back to retest it, and the 5m candle closed ${buy ? 'up' : 'down'} away from it.`);
      lines.push(`Entry at market ${fmt(sig.entry, d)}. SL ${fmt(sig.sl, d)} sits beyond the ${z.slWhy}.`);
      lines.push(`TP1 ${fmt(sig.tp1, d)} (${sig.r1.toFixed(2)}R) is the next ${fl} in the way; TP2 ${fmt(sig.tp2, d)} (${sig.r2.toFixed(2)}R) is the one after it.`);
      if (sig.unproven) lines.push('Royalty: this market has no proven edge in backtests yet. Watch it, or trade the smallest size only.');
      if (this.cfg.three && this.cfg.after) lines.push(`Management: same plan as Royal Trades. 3 equal positions; at TP1, positions 1–2 lock TP1 and position 3 locks halfway, then all stops trail ${this.cfg.after.trail ? this.cfg.after.trail.dist : 0.3}R behind once price is ${this.cfg.after.trail ? this.cfg.after.trail.from : 0.6}R up.`);
      return lines.join(' ');
    }

    // ---------- reading ----------
    snapshot(symbol) {
      const st = this.sym[symbol]; if (!st) return null;
      const S = st.series, b = st.block;
      const tr = { H4: trendOf(S[G.H4]).dir, H2: trendOf(S[G.H2]).dir, H1: trendOf(S[G.H1]).dir, M15: trendOf(S[G.M15]).dir, M5: trendOf(S[G.M5]).dir };
      const er = efficiency(S[G.M15], 16);
      let orState = 'forming';
      if (b && b.done) orState = st.price > b.hi ? 'above' : st.price < b.lo ? 'below' : 'inside';
      const open = this.openSignals(symbol).find((x) => x.strategy !== 'LADDER') || null;
      const ladderOpen = this.openSignals(symbol).find((x) => x.strategy === 'LADDER') || null;
      let look = 'Waiting';
      if (open) look = 'In trade';
      else if (tr.H1 === 'FLAT' && this.cfg.trendMode === 'strict') look = 'No 1H trend';
      else if (er < this.cfg.chopMin) look = 'Ranging — standing aside';
      else if (tr.H1 === 'UP' && tr.M15 !== 'DOWN') look = b && b.brokeUp ? 'Bull break done — watching retest' : 'Watching for BUY break';
      else if (tr.H1 === 'DOWN' && tr.M15 !== 'UP') look = b && b.brokeDn ? 'Bear break done — watching retest' : 'Watching for SELL break';
      else look = 'Timeframes disagree';
      if (this.cfg.orb === false && this.cfg.sci && this.cfg.sci.on && !open) {
        const P = st.sci && st.sci.plan;
        look = !P ? 'Building plan' : !P.dir ? P.why : 'Watching for ' + (P.dir === 'BUY' ? 'BUY' : 'SELL') + ' retest of ' + P.levels.length + ' past ' + (P.dir === 'BUY' ? 'floor' : 'ceiling') + (P.levels.length === 1 ? '' : 's');
      }
      return { symbol, name: st.name, market: st.market, dec: st.dec, price: st.price, t: st.lastT, trend: tr, er,
        or: b ? { hi: b.hi, lo: b.lo, done: b.done, start: b.start, end: b.end, state: orState } : null,
        open: open ? open.id : null, ladder: ladderOpen ? ladderOpen.id : null, look, ready: st.ready };
    }

    narrative(sig, x) {
      const d = sig.dec, side = sig.dir === 'BUY' ? 'above' : 'below', edge = sig.dir === 'BUY' ? sig.or.hi : sig.or.lo;
      const lines = [];
      lines.push(`${sig.dir} ${sig.name} — ${sig.setup}${sig.kind === 'SCALP' ? ' (counter-1H scalp)' : ''}, grade ${sig.grade} (${sig.score}/100).`);
      if (sig.kind === 'TREND') lines.push(`The 1H trend is ${sig.bias.H1.toLowerCase()}, and the 4H reads ${sig.bias.H4.toLowerCase()} while the 2H reads ${sig.bias.H2.toLowerCase()}. The 15m is ${sig.bias.M15 === 'FLAT' ? 'neutral but on the right side of its EMA21' : 'aligned'}.`);
      else lines.push(`The 1H trend is weak (${sig.bias.H1.toLowerCase()}), so this is taken as a short scalp. The 15m and 1m momentum are carrying it, and targets are kept tight.`);
      lines.push(`Price closed ${side} the opening range ${sig.dir === 'BUY' ? 'high' : 'low'} at ${fmt(edge, d)} (range ${fmt(sig.or.lo, d)}–${fmt(sig.or.hi, d)}).`);
      lines.push(sig.entryType === 'LIMIT'
        ? `The candle ran too far from the edge, so the entry is a limit back at ${fmt(sig.entry, d)}. If it isn't filled within ${this.cfg.pendingExpiryMin} min, the setup is cancelled.`
        : `The entry is at market, ${fmt(sig.entry, d)}.`);
      lines.push(`The SL at ${fmt(sig.sl, d)} sits beyond the range midpoint and the recent 2m swing. Risk is ${(sig.risk / x.atr15).toFixed(2)}× the 15m ATR.`);
      lines.push(`TP1 ${fmt(sig.tp1, d)} (${sig.r1.toFixed(2)}R) and TP2 ${fmt(sig.tp2, d)} (${sig.r2.toFixed(2)}R). ${x.nearest != null ? `The next 1H structure is ${x.roomR.toFixed(1)}R away at ${fmt(x.nearest, d)}.` : 'There is no 1H structure in the way.'}`);
      if (sig.unproven) lines.push('Royalty: this market runs the Royalty strategy, which has no proven edge in backtests yet. Watch it, or trade the smallest size only.');
      if ((this.cfg.after) && (this.cfg.three)) lines.push(`Management: open 3 equal positions with the same SL. Nothing moves before TP1. At TP1, move the SL of positions 1 and 2 to TP1 (${fmt(sig.tp1, sig.dec)}) and the SL of position 3 halfway, to ${fmt(sig.entry + 0.5 * (sig.tp1 - sig.entry), sig.dec)}. There is no fixed TP2: once price is ${this.cfg.after.trail ? this.cfg.after.trail.from : 0.6}R in profit, trail all stops ${this.cfg.after.trail ? this.cfg.after.trail.dist : 0.3}R behind the best price (TP2 ${fmt(sig.tp2, sig.dec)} is a guide).`); else if (this.cfg.three) lines.push(`Management: open 3 equal positions with the same SL, all aiming for TP2. Nothing moves before TP1. At TP1, move the SL of positions 1 and 2 to TP1 (${fmt(sig.tp1, sig.dec)}) and the SL of position 3 halfway, to ${fmt(sig.entry + 0.5 * (sig.tp1 - sig.entry), sig.dec)}, in case price retraces.`);
      else lines.push(`Management: close ${Math.round(this.cfg.partialAtTp1 * 100)}% at TP1 and move the SL to entry, then let the rest run to TP2.`);
      return lines.join(' ');
    }
  }

  // ---------- stats ----------
  function stats(list) {
    const closed = list.filter((s) => s.result != null && !['EXPIRED', 'CANCELLED'].includes(s.status));
    const wins = closed.filter((s) => (s.strategy === 'LADDER' ? s.result > 0 : s.tp1At || s.status === 'TP2_HIT' || s.status === 'BE_HIT' || (s.status === 'TIME_EXIT' && s.result > 0)));
    const sumR = closed.reduce((a, s) => a + s.result, 0);
    const gross = closed.filter((s) => s.result > 0).reduce((a, s) => a + s.result, 0);
    const loss = -closed.filter((s) => s.result < 0).reduce((a, s) => a + s.result, 0);
    let eq = 0, peak = 0, dd = 0; const curve = [];
    for (const s of [...closed].sort((a, b) => a.closedAt - b.closedAt)) { eq += s.result; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); curve.push({ t: s.closedAt, v: Math.round(eq * 100) / 100 }); }
    const count = (st) => closed.filter((s) => s.status === st).length;
    const group = (key) => {
      const o = {};
      for (const s of closed) { const k = key(s); o[k] = o[k] || { n: 0, w: 0, R: 0 }; o[k].n++; o[k].R += s.result; if (s.tp1At || s.result > 0) o[k].w++; }
      for (const k in o) o[k].R = Math.round(o[k].R * 100) / 100;
      return o;
    };
    return {
      total: list.length, closed: closed.length, open: list.filter((s) => ['PENDING', 'ACTIVE', 'TP1_HIT'].includes(s.status)).length,
      expired: list.filter((s) => s.status === 'EXPIRED' || s.status === 'CANCELLED').length,
      wins: wins.length, winRate: closed.length ? wins.length / closed.length : 0,
      sl: count('SL_HIT'), tp2: count('TP2_HIT') + count('TP5_HIT'), be: count('BE_HIT'), timeExit: count('TIME_EXIT'),
      totalR: Math.round(sumR * 100) / 100, avgR: closed.length ? sumR / closed.length : 0,
      profitFactor: loss ? gross / loss : gross ? Infinity : 0, maxDD: Math.round(dd * 100) / 100, curve,
      ddNow: Math.round((peak - eq) * 100) / 100, sizeNow: peak - eq >= 3 ? 0.25 : peak - eq >= 2 ? 0.5 : 1, // drawdown rule (25 Nov lab: max DD 8.9R -> 4.5R): half size from 2R below the peak, quarter from 3R
      byGrade: group((s) => s.grade), bySymbol: group((s) => s.name), byKind: group((s) => s.kind), bySetup: group((s) => s.setup), byStrategy: group((s) => (s.strategy === 'LADDER' ? 'Royal Ladder' : s.strategy === 'SCI' ? 'Past Floor Retest' : 'ORB+')),
    };
  }

  // ---------- Deriv public feed (browser + Node 22) ----------
  class DerivFeed {
    constructor(opts = {}) {
      this.url = opts.url || 'wss://api.derivws.com/trading/v1/options/ws/public';
      this.onStatus = opts.onStatus || (() => {});
      this.WS = opts.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
      this.req = 1; this.pending = {}; this.subs = {}; this.ws = null; this.alive = false; this.queue = [];
    }
    connect() {
      return new Promise((resolve, reject) => {
        if (!this.WS) return reject(new Error('No WebSocket available'));
        this.onStatus('connecting');
        const ws = new this.WS(this.url); this.ws = ws;
        let opened = false;
        ws.onopen = () => {
          opened = true; this.alive = true; this.onStatus('live');
          this.ping = setInterval(() => this._send({ ping: 1 }), 25000);
          const q = this.queue; this.queue = []; q.forEach((m) => this._send(m));
          // re-subscribe after reconnect
          for (const key in this.subs) { const s = this.subs[key]; this._subscribe(s).catch(() => {}); }
          resolve();
        };
        ws.onmessage = (e) => this._onMessage(e.data);
        ws.onerror = () => { if (!opened) reject(new Error('WebSocket error')); };
        ws.onclose = () => {
          this.alive = false; clearInterval(this.ping); this.onStatus('reconnecting');
          for (const id in this.pending) { this.pending[id].reject(new Error('closed')); delete this.pending[id]; }
          setTimeout(() => this.connect().catch(() => {}), 3000);
        };
      });
    }
    _send(m) { if (this.ws && this.alive && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); else this.queue.push(m); }
    _onMessage(raw) {
      let d; try { d = JSON.parse(raw); } catch (e) { return; }
      if (d.msg_type === 'ohlc' && d.ohlc) {
        const key = d.ohlc.symbol + ':' + d.ohlc.granularity; const s = this.subs[key];
        if (s) s.cb(d.ohlc);
        return;
      }
      const id = d.req_id; if (id && this.pending[id]) {
        const p = this.pending[id]; delete this.pending[id];
        if (d.error) p.reject(Object.assign(new Error(d.error.message || d.error.code), { code: d.error.code })); else p.resolve(d);
      }
    }
    call(m, timeout = 20000) {
      return new Promise((resolve, reject) => {
        const id = this.req++; m.req_id = id; this.pending[id] = { resolve, reject };
        setTimeout(() => { if (this.pending[id]) { delete this.pending[id]; reject(new Error('timeout')); } }, timeout);
        this._send(m);
      });
    }
    activeSymbols() { return this.call({ active_symbols: 'brief' }).then((d) => d.active_symbols); }
    candles(symbol, g, count = 2000, end = 'latest') {
      return this.call({ ticks_history: symbol, style: 'candles', granularity: g, count, end, adjust_start_time: 1 }).then((d) => ({ candles: d.candles || [], pip: d.pip_size }));
    }
    async candlesBack(symbol, g, total) {
      let out = [], end = 'latest', pip;
      while (out.length < total) {
        const r = await this.candles(symbol, g, Math.min(2000, total - out.length), end);
        pip = r.pip; if (!r.candles.length) break;
        out = r.candles.concat(out);
        const first = r.candles[0].epoch; end = String(first - 1);
        if (r.candles.length < 2) break;
      }
      // de-dup
      const seen = new Set(); out = out.filter((c) => (seen.has(c.epoch) ? false : seen.add(c.epoch)));
      return { candles: out, pip };
    }
    subscribeCandles(symbol, g, cb, count = 2000) {
      const s = { symbol, g, cb, count, first: null };
      this.subs[symbol + ':' + g] = s;
      return this._subscribe(s);
    }
    _subscribe(s) {
      return this.call({ ticks_history: s.symbol, style: 'candles', granularity: s.g, count: s.count, end: 'latest', subscribe: 1, adjust_start_time: 1 })
        .then((d) => { s.first = d; return d; });
    }
  }

  function aggCandles(c, g) {
    const out = []; let cur = null;
    for (const x of c) {
      const t = Math.floor(x.epoch / g) * g;
      if (!cur || cur.epoch !== t) { if (cur) out.push(cur); cur = { epoch: t, open: x.open, high: x.high, low: x.low, close: x.close }; }
      else { cur.high = Math.max(cur.high, x.high); cur.low = Math.min(cur.low, x.low); cur.close = x.close; }
    }
    if (cur) out.push(cur); return out;
  }

  // ---------- MT5 bridge feed (Weltrade or any MT5 broker) ----------
  // Your own MT5 terminal runs the TradesWithMoxieBridge EA, which POSTs closed + forming bars to the server.
  // This feed serves those bars to the engine exactly like the Deriv feed does.
  class BridgeFeed {
    constructor() { this.data = {}; this.subs = {}; this.waiters = []; }
    // payload: { symbol, digits, m1:[[t,o,h,l,c],...], m15:[...], h1:[...] } (any subset)
    ingest(p) {
      const sym = p.symbol; if (!sym) return 0;
      const d = this.data[sym] || (this.data[sym] = { 60: new Map(), 900: new Map(), 3600: new Map(), digits: p.digits });
      if (p.digits != null) d.digits = p.digits;
      let n = 0;
      for (const [k, g] of [['m1', 60], ['m15', 900], ['h1', 3600]]) {
        for (const r of p[k] || []) { if (!Array.isArray(r) || r.length < 5) continue; d[g].set(+r[0], { epoch: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4] }); n++; }
        if (d[g].size > 6000) { const keys = [...d[g].keys()].sort((a, b) => a - b); for (const k2 of keys.slice(0, d[g].size - 5000)) d[g].delete(k2); }
      }
      d.updated = Date.now();
      const s = this.subs[sym];
      if (s && p.m1 && p.m1.length) {
        const last = [...p.m1].sort((a, b) => a[0] - b[0]).slice(-2);
        for (const r of last) s.cb({ symbol: sym, granularity: 60, open_time: +r[0], epoch: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4] });
      }
      this.waiters = this.waiters.filter((w) => !w());
      return n;
    }
    _series(sym, g) { const d = this.data[sym]; return d ? [...d[g].values()].sort((a, b) => a.epoch - b.epoch) : []; }
    _ready(sym) { const d = this.data[sym]; return d && d[60].size >= 300 && d[900].size >= 100 && d[3600].size >= 100; }
    _wait(sym, ms = 600000) {
      if (this._ready(sym)) return Promise.resolve();
      return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('no MT5 bridge data yet for ' + sym)), ms); this.waiters.push(() => { if (this._ready(sym)) { clearTimeout(t); res(); return true; } return false; }); });
    }
    async connect() {}
    async candles(sym, g, count = 2000, end = 'latest') {
      await this._wait(sym);
      const base = g === 120 || g === 300 ? 60 : g === 7200 || g === 14400 ? 3600 : g;
      let c = this._series(sym, base);
      if (end !== 'latest') c = c.filter((x) => x.epoch <= +end);
      if (base !== g) c = aggCandles(c, g);
      return { candles: c.slice(-count), pip: (this.data[sym] || {}).digits };
    }
    async candlesBack(sym, g, total) { return this.candles(sym, g, total); }
    async subscribeCandles(sym, g, cb, count = 2000) {
      await this._wait(sym); this.subs[sym] = { cb };
      return { candles: this._series(sym, 60).slice(-count), pip_size: (this.data[sym] || {}).digits, subscription: { id: 'mt5:' + sym } };
    }
    status() { const o = {}; for (const k in this.data) o[k] = { m1: this.data[k][60].size, m15: this.data[k][900].size, h1: this.data[k][3600].size, updated: this.data[k].updated }; return o; }
  }

  // ---------- Live runner: wires feed(s) -> engine for a list of symbols ----------
  // `feed` can be a single feed or a map { deriv: DerivFeed, weltrade: WeltradeFeed } keyed by symbol meta.source
  async function startLive(engine, feedOrMap, symbols, opts = {}) {
    const pick = (meta) => (feedOrMap.candles ? feedOrMap : feedOrMap[meta.source || 'deriv']);
    const log = opts.log || (() => {});
    const htf = [G.M2, G.M5, G.M15, G.H1, G.H2, G.H4, G.D1];
    const counts = { 120: 1500, 300: 1500, 900: 1500, 3600: 2000, 7200: 1200, 14400: 1000, 86400: 400 };
    const runOne = async (meta) => {
      const sym = meta.symbol; engine.addSymbol(sym, meta);
      const feed = pick(meta); if (!feed) { log('no feed for ' + sym); return; }
      try {
        for (const g of htf) {
          const r = await feed.candles(sym, g, counts[g]);
          engine.seed(sym, g, r.candles, { decimals: r.pip });
        }
        let seeded = false;
        const first = await feed.subscribeCandles(sym, G.M1, (o) => {
          if (!seeded) return; engine.onBar(sym, o); opts.onTick && opts.onTick(sym);
        }, 2000);
        engine.seed(sym, G.M1, first.candles || [], { decimals: first.pip_size });
        engine.finishSeed(sym); seeded = true;
        log('ready ' + sym);
        opts.onReady && opts.onReady(sym);
      } catch (e) {
        log('failed ' + sym + ': ' + e.message + ' (retrying in 60s)'); opts.onError && opts.onError(sym, e);
        setTimeout(() => runOne(meta), 60000); // feeds hiccup (rate limits, closed markets): keep trying
      }
    };
    // limited concurrency so we don't hammer the API
    const list = symbols.slice(); const workers = [];
    for (let i = 0; i < (opts.concurrency || 3); i++) workers.push((async () => { while (list.length) await runOne(list.shift()); })());
    await Promise.all(workers);
  }

  // ---------- Backtest: replays real 1m history through the identical engine ----------
  async function backtest(feed, meta, days, cfg = {}, progress = () => {}) {
    const sym = meta.symbol;
    progress(sym, 'downloading 1m history');
    const m1 = await feed.candlesBack(sym, 60, Math.min(days * 1440 + 360, 14000));
    if (!m1.candles.length) throw new Error('no data for ' + sym);
    const bars = m1.candles.map(toBar);
    const startFeed = Math.ceil(bars[0].t / G.H4) * G.H4;
    const eng = new Engine(Object.assign({}, cfg, { signalsEnabledFrom: startFeed + 3 * 3600 }));
    eng.mode = 'backtest';
    eng.addSymbol(sym, Object.assign({}, meta, { decimals: m1.pip }));
    const st = eng.sym[sym];
    for (const g of [G.M5, G.M15, G.H1, G.H2, G.H4, G.D1]) {
      progress(sym, 'downloading ' + TF_NAME[g]);
      const end = String(startFeed - 1);
      const r = await feed.candles(sym, g, 1500, end);
      const closed = r.candles.filter((c) => c.epoch + g <= startFeed);
      st.series[g].seed(closed, false);
    }
    st.ready = true;
    progress(sym, 'replaying ' + bars.length + ' bars');
    for (const b of bars) { if (b.t < startFeed) continue; eng.onBar(sym, b); }
    // close anything still open at the end at last price (time exit) for honest accounting
    const lastBar = last(bars);
    for (const s of eng.openSignals(sym)) (s.strategy === 'LADDER' ? eng._closeLadder.bind(eng) : eng._close.bind(eng))(s, st, s.status === 'PENDING' ? 'EXPIRED' : 'TIME_EXIT', lastBar.c, lastBar.t + 60);
    return { signals: eng.signals, from: startFeed, to: lastBar.t, bars: bars.length };
  }

  const D = (symbol, name, market = 'synthetic') => ({ symbol, name, market, source: 'deriv' });
  // Weltrade SyntX pairs arrive through your MT5 terminal (source 'mt5'), the same bridge model Aurum uses.
  const W = (symbol) => ({ symbol, name: symbol.replace(/-/g, ' '), market: 'synthetic', source: 'mt5', broker: 'Weltrade' });
  const DEFAULT_SYMBOLS = [
    // Deriv synthetics
    D('stpRNG', 'Step Index 100'), D('R_25', 'Volatility 25'), D('R_50', 'Volatility 50'), D('R_75', 'Volatility 75'), D('R_100', 'Volatility 100'),
    D('1HZ25V', 'Volatility 25 (1s)'), D('1HZ75V', 'Volatility 75 (1s)'), D('BOOM1000', 'Boom 1000'), D('CRASH1000', 'Crash 1000'),
    // Deriv gold & metals
    D('frxXAUUSD', 'Gold (XAU/USD)', 'forex'), D('frxXAGUSD', 'Silver (XAG/USD)', 'forex'),
    // Deriv forex
    D('frxEURUSD', 'EUR/USD', 'forex'), D('frxGBPUSD', 'GBP/USD', 'forex'), D('frxUSDJPY', 'USD/JPY', 'forex'), D('frxAUDUSD', 'AUD/USD', 'forex'),
    D('frxUSDCAD', 'USD/CAD', 'forex'), D('frxUSDCHF', 'USD/CHF', 'forex'), D('frxNZDUSD', 'NZD/USD', 'forex'),
    D('frxGBPJPY', 'GBP/JPY', 'forex'), D('frxEURJPY', 'EUR/JPY', 'forex'), D('frxEURGBP', 'EUR/GBP', 'forex'),
    // Deriv crypto
    D('cryBTCUSD', 'BTC/USD', 'crypto'), D('cryETHUSD', 'ETH/USD', 'crypto'),
  ];
  // Weltrade SyntX pairs (MT5 bridge). Off by default for now; add them back in Settings.
  const WELTRADE_SYMBOLS = [
    W('FlipX-1'), W('FlipX-2'), W('FlipX-3'), W('FlipX-4'), W('FlipX-5'), W('FiboX'), W('QuadX'), W('PlusX-1'),
    W('FX-Vol-20'), W('FX-Vol-40'), W('FX-Vol-60'), W('FX-Vol-99'), W('SFX-Vol-20'), W('SFX-Vol-40'),
    W('GainX-400'), W('GainX-600'), W('PainX-400'), W('PainX-600'),
  ];

  return { Engine, Series, DerivFeed, BridgeFeed, aggCandles, startLive, backtest, stats, trendOf, efficiency, pivots, fmt, toBar, decimalsOf, G, TF_NAME, DEFAULTS, DEFAULT_SYMBOLS, WELTRADE_SYMBOLS, version: 'sci-1.0', product: 'TradesbySci' };
});
