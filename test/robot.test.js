// Royal Trades Robot tests: sizing, safety limits, Paper trading on the live engine path, and the Deriv API client
// against a fake Deriv server (the sandbox cannot reach Deriv). Run: node test/robot.test.js
const assert = require('assert');
const M = require('../engine/moxie-engine.js');
const R = require('../engine/royal-robot.js');
const { gen, agg } = require('./mockfeed.js');

const base = Object.assign({}, R.ROBOT_DEFAULTS);
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  // ---------- 1) sizing ----------
  {
    // $10 account, 1% risk, synthetic at 40,000 with the stop 80 away (0.2%): $0.10 at risk
    const s = R.sizeTrade({ price: 40000, sl: 39920, r1: 1.2, balance: 10, set: Object.assign({}, base, { riskPct: 1 }), mults: [50, 100, 200, 300, 500], minStake: 1 });
    assert(!s.skip, s.skip);
    console.log('size $10 @1%:', JSON.stringify(s));
    assert(s.risk <= 10 * base.maxRiskPct / 100 + 1e-9, 'risk under cap');
    for (const l of s.legs) { assert(l.stake >= 1, 'min stake'); assert(l.sl$ > 0 && l.sl$ <= l.stake, 'stop loss within stake'); }
    // the stop costs the money at risk: stake × mult × distance / price
    const calc = s.legs.reduce((a, l) => a + l.stake * l.mult * 80 / 40000, 0);
    assert(Math.abs(calc - s.risk) < 0.02, 'risk matches the stop distance');

    // $1,000 account, 1%: two legs (half at TP1), exactly ~$10 at risk
    const b = R.sizeTrade({ price: 40000, sl: 39920, r1: 1.2, balance: 1000, set: Object.assign({}, base, { maxStake: 100 }), mults: [50, 100, 200, 300, 500], minStake: 1 });
    assert.strictEqual(b.legs.length, 2); assert(Math.abs(b.risk - 10) < 0.1, 'risk ~ $10: ' + b.risk);
    assert.strictEqual(b.legs[0].role, 'tp1'); assert.strictEqual(b.legs[1].tp$, null, 'runner has no broker TP');
    assert(Math.abs(b.legs[0].tp$ - b.legs[0].sl$ * 1.2) < 0.02, 'TP1 leg take profit = 1.2R');

    // a wide stop on a tiny account cannot meet the minimum stake without passing the cap: skip, never oversize
    const w = R.sizeTrade({ price: 100, sl: 90, r1: 1, balance: 10, set: base, mults: [10, 20, 50], minStake: 1 });
    assert(w.skip, 'oversized trade must be skipped'); console.log('skip:', w.skip);

    // fixed stake ("lot size") mode
    const f = R.sizeTrade({ price: 40000, sl: 39920, r1: 1, balance: 50, set: Object.assign({}, base, { sizing: 'stake', stake: 2, multiplier: 100, atTp1: 'all' }), mults: [50, 100, 200], minStake: 1 });
    assert.strictEqual(f.legs.length, 1); assert.strictEqual(f.legs[0].stake, 2); assert.strictEqual(f.legs[0].mult, 100); assert(Math.abs(f.risk - 0.4) < 0.01);
    // stake cap
    const c = R.sizeTrade({ price: 40000, sl: 39920, r1: 1, balance: 10000, set: Object.assign({}, base, { maxStake: 5 }), mults: [50], minStake: 1 });
    assert(c.legs.reduce((a, l) => a + l.stake, 0) <= 5 + 1e-9, 'stake capped');
  }

  // ---------- 2) gates and safety limits (Paper) ----------
  {
    let now = 1795000000 * 1000;
    const robot = new R.Robot(Object.assign({}, base, { mode: 'paper', maxConsecLosses: 2, markets: ['synthetic', 'forex', 'crypto'] }), { now: () => now });
    const paper = new R.PaperBroker({ balance: 10 });
    await robot.start(paper);
    const mk = (o) => Object.assign({ id: Math.random().toString(36).slice(2), symbol: 'R_75', name: 'Volatility 75', market: 'synthetic', source: 'deriv', dir: 'BUY', grade: 'A', status: 'ACTIVE', entry: 40000, price: 40000, sl: 39920, slLive: 39920, tp1: 40096, tp2: 40200, risk: 80, r1: 1.2, r2: 2.5, createdAt: now / 1000, filledAt: now / 1000, unproven: false }, o);
    await robot.onSignal(mk({ grade: 'B' }));
    await robot.onSignal(mk({ unproven: true }));
    await robot.onSignal(mk({ source: 'mt5', symbol: 'FlipX-1', market: 'synthetic' })); // paper may simulate it; real Deriv would skip
    await robot.onSignal(mk({ filledAt: now / 1000 - 400 }));
    await robot.onSignal(mk({ price: 40040 }));
    await robot.closeAll('test reset'); robot.day.trades = 0; robot.day.realized = 0; // 0.5R past entry
    const skips = robot.journal.filter((j) => j.type === 'skip').map((j) => j.msg);
    console.log('skips:', skips);
    assert(skips.some((m) => /grade B/.test(m)) && skips.some((m) => /Royalty/.test(m)) && skips.some((m) => /old/.test(m)) && skips.some((m) => /past the entry/.test(m)));

    // two losses in a row -> paused for the day
    for (let i = 0; i < 2; i++) {
      const s = mk({ symbol: 'R_' + i, name: 'Mkt ' + i });
      robot.tick(s.symbol, 40000); const p = await robot.onSignal(s); assert(p, 'opened');
      robot.tick(s.symbol, 39900); await tick(); // paper broker stop loss fires at the broker
      s.status = 'SL_HIT'; await robot.onUpdate(s, 'ACTIVE');
    }
    assert(robot.halt, 'halted after losses'); console.log('halt:', robot.halt.why, '· realized', robot.day.realized, '· balance', paper.balance);
    assert(robot.day.realized < 0 && robot.day.realized >= -0.5, 'losses capped by stop');
    const p2 = await robot.onSignal(mk({ symbol: 'R_9' })); assert(!p2, 'no trades while halted');
    now += 24 * 3600e3; // next SAST day lifts the pause
    const s3 = mk({ symbol: 'R_9', createdAt: now / 1000, filledAt: now / 1000 }); robot.tick('R_9', 40000);
    assert(await robot.onSignal(s3), 'trades again next day');
    // max open trades
    const s4 = mk({ symbol: 'R_8', createdAt: now / 1000, filledAt: now / 1000 }); robot.tick('R_8', 40000); assert(await robot.onSignal(s4));
    const s5 = mk({ symbol: 'R_7', createdAt: now / 1000, filledAt: now / 1000 }); assert(!(await robot.onSignal(s5)), 'max open');
    assert(/max open/.test(robot.journal[robot.journal.length - 1].msg));
    // TP1: tp1 leg closes at the broker TP, runner stays; engine closes the rest
    const pos = robot.pos[s3.id]; assert.strictEqual(pos.legs.length, 2, 'half at TP1, half runs');
    robot.tick('R_9', 40096 + 1); await tick();
    s3.status = 'TP1_HIT'; await robot.onUpdate(s3, 'ACTIVE');
    assert(robot.pos[s3.id] && robot.pos[s3.id].legs.filter((l) => l.open).length === 1, 'runner still open after TP1');
    robot.tick('R_9', 40130); s3.status = 'TRAIL_EXIT'; await robot.onUpdate(s3, 'TP1_HIT');
    assert(!robot.pos[s3.id], 'runner closed when the engine trailed out');
    const last = robot.journal.filter((j) => j.type === 'close').pop(); console.log('tp1 close:', last.msg); assert(last.pnl > 0);
    await robot.stop(true); assert(Object.keys(robot.pos).length === 0, 'stop(true) closes all');
  }

  // ---------- 3) Paper robot on the real engine (live path, mock market) ----------
  {
    const m1 = gen(5); const cut = m1.length - 60 * 24 * 4; const hist = m1.slice(0, cut), future = m1.slice(cut);
    let now = future[0].epoch * 1000;
    const robot = new R.Robot(Object.assign({}, base, { mode: 'paper', grades: ['A+', 'A', 'B'], markets: ['synthetic', 'forex', 'crypto'], skipRoyalty: false, maxPerDay: 50, maxConsecLosses: 99, maxDailyLossPct: 100, riskPct: 2 }), { now: () => now });
    const paper = new R.PaperBroker({ balance: 1000 }); await robot.start(paper);
    const eng = new M.Engine({ trendMode: 'adaptive', minScore: 50, minScalpScore: 60, hours: null, minOrAtr: 0, maxOrAtr: 9, orbOff: [] }, { onSignal: (s) => robot.onSignal(s), onUpdate: (s, p) => robot.onUpdate(s, p) });
    eng.mode = 'backtest';
    eng.addSymbol('LIVE', { name: 'Live test', decimals: 2, market: 'synthetic' });
    for (const g of [120, 300, 900, 3600, 7200, 14400]) eng.seed('LIVE', g, agg(hist, g));
    eng.seed('LIVE', 60, hist); eng.finishSeed('LIVE');
    for (const b of future) {
      now = (b.epoch + 60) * 1000;
      for (let k = 1; k <= 3; k++) { const px = k === 3 ? b.close : b.open + (b.close - b.open) * k / 3; eng.onBar('LIVE', { open_time: b.epoch, open: b.open, high: b.high, low: b.low, close: px }); robot.tick('LIVE', px); await tick(); }
    }
    const opens = robot.journal.filter((j) => j.type === 'open').length, closes = robot.journal.filter((j) => j.type === 'close');
    const pnl = closes.reduce((a, j) => a + j.pnl, 0);
    console.log(`engine signals ${eng.signals.length} · robot opened ${opens} · closed ${closes.length} · paper P/L $${pnl.toFixed(2)} · balance $${paper.balance}`);
    const engR = eng.signals.filter((s) => s.result != null).reduce((a, s) => a + s.result, 0);
    console.log('engine R on the same signals:', engR.toFixed(2));
    assert(opens > 0, 'robot traded engine signals');
    for (const j of closes) assert(j.pnl >= -1000 * 0.03 - 0.05, 'no loss larger than the risk cap: ' + j.pnl);
    const openLeft = Object.values(robot.pos).filter((p) => p.legs.some((l) => l.open)).length;
    const engOpen = eng.signals.filter((s) => ['ACTIVE', 'TP1_HIT'].includes(s.status)).length;
    assert(openLeft <= engOpen, 'robot holds nothing the engine has closed');
  }

  // ---------- 4) Deriv API client against a fake Deriv ----------
  {
    const TOKEN = 'pat_SECRET_do_not_leak_123';
    const sent = []; let accounts = [{ account_id: 'DOT1', account_type: 'demo', balance: 10, currency: 'USD', status: 'active' }, { account_id: 'ROT2', account_type: 'real', balance: 10, currency: 'USD', status: 'active' }];
    const fetchFake = async (url, o) => {
      assert.strictEqual(o.headers.Authorization, 'Bearer ' + TOKEN); assert.strictEqual(o.headers['Deriv-App-ID'], '12345');
      const u = new URL(url);
      if (u.pathname === '/trading/v1/options/accounts') return { ok: true, status: 200, json: async () => ({ data: accounts }) };
      const m = u.pathname.match(/accounts\/(\w+)\/otp$/); if (m && o.method === 'POST') { const a = accounts.find((x) => x.account_id === m[1]); return { ok: true, status: 200, json: async () => ({ data: { url: `wss://api.derivws.com/trading/v1/options/ws/${a.account_type}?otp=abc` } }) }; }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    let nextId = 900;
    class FakeWS {
      constructor(url) { this.url = url; this.readyState = 1; setTimeout(() => this.onopen && this.onopen(), 1); }
      send(raw) {
        const m = JSON.parse(raw); sent.push(m); const out = (d) => setTimeout(() => this.onmessage({ data: JSON.stringify(Object.assign({ req_id: m.req_id, echo_req: m }, d)) }), 1);
        if (m.balance) out({ msg_type: 'balance', balance: { balance: 10, currency: 'USD', loginid: 'DOT1' } });
        else if (m.contracts_for) out({ msg_type: 'contracts_for', contracts_for: { available: [{ contract_type: 'MULTUP', contract_category: 'multiplier', multiplier_range: [50, 100, 200, 300, 500] }, { contract_type: 'MULTDOWN', contract_category: 'multiplier', multiplier_range: [50, 100, 200, 300, 500] }] } });
        else if (m.proposal) out({ msg_type: 'proposal', proposal: { id: 'p'.repeat(32), ask_price: m.amount, spot: 40000, commission: 0.02 } });
        else if (m.buy) { const id = nextId++; out({ msg_type: 'buy', buy: { contract_id: id, buy_price: 1, transaction_id: 1 } }); }
        else if (m.proposal_open_contract) out({ msg_type: 'proposal_open_contract', proposal_open_contract: { contract_id: m.contract_id, is_sold: 0, status: 'open', profit: 0.02, entry_spot: 40001 } });
        else if (m.sell) { out({ msg_type: 'sell', sell: { sold_for: 1.05, contract_id: m.sell } }); setTimeout(() => this.onmessage({ data: JSON.stringify({ msg_type: 'proposal_open_contract', proposal_open_contract: { contract_id: m.sell, is_sold: 1, status: 'sold', profit: 0.05 } }) }), 3); }
        else if (m.contract_update) out({ msg_type: 'contract_update', contract_update: {} });
        else if (m.portfolio) out({ msg_type: 'portfolio', portfolio: { contracts: [] } });
      }
      close() { this.onclose && this.onclose(); }
    }
    // demo mode never connects a real account
    const bad = new R.DerivBroker({ token: TOKEN, appId: '12345', accountType: 'demo', accountId: 'ROT2', fetch: fetchFake, WebSocket: FakeWS });
    await assert.rejects(() => bad.connect(), /real account, but the robot is set to demo/);

    let now = Date.now();
    const logs = [];
    const robot = new R.Robot(Object.assign({}, base, { mode: 'demo' }), { now: () => now, log: (m) => logs.push(m) });
    const broker = new R.DerivBroker({ token: TOKEN, appId: '12345', accountType: 'demo', fetch: fetchFake, WebSocket: FakeWS });
    await robot.start(broker);
    assert.strictEqual(robot.account.accountId, 'DOT1');
    const sig = { id: 'x1', symbol: 'R_75', name: 'Volatility 75', market: 'synthetic', source: 'deriv', dir: 'SELL', grade: 'A+', status: 'ACTIVE', entry: 40000, price: 40000, sl: 40080, slLive: 40080, tp1: 39904, tp2: 39800, risk: 80, r1: 1.2, createdAt: now / 1000, filledAt: now / 1000 };
    const p = await robot.onSignal(sig); assert(p, 'opened on Deriv demo');
    const prop = sent.find((m) => m.proposal);
    console.log('proposal sent:', JSON.stringify(prop));
    assert.strictEqual(prop.contract_type, 'MULTDOWN'); assert.strictEqual(prop.basis, 'stake'); assert(prop.limit_order.stop_loss > 0 && prop.limit_order.take_profit > 0);
    assert(sent.find((m) => m.buy && m.price === prop.amount), 'buy at the quoted price');
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(robot.pos.x1.legs[0].entry, 40001, 'entry from the contract stream');
    sig.status = 'BE_EARLY'; await robot.onUpdate(sig, 'ACTIVE'); await new Promise((r) => setTimeout(r, 20));
    assert(sent.find((m) => m.sell), 'robot sold when the engine closed'); assert(!robot.pos.x1, 'position closed');
    // the token never reaches the journal, the logs, saved state or JSON
    const everything = JSON.stringify(robot.journal) + logs.join('\n') + JSON.stringify(robot.state()) + JSON.stringify(Object.assign({}, broker, { ws: null, ping: null, pending: null })) + JSON.stringify(sent);
    assert(!everything.includes(TOKEN), 'token leaked');
    await robot.stop();
  }
  console.log('ROBOT TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
