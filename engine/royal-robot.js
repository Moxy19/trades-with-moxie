/**
 * Royal Trades Robot: executes Royal Trades ORB+ signals automatically.
 *
 * Educational software, not financial advice. Automated trading can lose money quickly. Test in Paper or on a Deriv
 * demo account first, and only use money you can afford to lose.
 *
 *   signal (engine / server stream) -> Robot: filters, safety limits, sizing -> Broker: Paper | Deriv (Multipliers)
 *
 * Deriv execution uses Deriv's Options API (developers.deriv.com): a Personal Access Token (PAT) plus App ID is exchanged
 * for a one-time WebSocket URL (POST /trading/v1/options/accounts/{id}/otp), then MULTUP / MULTDOWN contracts are bought
 * with a broker-side stop loss (= the money at risk) and take profit. The robot then mirrors the engine's management:
 * half closes at TP1, the rest is closed when the engine closes the trade (stop, lock, trail, cut early, time exit).
 *
 * The token is never logged, never written to the journal and never sent anywhere but api.derivws.com.
 * Runs in the browser (terminal Robot tab) and in Node 22+ (server/server.js with ROBOT_MODE).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoyalRobot = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ROBOT_DEFAULTS = {
    mode: 'off',            // 'off' | 'paper' (no money, simulated) | 'demo' (Deriv demo account) | 'real' (Deriv real account)
    sizing: 'risk%',        // 'risk%' = % of balance lost if the stop is hit | 'risk$' = fixed $ lost at the stop | 'stake' = fixed stake ("lot size")
    riskPct: 1,             // % of balance at risk per trade (1–2% suggested)
    riskUsd: 0.2,           // $ at risk per trade when sizing = 'risk$'
    stake: 1,               // stake per trade when sizing = 'stake'
    multiplier: 'auto',     // 'auto' (picked so the stop costs exactly the money at risk) or a number such as 100
    maxRiskPct: 3,          // hard cap: never risk more than this % of balance on one trade (a minimum stake can force more)
    maxStake: 5,            // hard cap on stake per trade, $
    atTp1: 'auto',          // 'half' = two contracts, one closes at TP1 and one runs | 'all' = close everything at TP1 | 'auto' = half when the stake allows
    grades: ['A+', 'A'],    // grades to trade
    dirs: 'both',           // 'both' | 'buy' | 'sell'
    markets: ['synthetic'], // 'synthetic' | 'forex' (gold & forex) | 'crypto'
    skipRoyalty: true,      // skip 👑 Royalty markets (no proven edge)
    pairs: {},              // per-pair overrides: { R_75: { off: true } | { dirs: 'buy', stake: 2, maxTrades: 3, riskPct: 0.5 } }
    maxOpen: 2,             // max signals traded at the same time
    oneVsSymbol: true,      // never two positions on the same market
    maxPerDay: 8,           // max new trades per day (SAST)
    maxDailyLossPct: 6,     // stop for the day when the day's losses (closed + open risk) would pass this % of the start-of-day balance
    maxConsecLosses: 3,     // stop for the day after this many losing trades in a row
    minBalance: 3,          // never trade below this balance
    maxSlipR: 0.3,          // skip when price has already run this many R past the entry
    maxAgeSec: 180,         // skip signals older than this when the robot sees them
    paperBalance: 10,       // starting balance for Paper mode
  };

  const MULTS = [1, 5, 10, 20, 30, 40, 50, 60, 80, 100, 150, 200, 300, 400, 500, 600, 800, 1000, 1500, 2000];
  const CLOSED = ['SL_HIT', 'TP2_HIT', 'TP5_HIT', 'BE_HIT', 'BE_EARLY', 'TRAIL_EXIT', 'SOFT_EXIT', 'DYN_STOP', 'TIME_EXIT', 'EXPIRED', 'CANCELLED'];
  const cents = (x) => Math.round(x * 100) / 100;
  const floorC = (x) => Math.floor(x * 100 + 1e-9) / 100;
  const sgnOf = (dir) => (dir === 'BUY' ? 1 : -1);
  // SAST trading day (UTC+2)
  const dayKey = (ms) => new Date(ms + 2 * 3600e3).toISOString().slice(0, 10);

  /**
   * Size a trade for Multipliers. Loss at the stop ≈ stake × multiplier × |entry − SL| / entry.
   * Returns { legs: [{ stake, mult, sl$, tp$ }], risk, exposure, note } or { skip }.
   */
  function sizeTrade(o) {
    const { price, sl, r1, balance, set, mults, minStake } = o;
    const f = Math.abs(price - sl) / price;
    if (!(f > 0)) return { skip: 'stop is at the entry price' };
    const allowed = (mults && mults.length ? mults : MULTS).filter((m) => m * f < 0.9).sort((a, b) => b - a); // stop must sit well before Deriv's stop-out
    if (!allowed.length) return { skip: 'stop too far for any multiplier' };
    const cap = (balance * set.maxRiskPct) / 100;
    const wantHalf = set.atTp1 === 'half' || set.atTp1 === 'auto';
    let stake, mult, note = '';
    if (set.sizing === 'stake') {
      stake = +set.stake;
      if (set.multiplier !== 'auto') mult = +set.multiplier;
      else mult = allowed[allowed.length - 1]; // smallest multiplier: least exposure for a fixed stake
      if (!allowed.includes(mult)) mult = allowed.reduce((b, m) => (Math.abs(m - mult) < Math.abs(b - mult) ? m : b), allowed[0]);
    } else {
      const target = set.sizing === 'risk$' ? +set.riskUsd : (balance * set.riskPct) / 100;
      if (!(target > 0)) return { skip: 'risk is 0' };
      const legsWanted = wantHalf ? 2 : 1;
      const tryLegs = (n) => {
        if (set.multiplier !== 'auto') { const m = +set.multiplier; if (!allowed.includes(m)) return null; return { m, s: target / (m * f), n }; }
        for (const m of allowed) { const s = target / (m * f); if (s >= n * minStake) return { m, s, n }; } // largest multiplier that still meets the minimum stake: least money tied up
        const m = allowed[allowed.length - 1]; return { m, s: n * minStake, n, forced: true };
      };
      let t = tryLegs(legsWanted);
      if (t && t.forced && legsWanted === 2 && set.atTp1 === 'auto') t = tryLegs(1);
      if (!t) return { skip: 'multiplier ×' + set.multiplier + ' is not allowed for this stop' };
      stake = Math.max(t.s, t.n * minStake); mult = t.m;
      if (t.forced) note = 'minimum stake';
    }
    if (stake > set.maxStake) { stake = set.maxStake; note = 'stake capped at $' + set.maxStake; }
    if (stake > balance) return { skip: `stake $${stake.toFixed(2)} is more than the balance` };
    let n = set.atTp1 === 'all' ? 1 : set.atTp1 === 'half' ? 2 : stake / 2 >= minStake ? 2 : 1;
    if (n === 2 && stake / 2 < minStake) { if (set.atTp1 === 'half') stake = 2 * minStake; else n = 1; }
    const legStake = floorC(stake / n);
    if (legStake < minStake) return { skip: `stake under Deriv's $${minStake} minimum` };
    const legRisk = cents(legStake * mult * f);
    const risk = cents(legRisk * n);
    if (legRisk < 0.01) return { skip: 'risk rounds to $0.00' };
    if (risk > cap + 1e-9) return { skip: `needs $${risk.toFixed(2)} at risk (${((risk / balance) * 100).toFixed(1)}%), over the ${set.maxRiskPct}% cap` };
    const legs = [];
    for (let i = 0; i < n; i++) {
      const role = n === 1 ? 'all' : i === 0 ? 'tp1' : 'runner';
      legs.push({ role, stake: legStake, mult, sl$: legRisk, tp$: role === 'runner' ? null : cents(Math.max(0.01, legRisk * r1)) });
    }
    return { legs, risk, exposure: cents(legStake * n * mult), note };
  }

  // ---------------- Paper broker (no money; prices from the engine) ----------------
  class PaperBroker {
    constructor(opts = {}) {
      this.kind = 'paper'; this.balance = opts.balance == null ? 10 : opts.balance; this.currency = 'USD';
      this.minStake = 1; this.c = {}; this.n = 1; this.handlers = {}; this.last = {};
    }
    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
    emit(ev, d) { (this.handlers[ev] || []).forEach((f) => f(d)); }
    async connect() { return { accountId: 'PAPER', accountType: 'paper', balance: this.balance, currency: this.currency }; }
    async disconnect() {}
    async quote() { return { mults: MULTS, minStake: this.minStake }; }
    async open(o) {
      const px = o.price; if (!(px > 0)) throw new Error('no price');
      if (o.stake > this.balance) throw new Error('insufficient balance');
      const id = 'P' + this.n++;
      this.balance = cents(this.balance - o.stake);
      this.c[id] = { id, symbol: o.symbol, dir: o.dir, stake: o.stake, mult: o.mult, sl$: o.sl$, tp$: o.tp$, entry: px, profit: 0, open: true };
      this.emit('balance', this.balance);
      return { contractId: id, buyPrice: o.stake, entry: px };
    }
    _pnl(c, px) { return cents(c.stake * c.mult * sgnOf(c.dir) * (px - c.entry) / c.entry); }
    mark(symbol, px) {
      this.last[symbol] = px;
      for (const id in this.c) {
        const c = this.c[id]; if (!c.open || c.symbol !== symbol) continue;
        c.profit = this._pnl(c, px);
        if (c.profit <= -c.sl$) this._settle(c, -c.sl$, 'stop loss');
        else if (c.tp$ != null && c.profit >= c.tp$) this._settle(c, c.tp$, 'take profit');
        else if (c.profit <= -c.stake) this._settle(c, -c.stake, 'stop out');
      }
    }
    _settle(c, profit, why) {
      c.open = false; c.profit = cents(profit); this.balance = cents(this.balance + c.stake + c.profit);
      this.emit('balance', this.balance); this.emit('contract', { contractId: c.id, sold: true, profit: c.profit, why });
    }
    async close(id) { const c = this.c[id]; if (!c || !c.open) return { profit: c ? c.profit : 0 }; this._settle(c, this._pnl(c, this.last[c.symbol] ?? c.entry), 'closed by robot'); return { profit: c.profit }; }
    async update(id, lim) { const c = this.c[id]; if (c && c.open) { if (lim.sl$ != null) c.sl$ = lim.sl$; if ('tp$' in lim) c.tp$ = lim.tp$; } return true; }
    async openContracts() { return Object.values(this.c).filter((c) => c.open).map((c) => c.id); }
  }

  // ---------------- Deriv broker (Options API, Multipliers) ----------------
  class DerivBroker {
    constructor(opts = {}) {
      this.kind = 'deriv';
      this.token = opts.token; this.appId = String(opts.appId || ''); this.want = opts.accountType; // 'demo' | 'real'
      this.accountId = opts.accountId || ''; this.rest = opts.rest || 'https://api.derivws.com';
      this.WS = opts.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
      this.fetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
      this.handlers = {}; this.req = 1; this.pending = {}; this.ws = null; this.alive = false; this.closing = false;
      this.quotes = {}; this.watch = new Set(); this.currency = 'USD'; this.balance = null; this.minStake = 1;
      Object.defineProperty(this, 'token', { enumerable: false, writable: true, value: opts.token }); // keeps it out of JSON.stringify
    }
    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
    emit(ev, d) { (this.handlers[ev] || []).forEach((f) => f(d)); }
    async _api(path, method = 'GET', body) {
      const r = await this.fetch(this.rest + path, { method, headers: Object.assign({ Authorization: 'Bearer ' + this.token, 'Deriv-App-ID': this.appId }, body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
      let j = null; try { j = await r.json(); } catch (e) {}
      if (!r.ok) { const m = j && (j.error && (j.error.message || j.error.code) || j.message || (j.errors && j.errors[0] && j.errors[0].message)); throw new Error(`Deriv ${r.status}${m ? ': ' + m : ''}`); }
      return j;
    }
    async accounts() { const j = await this._api('/trading/v1/options/accounts'); return (j && j.data) || []; }
    async connect() {
      if (!this.token || !this.appId) throw new Error('Enter your Deriv App ID and API token');
      if (this.want !== 'demo' && this.want !== 'real') throw new Error('account type must be demo or real');
      const list = await this.accounts();
      let acc = this.accountId ? list.find((a) => a.account_id === this.accountId) : list.find((a) => a.account_type === this.want && a.status !== 'inactive');
      if (!acc) throw new Error(this.accountId ? `Account ${this.accountId} not found on this token` : `No ${this.want} options account on this token`);
      if (acc.account_type !== this.want) throw new Error(`Account ${acc.account_id} is a ${acc.account_type} account, but the robot is set to ${this.want}`); // safety: never trade real by accident
      this.accountId = acc.account_id; this.currency = acc.currency || 'USD'; this.balance = acc.balance;
      await this._open();
      const b = await this.call({ balance: 1, subscribe: 1 }).catch(() => null);
      if (b && b.balance) { this.balance = b.balance.balance; this.currency = b.balance.currency || this.currency; }
      return { accountId: this.accountId, accountType: acc.account_type, balance: this.balance, currency: this.currency };
    }
    async _open() {
      const j = await this._api(`/trading/v1/options/accounts/${encodeURIComponent(this.accountId)}/otp`, 'POST');
      const url = j && j.data && j.data.url;
      if (!url) throw new Error('Deriv did not return a WebSocket URL');
      const u = new URL(url);
      if (u.hostname !== new URL(this.rest).hostname || !u.pathname.endsWith('/ws/' + this.want)) throw new Error('Deriv returned an unexpected WebSocket address'); // never a real socket in demo mode
      await new Promise((resolve, reject) => {
        const ws = new this.WS(url); this.ws = ws; let opened = false;
        ws.onopen = () => { opened = true; this.alive = true; this.ping = setInterval(() => this._send({ ping: 1 }), 25000); this.emit('status', 'connected'); resolve(); };
        ws.onmessage = (e) => this._onMessage(e.data);
        ws.onerror = () => { if (!opened) reject(new Error('Deriv WebSocket error')); };
        ws.onclose = () => {
          this.alive = false; clearInterval(this.ping);
          for (const id in this.pending) { this.pending[id].reject(new Error('connection closed')); delete this.pending[id]; }
          if (this.closing) { this.emit('status', 'disconnected'); return; }
          this.emit('status', 'reconnecting');
          setTimeout(() => this._reconnect(), 3000);
        };
      });
    }
    async _reconnect() {
      if (this.closing) return;
      try {
        await this._open(); // a fresh one-time password every time
        await this.call({ balance: 1, subscribe: 1 }).catch(() => {});
        for (const id of this.watch) this._watch(id);
      } catch (e) { this.emit('status', 'reconnecting'); setTimeout(() => this._reconnect(), 10000); }
    }
    async disconnect() { this.closing = true; try { this.ws && this.ws.close(); } catch (e) {} }
    _send(m) { if (this.ws && this.alive) this.ws.send(JSON.stringify(m)); else throw new Error('not connected'); }
    call(m, timeout = 20000) {
      return new Promise((resolve, reject) => {
        const id = this.req++; m.req_id = id; this.pending[id] = { resolve, reject };
        setTimeout(() => { if (this.pending[id]) { delete this.pending[id]; reject(new Error('Deriv timeout')); } }, timeout);
        try { this._send(m); } catch (e) { delete this.pending[id]; reject(e); }
      });
    }
    _onMessage(raw) {
      let d; try { d = JSON.parse(raw); } catch (e) { return; }
      if (d.msg_type === 'balance' && d.balance && !d.error) { this.balance = d.balance.balance; this.emit('balance', this.balance); }
      if (d.msg_type === 'proposal_open_contract' && d.proposal_open_contract && !d.error) {
        const c = d.proposal_open_contract;
        if (c.contract_id) {
          const sold = !!c.is_sold || (c.status && c.status !== 'open');
          this.emit('contract', { contractId: c.contract_id, sold, profit: c.profit, entry: c.entry_spot != null ? +c.entry_spot : null, why: sold ? (c.status || 'sold') : null });
          if (sold) this.watch.delete(c.contract_id);
        }
      }
      const id = d.req_id; if (id && this.pending[id]) {
        const p = this.pending[id]; delete this.pending[id];
        if (d.error) p.reject(Object.assign(new Error(d.error.message || d.error.code), { code: d.error.code })); else p.resolve(d);
      }
    }
    async quote(symbol) {
      const q = this.quotes[symbol]; if (q && Date.now() - q.t < 6 * 3600e3) return q;
      const d = await this.call({ contracts_for: symbol });
      const av = ((d.contracts_for && d.contracts_for.available) || []).filter((x) => x.contract_type === 'MULTUP' || x.contract_type === 'MULTDOWN' || x.contract_category === 'multiplier');
      const mults = [...new Set(av.flatMap((x) => x.multiplier_range || []).map(Number))].filter((x) => x > 0).sort((a, b) => a - b);
      if (!mults.length) throw new Error('Multipliers are not offered on ' + symbol);
      return (this.quotes[symbol] = { mults, minStake: this.minStake, t: Date.now() });
    }
    async open(o) {
      const lim = { stop_loss: o.sl$ }; if (o.tp$ != null) lim.take_profit = o.tp$;
      const p = await this.call({ proposal: 1, amount: o.stake, basis: 'stake', contract_type: o.dir === 'BUY' ? 'MULTUP' : 'MULTDOWN', currency: this.currency, multiplier: o.mult, underlying_symbol: o.symbol, limit_order: lim });
      const pr = p.proposal;
      const b = await this.call({ buy: pr.id, price: pr.ask_price });
      const id = b.buy.contract_id; this.watch.add(id); this._watch(id);
      return { contractId: id, buyPrice: b.buy.buy_price, entry: pr.spot != null ? +pr.spot : null };
    }
    _watch(id) { this.call({ proposal_open_contract: 1, contract_id: id, subscribe: 1 }).catch(() => {}); }
    async close(id) { const d = await this.call({ sell: id, price: 0 }); return { soldFor: d.sell && d.sell.sold_for }; }
    async update(id, lim) {
      const l = {}; if (lim.sl$ != null) l.stop_loss = lim.sl$; if ('tp$' in lim) l.take_profit = lim.tp$;
      await this.call({ contract_update: 1, contract_id: id, limit_order: l }); return true;
    }
    async openContracts() { const d = await this.call({ portfolio: 1 }); return ((d.portfolio && d.portfolio.contracts) || []).map((c) => c.contract_id); }
  }

  // ---------------- Robot ----------------
  class Robot {
    constructor(settings, opts = {}) {
      this.set = Object.assign({}, ROBOT_DEFAULTS, settings || {});
      this.now = opts.now || (() => Date.now());
      this.store = opts.store || null; // { get(k), set(k, v) } for journal and positions (never the token)
      this.onChange = opts.onChange || (() => {});
      this.log = opts.log || (() => {});
      this.broker = null; this.running = false; this.status = 'stopped'; this.account = null; this.balance = null;
      this.pos = {}; this.wait = {}; this.journal = []; this.day = null; this.halt = null; this.startedAt = 0; this.busy = new Set();
      if (this.store) {
        this.journal = this.store.get('robot.journal') || [];
        this.day = this.store.get('robot.day') || null;
        this.pos = this.store.get('robot.pos') || {};
      }
    }
    setSettings(s) { this.set = Object.assign({}, ROBOT_DEFAULTS, this.set, s || {}); this._changed(); }
    _save() { if (!this.store) return; this.store.set('robot.journal', this.journal.slice(-300)); this.store.set('robot.day', this.day); this.store.set('robot.pos', this._posForSave()); }
    _posForSave() { const o = {}; for (const k in this.pos) { const p = this.pos[k]; o[k] = Object.assign({}, p, { sig: { id: p.sig.id, symbol: p.sig.symbol, name: p.sig.name, dir: p.sig.dir } }); } return o; }
    _changed() { this._save(); this.onChange(this.state()); }
    note(type, msg, extra) {
      const e = Object.assign({ t: this.now(), type, msg }, extra || {});
      this.journal.push(e); if (this.journal.length > 400) this.journal.splice(0, this.journal.length - 300);
      this.log(`[robot] ${type}: ${msg}`); this._changed(); return e;
    }
    _today() {
      const k = dayKey(this.now());
      if (!this.day || this.day.key !== k) { this.day = { key: k, startBal: this.balance, trades: 0, realized: 0, wins: 0, losses: 0, consec: 0 }; if (this.halt && this.halt.day) this.halt = null; }
      if (this.day.startBal == null && this.balance != null) this.day.startBal = this.balance;
      return this.day;
    }
    async start(broker) {
      if (this.running) return;
      if (this.set.mode === 'off') throw new Error('Choose Paper, Demo or Real first');
      this.broker = broker; this.status = 'connecting'; this._changed();
      broker.on('balance', (b) => { this.balance = b; this._changed(); });
      broker.on('contract', (c) => this._onContract(c));
      broker.on('status', (s) => { this.status = s === 'connected' ? 'running' : s; this._changed(); });
      try { this.account = await broker.connect(); }
      catch (e) { this.status = 'error'; this.note('error', 'Could not connect: ' + e.message); throw e; }
      this.balance = this.account.balance; this.running = true; this.status = 'running'; this.startedAt = this.now(); this.halt = null;
      this._today();
      // reconcile positions remembered from an earlier session with the broker
      const known = Object.values(this.pos).filter((p) => p.mode === this.set.mode);
      if (known.length && broker.kind !== 'paper') {
        try {
          const open = new Set((await broker.openContracts()).map(String));
          for (const p of known) for (const l of p.legs) if (l.open && !open.has(String(l.id))) { l.open = false; l.closedWhy = 'closed while the robot was off'; }
          for (const p of known) if (p.legs.every((l) => !l.open)) delete this.pos[p.sig.id];
        } catch (e) {}
      } else if (broker.kind === 'paper') { for (const k in this.pos) if (this.pos[k].mode === 'paper') delete this.pos[k]; }
      this.note('info', `Robot started · ${this.account.accountType === 'paper' ? 'Paper (no real money)' : 'Deriv ' + this.account.accountType + ' ' + this.account.accountId} · balance ${this.account.currency || 'USD'} ${(+this.balance).toFixed(2)}`);
    }
    async stop(closeAll = false) {
      if (closeAll) await this.closeAll('robot stopped');
      this.running = false; this.status = 'stopped';
      if (this.broker) { try { await this.broker.disconnect(); } catch (e) {} }
      this.note('info', 'Robot stopped' + (closeAll ? ' and all positions closed' : '. Open positions keep their broker stop loss and take profit.'));
    }
    async closeAll(why) { for (const k in this.pos) await this._closeLegs(this.pos[k], () => true, why); }
    state() {
      const d = this.day || {};
      const openPos = Object.values(this.pos).filter((p) => p.legs.some((l) => l.open));
      return {
        mode: this.set.mode, running: this.running, status: this.status, account: this.account, balance: this.balance,
        today: { trades: d.trades || 0, max: this.set.maxPerDay, realized: cents(d.realized || 0), wins: d.wins || 0, losses: d.losses || 0, consec: d.consec || 0, lossLimit: this._lossLimit() },
        open: openPos.map((p) => ({ id: p.sig.id, name: p.sig.name, symbol: p.sig.symbol, dir: p.sig.dir, risk: p.risk, stake: p.legs.reduce((a, l) => a + l.stake, 0), mult: p.legs[0] && p.legs[0].mult, legs: p.legs.length, profit: cents(p.legs.reduce((a, l) => a + (l.profit || 0), 0)), opened: p.t })),
        halt: this.halt, journal: this.journal.slice(-150),
      };
    }
    _lossLimit() { const b = (this.day && this.day.startBal) || this.balance || 0; return cents((b * this.set.maxDailyLossPct) / 100); }
    pairSet(sym) { return Object.assign({}, this.set, (this.set.pairs && this.set.pairs[sym]) || {}); }

    // ---- signal intake ----
    onSignal(sig) { return this._consider(sig); }
    onUpdate(sig, prev) {
      const p = this.pos[sig.id];
      if (p) { p.sig = sig; return this._manage(p, prev); }
      if (this.wait[sig.id] && sig.status === 'ACTIVE') { delete this.wait[sig.id]; return this._consider(sig); }
      if (this.wait[sig.id] && CLOSED.includes(sig.status)) delete this.wait[sig.id];
    }
    /** Called on price ticks: feeds Paper prices and keeps broker stops in step with the engine's moving stop. */
    tick(symbol, price) {
      if (this.broker && this.broker.kind === 'paper' && price > 0) this.broker.mark(symbol, price);
      for (const k in this.pos) { const p = this.pos[k]; if (p.sig.symbol === symbol) this._syncStop(p); }
    }
    async _consider(sig) {
      if (!this.running || this.set.mode === 'off') return null;
      if (this.pos[sig.id] || this.busy.has(sig.id)) return null;
      const skip = (why) => { this.note('skip', `${sig.dir} ${sig.name}: ${why}`, { sym: sig.symbol, sig: sig.id }); return null; };
      const ps = this.pairSet(sig.symbol);
      if (ps.off) return skip('pair is switched off in the robot');
      if ((sig.source || 'deriv') !== 'deriv' && this.broker.kind !== 'paper') return skip('not a Deriv market (Weltrade/MT5 signals need the MT5 robot)');
      if (!ps.grades.includes(sig.grade)) return skip(`grade ${sig.grade} is not in the robot's grades`);
      if (ps.dirs === 'buy' && sig.dir !== 'BUY') return skip('robot set to BUY only');
      if (ps.dirs === 'sell' && sig.dir !== 'SELL') return skip('robot set to SELL only');
      const mk = sig.market === 'synthetic' ? 'synthetic' : sig.market === 'crypto' ? 'crypto' : 'forex';
      if (!ps.markets.includes(mk)) return skip(`${mk} markets are off in the robot`);
      if (ps.skipRoyalty && sig.unproven) return skip('👑 Royalty market (no proven edge)');
      if ((sig.createdAt || 0) * 1000 < this.startedAt - 1000) return null; // signals from before the robot started: never back-trade
      if (sig.status === 'PENDING') { this.wait[sig.id] = true; this.note('info', `${sig.dir} ${sig.name}: limit order, waiting for the engine to fill it`, { sym: sig.symbol }); return null; }
      if (sig.status !== 'ACTIVE') return null;
      const age = this.now() / 1000 - (sig.filledAt || sig.createdAt || 0);
      if (age > ps.maxAgeSec) return skip(`signal is ${Math.round(age)}s old`);
      const d = this._today();
      if (this.halt) return skip('robot paused: ' + this.halt.why);
      if (d.trades >= ps.maxPerDay) return skip(`daily limit reached (${d.trades}/${ps.maxPerDay})`);
      const live = Object.values(this.pos).filter((p) => p.legs.some((l) => l.open));
      if (live.length >= ps.maxOpen) return skip(`max open trades (${ps.maxOpen}) reached`);
      if (ps.oneVsSymbol && live.some((p) => p.sig.symbol === sig.symbol)) return skip('already in a trade on this market');
      if (ps.maxTrades && Object.values(this.pos).filter((p) => p.sig.symbol === sig.symbol && p.day === d.key).length >= ps.maxTrades) return skip(`pair limit (${ps.maxTrades} a day) reached`);
      if (this.balance != null && this.balance < ps.minBalance) return skip(`balance under the $${ps.minBalance} floor`);
      const price = sig.price || sig.entry, sgn = sgnOf(sig.dir), runR = (sgn * (price - sig.entry)) / sig.risk;
      if (runR > ps.maxSlipR) return skip(`price already ${runR.toFixed(2)}R past the entry`);
      if (sgn * (price - sig.sl) <= 0) return skip('price is already beyond the stop');

      this.busy.add(sig.id);
      try {
        let q;
        try { q = await this.broker.quote(sig.symbol); } catch (e) { return skip(e.message); }
        const sz = sizeTrade({ price, sl: sig.sl, r1: sig.r1 || 1, balance: this.balance || 0, set: ps, mults: q.mults, minStake: q.minStake });
        if (sz.skip) return skip(sz.skip);
        const openRisk = live.reduce((a, p) => a + p.risk, 0);
        const lossToday = Math.max(0, -d.realized);
        if (lossToday + openRisk + sz.risk > this._lossLimit() + 1e-9) return skip(`would pass today's loss limit ($${this._lossLimit().toFixed(2)})`);
        const p = { sig, mode: this.set.mode, t: this.now(), day: d.key, risk: sz.risk, legs: [] };
        this.pos[sig.id] = p;
        for (const leg of sz.legs) {
          try {
            const r = await this.broker.open({ symbol: sig.symbol, dir: sig.dir, stake: leg.stake, mult: leg.mult, sl$: leg.sl$, tp$: leg.tp$, price });
            p.legs.push({ id: r.contractId, role: leg.role, stake: leg.stake, mult: leg.mult, sl$: leg.sl$, tp$: leg.tp$, entry: r.entry || price, open: true, profit: 0 });
          } catch (e) { this.note('error', `${sig.dir} ${sig.name}: order rejected: ${e.message}`, { sym: sig.symbol }); break; }
        }
        if (!p.legs.length) { delete this.pos[sig.id]; return null; }
        d.trades++;
        this.note('open', `${sig.dir} ${sig.name} · ${p.legs.length === 2 ? '2 × ' : ''}$${p.legs[0].stake.toFixed(2)} stake ×${p.legs[0].mult} · risk $${p.risk.toFixed(2)}${sz.note ? ' (' + sz.note + ')' : ''} · SL $${p.legs[0].sl$.toFixed(2)}${p.legs[0].tp$ != null ? ' · TP $' + p.legs[0].tp$.toFixed(2) : ''}`, { sym: sig.symbol, sig: sig.id, grade: sig.grade, dir: sig.dir, entry: price });
        if (p.sig.status !== 'ACTIVE') this._manage(p, 'ACTIVE'); // engine moved on while we were buying
        return p;
      } finally { this.busy.delete(sig.id); }
    }
    async _manage(p, prev) {
      const s = p.sig.status;
      if (s === 'TP1_HIT') await this._closeLegs(p, (l) => l.role === 'tp1' || l.role === 'all', 'TP1 hit');
      else if (CLOSED.includes(s)) await this._closeLegs(p, () => true, s.replace(/_/g, ' ').toLowerCase());
      this._syncStop(p);
    }
    async _closeLegs(p, which, why) {
      for (const l of p.legs) {
        if (!l.open || !which(l) || l.closing) continue;
        l.closing = true; l.closedWhy = why;
        try { const r = await this.broker.close(l.id); if (l.open && r && r.profit != null) this._legClosed(p, l, r.profit, why); else if (l.open) l.closedWhy = why; }
        catch (e) { if (!/sold|expired|not found|already/i.test(e.message)) this.note('error', `${p.sig.name}: could not close contract ${l.id}: ${e.message}`); }
        finally { l.closing = false; }
      }
    }
    _onContract(c) {
      for (const k in this.pos) {
        const p = this.pos[k]; const l = p.legs.find((x) => String(x.id) === String(c.contractId)); if (!l) continue;
        if (c.entry && !l.entryFixed) { l.entry = c.entry; l.entryFixed = true; }
        if (c.profit != null) l.profit = +c.profit;
        if (c.sold && l.open) this._legClosed(p, l, +c.profit || 0, l.closedWhy || c.why || 'closed');
        else this.onChange(this.state());
        return;
      }
    }
    _legClosed(p, l, profit, why) {
      l.open = false; l.profit = cents(profit); l.closedWhy = why;
      if (p.legs.some((x) => x.open)) { this._changed(); return; }
      const net = cents(p.legs.reduce((a, x) => a + (x.profit || 0), 0)), d = this._today();
      d.realized = cents(d.realized + net);
      if (net < 0) { d.losses++; d.consec++; } else { d.wins++; d.consec = 0; }
      this.note('close', `${p.sig.dir} ${p.sig.name} closed (${why}) · ${net >= 0 ? '+' : '−'}$${Math.abs(net).toFixed(2)}${p.risk ? ' (' + (net / p.risk >= 0 ? '+' : '') + (net / p.risk).toFixed(2) + 'R)' : ''}`, { sym: p.sig.symbol, sig: p.sig.id, pnl: net });
      delete this.pos[p.sig.id];
      if (d.consec >= this.set.maxConsecLosses) this._halt(`${d.consec} losses in a row`);
      else if (-d.realized >= this._lossLimit() - 1e-9 && this._lossLimit() > 0) this._halt(`daily loss limit hit (−$${(-d.realized).toFixed(2)})`);
      this._changed();
    }
    _halt(why) { this.halt = { why, t: this.now(), day: true }; this.note('halt', 'Robot paused until tomorrow (SAST): ' + why); }
    resume() { this.halt = null; this.note('info', 'Pause lifted by you'); }
    /** Tighten the broker stop loss as the engine's stop moves toward entry (a stop loss on Deriv can only cap a loss). */
    _syncStop(p) {
      const s = p.sig; if (!s || s.slLive == null || !this.broker) return;
      const sgn = sgnOf(s.dir), t = this.now();
      for (const l of p.legs) {
        if (!l.open || l.closing) continue;
        const lossPx = Math.max(0, sgn * (l.entry - s.slLive)); // price distance still at risk
        const want = Math.max(0.01, floorC(l.stake * l.mult * lossPx / l.entry));
        if (want >= l.sl$ - 0.01 || (l.syncT && t - l.syncT < 10000)) continue;
        l.syncT = t;
        const was = l.sl$; l.sl$ = want;
        this.broker.update(l.id, { sl$: want }).catch((e) => { l.sl$ = was; if (!l.syncErr) { l.syncErr = true; this.note('info', `${s.name}: broker stop not tightened (${e.message}); the robot will still close it when the engine does`); } });
      }
    }
  }

  return { Robot, PaperBroker, DerivBroker, sizeTrade, ROBOT_DEFAULTS, MULTS, dayKey, version: '1.0.0' };
});
