/*!
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

  const G = { M1: 60, M2: 120, M5: 300, M15: 900, H1: 3600, H2: 7200, H4: 14400 };
  const TF_LIST = [G.M1, G.M2, G.M5, G.M15, G.H1, G.H2, G.H4];
  const TF_NAME = { 60: '1m', 120: '2m', 300: '5m', 900: '15m', 3600: '1H', 7200: '2H', 14400: '4H' };
  const EMA_LENS = [9, 21, 50, 200];

  const DEFAULTS = {
    orBlock: 3600,          // session block in seconds (3600 = new opening range every hour)
    orMinutes: 15,          // opening range length
    bufferFrac: 0.15,       // breakout must clear the edge by this fraction of range height (tuned on 7d real data)
    trendMode: 'adaptive',  // 'strict' = only with 1H trend; 'adaptive' = also counter-1H scalps when 1H is weak
    minScore: 74,           // publish threshold (A grade). SL lab 23 Nov: scores under 74 won 37% (-0.28R each)
    minScalpScore: 80,      // counter-1H scalps need more confluence
    // Stop-loss lab, 23 Nov 2026 (593 ORB+ trades, ~21 days synthetics / ~30 days forex & crypto). Each filter
    // removed trades that lost money in both halves of the data.
    // Regime lab, 24 Nov 2026 (ORB+ only, two separate ~20-trading-day windows): compact opening ranges (0.6–0.9× the 15m ATR)
    // in the active session (06:00–18:00 UTC) gave 89% of trades in profit, profit factor 3.85, 3.7R max drawdown and +100.1R
    // over both windows (unseen window alone: 87%, PF 2.80, 3.7R, +43.8R), against PF 2.37 and 7.0R drawdown without them.
    minOrAtr: 0.6,          // skip when the opening range is narrower than this × the 15m ATR (0 = off)
    hours: { fromUtc: 6, toUtc: 18 }, // only signal inside these UTC hours (08:00–20:00 SAST); null = always
    needH4: false,          // require the 4H trend to agree with the trade
    maxOrAtr: 0.9,          // skip when the opening range is wider than this × the 15m ATR (regime lab; was 1.5)
    quiet: { markets: ['forex'], fromUtc: 4, toUtc: 8 },  // no forex/metals ORB+ 06:00–10:00 SAST (London-open fakeouts: 42% win, -9R)
    orbOff: ['frxNZDUSD', 'frxUSDCHF', 'frxEURUSD', '1HZ25V', 'R_75', 'frxUSDJPY', 'frxUSDCAD'],  // ORB+ lost in both halves on these markets
    ladderOff: ['frxEURGBP', 'frxUSDCHF', 'frxXAUUSD'],                                       // Royal Ladder lost in both halves on these
    chopMin: 0,             // optional 15m efficiency floor (0..1). Off by default: in walk-forward tests it removed more winners than losers
    maxRiskAtr: 1.8,        // stop distance cap in 15m ATRs
    minRiskAtr: 0.35,       // stop distance floor in 15m ATRs (avoid noise stops)
    minRoomR: 1.0,          // need at least 1R to nearest 1H obstacle
    pendingExpiryMin: 30,   // unfilled limit orders expire
    maxHoldMin: 360,        // time exit after 6h
    partialAtTp1: 0.5,      // fraction closed at TP1 (rest runs to TP2 with SL at entry)
    // Management lab, 23 Nov 2026 (v1.5.1 rules, 24 markets): moving the stop to entry at +0.5R lifted ORB+ from +83.8R to
    // +99.8R (both halves better; stop-outs 44% -> 25%). Partial size, TP2 distance and holding time made no real difference.
    // Stop-out lab, 24 Nov 2026 (23 markets, ~20 days): locking +0.05R at +0.3R and cutting any trade whose 5m candle closes
    // 0.6R against it cut full stop-outs from 26% to 9% of trades and lifted wins from 74% to 79%, for the same profit
    // (+109.9R vs +111.5R; both halves positive). Earlier: trailing lab, 23 Nov 2026 (see README).
    beAtR: 0.15,            // 0 = off. (0.15: 87–88% of trades closed in profit in both lab windows) Move the stop to entry (+ beLockR) once a trade has been this many R in profit before TP1
    beLockR: 0.05,          // R locked in by that early stop move (makes "breakeven" a small win)
    tp1Lock: 0.3,           // at TP1 the stop moves to entry + this many R
    tp1LockAtTp1: false,    // true: at TP1 the runner's stop moves to TP1 itself (3-position plan: 2 close at TP1, 1 runs)
    trail: { mode: 'pips', pips: 20, atr: 0.75, keepTp2: false }, // after TP1: trail 'pips' (forex & metals) or 'atr' (× 15m ATR) behind the best price; keepTp2 false = let the runner go
    slOfTp: null,           // { ref: 'tp1'|'tp2', k }: stop distance as a fraction of a target's distance (tested: worse for ORB+)
    // Dynamic-stop lab, 24 Nov 2026 (23 markets, ~20 days, on top of v1.8): trailing the stop 1R behind the best price,
    // never past half of the TP1 distance, until TP1: ORB+ +134.4R vs +106.3R, full stop-outs 9% -> 1%, wins 78% vs 79%;
    // Ladder +41.3R vs +40.4R, full stops 11% -> 1%. Both halves better. Tighter trails (0.75R, 0.5R) cut wins and profit.
    dyn: { dist: 1, cap: 0.5, whole: false }, // { dist, cap, whole }: dynamic stop that trails dist × risk behind the best price, never past cap × the TP1 distance (whole: for the whole trade, else until TP1)
    softStop: { r: 0.6, tf: 300 }, // before the stop has moved: exit at the close of a 5m candle that closes 0.6R or more against the trade
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
    // Royal Ladder: the decoded + refined gold-signal strategy (limit at fresh 15m swing points, 5-TP ladder).
    // Distances are 15m-ATR multiples calibrated on gold (median ATR $7.37: $3 front-run, $12 SL, $4/$8/$13/$18/$28 TPs).
    // Stop-out lab, 24 Nov 2026 (12 Ladder pairs, ~20 days): stop at 50% of the TP3 distance (0.88 ATR instead of 1.63) plus a
    // cut when a 5m candle closes 0.6R against the trade: +41.1R vs +34.7R, full stop-outs 15% -> 10% (9% without gold).
    ladder: { on: false, markets: ['forex', 'crypto'], symbols: [], units: { frxXAUUSD: 7.37 }, confirm: true, maxAway: 3, w: 5, front: 0.41, sl: 0.88, tps: [0.54, 1.09, 1.76, 2.44, 3.80], beAt: 3, softStop: { r: 0.6, tf: 300 }, dyn: { dist: 1, cap: 0.5, whole: false }, expH: 4, holdH: 24, away: 0.41 },
    // beAt 3 (stop to entry after TP3): +35.7R vs +27.8R at TP2 in the management lab, both halves better.
    // 5m entry lab, 23 Nov 2026 (30,000 1m bars, gold/forex/crypto): waiting for a 5m candle to close back in the trade's
    // direction at the level lifted the win rate from 65% to 76% and cut stop-outs from 34% to 24% (+0.16R a trade vs +0.11R).
    // maxAway 3: no limit is posted when price is already more than 3 ATRs from the level (those rarely filled).
    // Ladder lab, 23 Nov 2026 (20,000 1m bars each; gold uses fixed $ distances: 41 days, 48 trades, 85% TP1, +12.5R):
    // losing or flat markets carry the Royalty tag.
    ladderRoyalty: ['frxXAUUSD', 'frxEURUSD', 'frxUSDCHF', 'frxEURGBP', 'cryBTCUSD', 'cryETHUSD'],
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
      if (closed[trig] && st.ready) this._evaluate(st, closed[trig], trig);
      if (closed[G.M15] && st.ready && this._ladderOn(st)) this._ladder(st, closed[G.M15]);
      if (closed[G.M5]) this._ladderConfirm(st, closed[G.M5]);
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
      for (const g of [G.M5, G.M15]) if (closed[g]) this._softStops(st, closed[g], g);
    }
    // Soft stops: a candle that closes against the trade cuts it at that close instead of waiting for the full stop.
    _softStops(st, cb, g) {
      const cfg = this.cfg, L = cfg.ladder || {}, T = cb.t + g;
      for (const sig of this.openSignals(st.symbol)) {
        if (!sig.filledAt || sig.filledAt > cb.t) continue;      // only candles that opened after the fill
        const d = dirSign(sig.dir), rNow = (d * (cb.c - sig.entry)) / sig.risk;
        if (sig.strategy === 'LADDER') {
          if (sig.status !== 'ACTIVE' && sig.status !== 'TP1_HIT') continue;
          if (sig.stage >= (sig.beAt || 99) || (d * (sig.slLive - sig.entry)) >= 0) continue; // stop already at entry or better
          const ss = L.softStop, lv = L.softLevel;
          const hitR = ss && ss.tf === g && rNow <= -ss.r;
          const hitL = lv != null && g === (L.softLevelTf || G.M5) && d * (cb.c - sig.level) < -lv * sig.atr;
          if (hitR || hitL) this._closeLadder(sig, st, 'SOFT_EXIT', cb.c, T);
        } else {
          const ss = cfg.softStop;
          if (!ss || ss.tf !== g || sig.status !== 'ACTIVE' || sig.beArmed) continue;
          if (rNow <= -ss.r) this._close(sig, st, 'SOFT_EXIT', cb.c, T);
        }
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
      if ((cfg.orbOff || []).includes(st.symbol)) return reject('ORB+ is off on this market (it lost money in testing)');
      if (cfg.maxOrAtr && h > cfg.maxOrAtr * atr15) return reject('Opening range too wide (' + (h / atr15).toFixed(1) + '× ATR): breakouts from wide ranges usually fail');
      if (cfg.quiet && (cfg.quiet.markets || []).includes(st.market)) {
        const hu = new Date(T * 1000).getUTCHours();
        if (hu >= cfg.quiet.fromUtc && hu < cfg.quiet.toUtc) return reject('Quiet window (London open): breakouts fail more often');
      }
      // Regime filters (regime lab, 24 Nov 2026): compact ranges in the active session, with the 4H behind the trade
      if (cfg.minOrAtr && h < cfg.minOrAtr * atr15) return reject('Opening range too tight (' + (h / atr15).toFixed(2) + '× ATR): no clean breakout regime');
      if (cfg.hours) { const hu = new Date(T * 1000).getUTCHours(); if (hu < cfg.hours.fromUtc || hu >= cfg.hours.toUtc) return reject('Outside the active session (' + cfg.hours.fromUtc + ':00–' + cfg.hours.toUtc + ':00 UTC)'); }
      if (cfg.needH4 && tH4.dir !== want(dir)) return reject('4H trend not behind the trade');
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
      let tp1 = entry + sgn * r1 * risk, tp2 = entry + sgn * r2 * risk;
      if (cfg.slOfTp) {   // stop distance = k × the distance to TP1 or TP2 (targets stay where they are)
        const ref = cfg.slOfTp.ref === 'tp1' ? tp1 : tp2, nr = cfg.slOfTp.k * Math.abs(ref - entry);
        if (nr > 0) { risk = nr; sl = entry - sgn * risk; r1 = Math.abs(tp1 - entry) / risk; r2 = Math.abs(tp2 - entry) / risk; }
      }

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
        result: null, mfeR: 0, maeR: 0, price: bar2.c, exit: null, atr15, peak: null,
      };
      sig.text = this.narrative(sig, { atr15, er15, h, roomR, nearest });
      this.signals.push(sig);
      this.hooks.onSignal && this.hooks.onSignal(sig);
      return sig;
    }

    // ---------- live trade capture ----------
    _close(sig, st, status, exitPrice, t) {
      const prev = sig.status, sgn = dirSign(sig.dir);
      const rNow = (sgn * (exitPrice - sig.entry)) / sig.risk;
      const p = this.cfg.partialAtTp1;
      let R = 0;
      if (status === 'SL_HIT') R = -1;
      else if (status === 'TP2_HIT') R = p * sig.r1 + (1 - p) * sig.r2;
      else if (status === 'BE_HIT' || status === 'TRAIL_EXIT') R = p * sig.r1 + (1 - p) * rNow;
      else if (status === 'BE_EARLY' || status === 'SOFT_EXIT' || status === 'DYN_STOP') R = rNow;  // stopped at entry (or the locked level) before TP1
      else if (status === 'TIME_EXIT') R = sig.tp1At ? p * sig.r1 + (1 - p) * rNow : rNow;
      else R = 0; // EXPIRED / CANCELLED never filled
      sig.status = status; sig.closedAt = t; sig.exit = exitPrice; sig.result = Math.round(R * 100) / 100; sig.lastT = t;
      if (status === 'SL_HIT') {
        // arm the loss guard for this direction
        st.guard[sig.dir] = { t, block: st.block ? st.block.start : 0, level: sig.dir === 'BUY' ? Math.min(sig.sl, sig.entry) : Math.max(sig.sl, sig.entry) };
      }
      this.hooks.onUpdate && this.hooks.onUpdate(sig, prev);
    }

    _better(sgn, a, b) { if (a == null) return b; if (b == null) return a; return sgn > 0 ? Math.max(a, b) : Math.min(a, b); }
    _dynCap(sig, dy, sgn) { return sig.entry + sgn * (dy.cap == null ? 0.5 : dy.cap) * Math.abs(sig.tp1 - sig.entry); }
    // Dynamic stop: follows the best price at dist × risk, never past cap × the TP1 distance. Applies from the next bar.
    _dyn(sig, dy, sgn) {
      const best = sig.entry + sgn * sig.mfeR * sig.risk;
      const cand = this._better(-sgn, best - sgn * dy.dist * sig.risk, this._dynCap(sig, dy, sgn));
      const cur = sig.beArmed || sig.dynMoved || sig.status === 'TP1_HIT' ? sig.slLive : sig.sl;
      if (sgn > 0 ? cand > cur + 1e-12 : cand < cur - 1e-12) { sig.slLive = cand; sig.dynMoved = true; }
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
        const stop = sig.beArmed || sig.dynMoved ? sig.slLive : sig.sl;
        const slHit = sgn > 0 ? adv <= stop : adv >= stop;
        const tp1Hit = sgn > 0 ? fav >= sig.tp1 : fav <= sig.tp1;
        if (slHit) return this._close(sig, st, sgn * (stop - sig.entry) >= -1e-12 && (sig.beArmed || sig.dynMoved) ? 'BE_EARLY' : sig.dynMoved ? 'DYN_STOP' : 'SL_HIT', stop, t); // pessimistic if both in one bar
        // early breakeven: armed from the next bar once the trade has run beAtR in profit
        if (cfg.beAtR && !sig.beArmed && sig.mfeR >= cfg.beAtR && !tp1Hit) { sig.beArmed = true; sig.slLive = this._better(sgn, sig.slLive, sig.entry + sgn * (cfg.beLockR || 0) * sig.risk); this.hooks.onUpdate && this.hooks.onUpdate(sig, 'ACTIVE'); }
        if (cfg.dyn && !tp1Hit) this._dyn(sig, cfg.dyn, sgn);
        if (tp1Hit) {
          sig.status = 'TP1_HIT'; sig.tp1At = t; sig.slLive = this._better(sgn, sig.dynMoved || sig.beArmed ? sig.slLive : null, cfg.tp1LockAtTp1 ? sig.tp1 : sig.entry + sgn * (cfg.tp1Lock || 0) * sig.risk); sig.peak = sig.tp1;
          if (cfg.dyn && cfg.dyn.whole) sig.slLive = this._better(-sgn, sig.slLive, this._dynCap(sig, cfg.dyn, sgn));
          this.hooks.onUpdate && this.hooks.onUpdate(sig, 'ACTIVE');
          if (sgn > 0 ? fav >= sig.tp2 : fav <= sig.tp2) return this._close(sig, st, 'TP2_HIT', sig.tp2, t);
          if (this.mode === 'backtest') return; // BE can't be ordered inside the same bar; check next bar
        }
      }
      if (sig.status === 'TP1_HIT') {
        const tr = cfg.trail || {}, keepTp2 = tr.mode === 'off' || tr.keepTp2 !== false;
        const stop = sig.slLive != null ? sig.slLive : sig.entry;
        if (sgn > 0 ? adv <= stop : adv >= stop) return this._close(sig, st, Math.abs(stop - sig.entry) < 1e-12 ? 'BE_HIT' : 'TRAIL_EXIT', stop, t); // stop first (pessimistic)
        if (keepTp2 && (sgn > 0 ? fav >= sig.tp2 : fav <= sig.tp2)) return this._close(sig, st, 'TP2_HIT', sig.tp2, t);
        if (cfg.dyn && cfg.dyn.whole) this._dyn(sig, cfg.dyn, sgn);
        if (tr.mode && tr.mode !== 'off') {   // trail behind the best price; the new stop applies from the next bar
          sig.peak = sig.peak == null ? fav : sgn > 0 ? Math.max(sig.peak, fav) : Math.min(sig.peak, fav);
          const pip = tr.mode === 'pips' && st.market === 'forex' ? Math.pow(10, -Math.max(0, st.dec - 1)) : null;
          const dist = pip ? tr.pips * pip : (tr.atr || 0.75) * (sig.atr15 || sig.risk);
          const cand = sig.peak - sgn * dist;
          const capped = cfg.dyn && cfg.dyn.whole ? this._better(-sgn, cand, this._dynCap(sig, cfg.dyn, sgn)) : cand;
          if (sgn > 0 ? capped > sig.slLive : capped < sig.slLive) sig.slLive = capped;
        }
      }
      if ((sig.status === 'ACTIVE' || sig.status === 'TP1_HIT') && sig.filledAt && t - sig.filledAt > cfg.maxHoldMin * 60) {
        return this._close(sig, st, 'TIME_EXIT', price, t);
      }
    }

    // ---------- Royal Ladder ----------
    _ladderOn(st) {
      const L = this.cfg.ladder;
      if (!L || !L.on || (this.cfg.ladderOff || []).includes(st.symbol)) return false;
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
        if (L.maxAway && (px - lvl) * d > L.maxAway * atr) continue; // too far: price rarely comes back in time
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
          strategy: 'LADDER', setup: 'Royal Ladder', kind: bias.H1 === want ? 'TREND' : 'SCALP', dir, tf: '15m', entryType: L.confirm ? 'CONFIRM' : 'LIMIT', confirm: !!L.confirm, touched: null, level: lvl, zone: entry,
          entry, sl, slLive: sl, tp1: tps[0], tp2: tps[1], tps, rs, risk, r1: rs[0], r2: rs[1], stage: 0, beAt: L.beAt, stepTrail: !!L.stepTrail, stepFrom: L.stepFrom || 1, stepLock: L.stepLock || 0, tp1Stop: L.tp1Stop == null ? null : L.tp1Stop, beLock: L.beLock || 0, split3: !!L.split3,
          expiresAt: T + L.expH * 3600, maxHold: L.holdH * 3600, atr,
          score, grade, reasons, unproven: (this.cfg.ladderRoyalty || []).includes(st.symbol),
          bias, or: null, status: 'PENDING', createdAt: T, filledAt: null, tp1At: null, closedAt: null, lastT: T,
          result: null, mfeR: 0, maeR: 0, price: px, exit: null,
        };
        const dd = st.dec;
        sig.text = [
          `${dir} ${st.name}: Royal Ladder, grade ${grade} (${score}/100).`,
          `A fresh 15m swing ${d > 0 ? 'low' : 'high'} formed at ${fmt(lvl, dd)} and price has moved away from it. The 1H trend is ${bias.H1.toLowerCase()} (never against the trade) and the 15m is on the right side of its EMA50.`,
          L.confirm ? `Entry zone ${fmt(entry, dd)}, just before the level. Wait for price to reach it, then ${dir.toLowerCase()} when a 5m candle closes back ${d > 0 ? 'up' : 'down'} through it. Stop ${fmt(sl, dd)}. The setup is cancelled if price hits the stop first or nothing confirms within ${L.expH} hours.`
            : `Limit ${dir.toLowerCase()} at ${fmt(entry, dd)}, set just before the level so it fills even if price doesn't quite tag it. Stop ${fmt(sl, dd)}. The order is cancelled if it isn't filled within ${L.expH} hours.`,
          `Five targets: ${tps.map((x, k) => 'TP' + (k + 1) + ' ' + fmt(x, dd)).join(', ')}. Close a fifth at each, and move the stop to entry after TP${L.beAt}.${L.softStop ? ` Before that, close the trade if a ${L.softStop.tf / 60}m candle closes ${L.softStop.r}R or more against it.` : ''}${L.dyn ? ` Until TP1, trail the stop ${L.dyn.dist}R behind the best price, never past ${fmt(entry + d * (L.dyn.cap == null ? 0.5 : L.dyn.cap) * Math.abs(tps[0] - entry), dd)} (halfway to TP1).` : ''}`,
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
        if (sig.confirm) {
          if (!sig.touched && (d > 0 ? adv <= sig.zone : adv >= sig.zone)) { sig.touched = t; this.hooks.onUpdate && this.hooks.onUpdate(sig, 'PENDING'); }
          if (sig.touched && (d > 0 ? adv <= sig.sl : adv >= sig.sl)) return this._closeLadder(sig, st, 'CANCELLED', price, t); // stop level hit before a 5m confirmation: no trade
          return;
        }
        if (!(d > 0 ? adv <= sig.entry : adv >= sig.entry)) return;
        sig.status = 'ACTIVE'; sig.filledAt = t;
        if (d > 0 ? adv <= sig.sl : adv >= sig.sl) return this._closeLadder(sig, st, 'SL_HIT', sig.sl, t);
        this.hooks.onUpdate && this.hooks.onUpdate(sig, prev);
        return; // targets are checked from the next bar
      }
      sig.mfeR = Math.max(sig.mfeR, (d * (fav - sig.entry)) / sig.risk);
      sig.maeR = Math.min(sig.maeR, (d * (adv - sig.entry)) / sig.risk);
      if (t - sig.filledAt > sig.maxHold) return this._closeLadder(sig, st, 'TIME_EXIT', price, t);
      if (d > 0 ? adv <= sig.slLive : adv >= sig.slLive) return this._closeLadder(sig, st, (d * (sig.slLive - sig.entry)) > 1e-12 ? 'TRAIL_EXIT' : sig.stage >= sig.beAt || Math.abs(sig.slLive - sig.entry) < 1e-12 ? 'BE_HIT' : sig.dynMoved && sig.stage === 0 ? 'DYN_STOP' : 'SL_HIT', sig.slLive, t);
      const before = sig.stage;
      while (sig.stage < sig.tps.length && (d > 0 ? fav >= sig.tps[sig.stage] : fav <= sig.tps[sig.stage])) {
        sig.stage++;
        if (sig.stage === 1) sig.tp1At = t;
        if (sig.stage === 1 && sig.tp1Stop != null) sig.slLive = this._better(d, sig.slLive, sig.entry - d * sig.tp1Stop * sig.risk);  // cut the open risk at TP1
        if (sig.stage === sig.beAt) sig.slLive = this._better(d, sig.slLive, sig.entry + d * (sig.beLock || 0) * sig.risk);
        if (sig.split3) sig.slLive = this._better(d, sig.slLive, sig.tps[Math.max(0, sig.stage - 2)]); // runner: stop at TP1, then one target behind
        if (sig.stepTrail && sig.stage >= sig.stepFrom) sig.slLive = sig.stage === sig.stepFrom ? sig.entry + d * (sig.stepLock || 0) * sig.risk : sig.tps[sig.stage - sig.stepFrom - 1];
      }
      const LD = (this.cfg.ladder || {}).dyn;
      if (LD && (LD.whole || sig.stage === 0)) this._dyn(sig, LD, d); // the cap uses the first ladder target as TP1
      if (sig.stage === sig.tps.length) return this._closeLadder(sig, st, 'TP5_HIT', sig.tps[sig.tps.length - 1], t);
      if (sig.stage > before) { sig.status = 'TP1_HIT'; this.hooks.onUpdate && this.hooks.onUpdate(sig, prev === 'TP1_HIT' ? 'TP' + before : prev); }
    }
    // 5m confirmation: after price reached the zone, enter on the first 5m close back in the trade's direction
    _ladderConfirm(st, bar5) {
      for (const sig of this.openSignals(st.symbol)) {
        if (sig.strategy !== 'LADDER' || sig.status !== 'PENDING' || !sig.confirm || !sig.touched) continue;
        if (bar5.t + G.M5 <= sig.touched - 60) continue;           // this 5m candle closed before the touch
        const d = dirSign(sig.dir);
        if (d > 0 ? bar5.l <= sig.sl : bar5.h >= sig.sl) { this._closeLadder(sig, st, 'CANCELLED', bar5.c, bar5.t + G.M5); continue; }
        if (!(d > 0 ? bar5.c > bar5.o && bar5.c > sig.zone : bar5.c < bar5.o && bar5.c < sig.zone)) continue;
        const entry = bar5.c, risk = Math.abs(entry - sig.sl), first = sig.tps[0];
        if (risk > 1.5 * sig.risk || (first - entry) * d <= 0) { this._closeLadder(sig, st, 'CANCELLED', entry, bar5.t + G.M5); continue; } // confirmation came too late
        const prev = sig.status;
        sig.entry = entry; sig.risk = risk; sig.rs = sig.tps.map((x) => Math.abs(x - entry) / risk); sig.r1 = sig.rs[0]; sig.r2 = sig.rs[1];
        sig.status = 'ACTIVE'; sig.filledAt = bar5.t + G.M5; sig.price = entry;
        this.hooks.onUpdate && this.hooks.onUpdate(sig, prev);
      }
    }
    _closeLadder(sig, st, status, exitPrice, t) {
      const prev = sig.status, d = dirSign(sig.dir), n = sig.tps.length;
      let R = 0;
      if (status !== 'EXPIRED' && status !== 'CANCELLED') {
        // split3: 2 of 3 positions close at TP1, the third runs to TP5; otherwise one fifth closes at each target
        const w = sig.split3 ? [2 / 3, 0, 0, 0, 1 / 3] : sig.tps.map(() => 1 / n);
        let used = 0;
        for (let k = 0; k < sig.stage; k++) { R += sig.rs[k] * w[k]; used += w[k]; }
        const rem = 1 - used;
        R += ((d * (exitPrice - sig.entry)) / sig.risk) * rem;
      }
      sig.status = status; sig.closedAt = t; sig.exit = exitPrice; sig.result = Math.round(R * 100) / 100; sig.lastT = t;
      this.hooks.onUpdate && this.hooks.onUpdate(sig, prev);
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
      { const c = this.cfg, tr = c.trail || {};
        const pre = [c.beAtR ? `at +${c.beAtR}R move the SL to entry${c.beLockR ? ' +' + c.beLockR + 'R' : ''}` : '', c.softStop ? `close early if a ${c.softStop.tf / 60}m candle closes ${c.softStop.r}R against you` : '', c.dyn ? `trail the SL ${c.dyn.dist}R behind the best price, but never past ${fmt(sig.entry + dirSign(sig.dir) * (c.dyn.cap == null ? 0.5 : c.dyn.cap) * Math.abs(sig.tp1 - sig.entry), sig.dec)} (halfway to TP1)` : ''].filter(Boolean).join('; ');
        const post = tr.mode && tr.mode !== 'off' ? `trail the rest ${sig.market === 'forex' && tr.mode === 'pips' ? tr.pips + ' pips' : tr.atr + '× the 15m ATR'} behind price${tr.keepTp2 === false ? ' (TP2 is a guide)' : ''}` : 'let the rest run to TP2';
        lines.push(`Management: ${pre ? 'before TP1, ' + pre + '. ' : ''}Close ${Math.round(c.partialAtTp1 * 100)}% at TP1 and move the SL to entry${c.tp1Lock ? ' +' + c.tp1Lock + 'R' : ''}, then ${post}.`); }
      return lines.join(' ');
    }
  }

  // ---------- stats ----------
  function stats(list) {
    const closed = list.filter((s) => s.result != null && !['EXPIRED', 'CANCELLED'].includes(s.status));
    const wins = closed.filter((s) => s.result > 0);
    const sumR = closed.reduce((a, s) => a + s.result, 0);
    const gross = closed.filter((s) => s.result > 0).reduce((a, s) => a + s.result, 0);
    const loss = -closed.filter((s) => s.result < 0).reduce((a, s) => a + s.result, 0);
    let eq = 0, peak = 0, dd = 0; const curve = [];
    for (const s of [...closed].sort((a, b) => a.closedAt - b.closedAt)) { eq += s.result; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); curve.push({ t: s.closedAt, v: Math.round(eq * 100) / 100 }); }
    const count = (st) => closed.filter((s) => s.status === st).length;
    const group = (key) => {
      const o = {};
      for (const s of closed) { const k = key(s); o[k] = o[k] || { n: 0, w: 0, t1: 0, R: 0 }; o[k].n++; o[k].R += s.result; if (s.result > 0) o[k].w++; if (s.tp1At) o[k].t1++; }
      for (const k in o) o[k].R = Math.round(o[k].R * 100) / 100;
      return o;
    };
    return {
      total: list.length, closed: closed.length, open: list.filter((s) => ['PENDING', 'ACTIVE', 'TP1_HIT'].includes(s.status)).length,
      expired: list.filter((s) => s.status === 'EXPIRED' || s.status === 'CANCELLED').length,
      wins: wins.length, winRate: closed.length ? wins.length / closed.length : 0,
      tp1Hits: closed.filter((s) => s.tp1At).length, tp1Rate: closed.length ? closed.filter((s) => s.tp1At).length / closed.length : 0,
      sl: count('SL_HIT'), tp2: count('TP2_HIT') + count('TP5_HIT'), be: count('BE_HIT'), timeExit: count('TIME_EXIT'),
      totalR: Math.round(sumR * 100) / 100, avgR: closed.length ? sumR / closed.length : 0,
      profitFactor: loss ? gross / loss : gross ? Infinity : 0, maxDD: Math.round(dd * 100) / 100, curve,
      byGrade: group((s) => s.grade), bySymbol: group((s) => s.name), byKind: group((s) => s.kind), bySetup: group((s) => s.setup), byStrategy: group((s) => (s.strategy === 'LADDER' ? 'Royal Ladder' : 'ORB+')),
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
    const htf = [G.M2, G.M5, G.M15, G.H1, G.H2, G.H4];
    const counts = { 120: 1500, 300: 1500, 900: 1500, 3600: 2000, 7200: 1200, 14400: 1000 };
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
    for (const g of [G.M5, G.M15, G.H1, G.H2, G.H4]) {
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

  // Trade-management presets (management lab, 23 Nov 2026)
  const MANAGEMENT = {
    // Regime lab, 24 Nov 2026: both windows together, ORB+ only
    quality: { label: 'High quality', beAtR: 0.15, beLockR: 0.05, tp1Lock: 0.3, softStop: { r: 0.6, tf: 300 }, dyn: { dist: 1, cap: 0.5, whole: false }, trail: { mode: 'pips', pips: 20, atr: 0.75, keepTp2: false },
      minOrAtr: 0.6, maxOrAtr: 0.9, hours: { fromUtc: 6, toUtc: 18 }, ladder: {} },   // 89% in profit, PF 3.85, 3.7R DD, +100.1R, ~6 signals a day
    volume: { label: 'More signals', beAtR: 0.15, beLockR: 0.05, tp1Lock: 0.3, softStop: { r: 0.6, tf: 300 }, dyn: { dist: 1, cap: 0.5, whole: false }, trail: { mode: 'pips', pips: 20, atr: 0.75, keepTp2: false },
      minOrAtr: 0, maxOrAtr: 1.5, hours: null, ladder: {} },                            // 87% in profit, PF 2.37, 7.0R DD, +214.8R, ~23 signals a day
  };

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

  return { Engine, Series, DerivFeed, BridgeFeed, aggCandles, startLive, backtest, stats, trendOf, efficiency, pivots, fmt, toBar, decimalsOf, G, TF_NAME, DEFAULTS, DEFAULT_SYMBOLS, WELTRADE_SYMBOLS, MANAGEMENT, version: '1.10.0' };
});
