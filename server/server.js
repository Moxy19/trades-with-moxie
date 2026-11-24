#!/usr/bin/env node
/**
 * Royal Trades — signal server (Node 22+, zero dependencies)
 *
 * Runs the ORB+ engine 24/7 on Deriv's public feed plus any MT5 broker (Weltrade SyntX) via the bridge EA, stores every signal,
 * streams them to the web terminal (Server-Sent Events) and, optionally, posts them to Telegram.
 *
 *   PORT=8080 ACCESS_KEY=secret TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node server.js
 *
 * Env:
 *   PORT                 http port (default 8080)
 *   ACCESS_KEY           optional; if set, every /api call needs ?key=... (simple member gate)
 *   SYMBOLS              optional comma list; prefix MT5-bridge (Weltrade) codes with mt5: (e.g. mt5:FlipX-4,stpRNG,R_75)
 *   BRIDGE_KEY           secret the MT5 bridge EA must send (defaults to ACCESS_KEY; required for /api/bridge)
 *   TREND_MODE           adaptive | strict
 *   MIN_SCORE            62 (B+) | 74 (A+) | 85 (A+ only)
 *   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID   optional broadcast of new signals and results
 *   DATA_DIR             where signals.json is kept (default ./data)
 *
 * Robot (auto-execution, optional; educational, not financial advice):
 *   ROBOT_MODE           paper | demo | real (default off). real also needs ROBOT_REAL_CONFIRM=I_UNDERSTAND
 *   DERIV_APP_ID / DERIV_TOKEN   Deriv App ID and Personal Access Token (trade scope only). Never logged.
 *   DERIV_ACCOUNT        optional options account ID (default: the first demo or real account on the token)
 *   ROBOT_SETTINGS       optional JSON overriding the robot defaults, e.g. {"riskPct":1,"maxOpen":2,"grades":["A+","A"]}
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const M = require('../engine/moxie-engine.js');
const RB = require('../engine/royal-robot.js');

const PORT = +process.env.PORT || 8080;
const KEY = process.env.ACCESS_KEY || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const WEB_DIR = path.join(__dirname, '..', 'web');
const ENGINE_FILE = path.join(__dirname, '..', 'engine', 'moxie-engine.js');
const ROBOT_FILE = path.join(__dirname, '..', 'engine', 'royal-robot.js');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '', TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
fs.mkdirSync(DATA_DIR, { recursive: true });
const SIG_FILE = path.join(DATA_DIR, 'signals.json');

if (typeof WebSocket === 'undefined') { console.error('Node 22+ is required (built-in WebSocket).'); process.exit(1); }

// ---------- symbols ----------
let SYMBOLS = M.DEFAULT_SYMBOLS;
if (process.env.SYMBOLS) {
  SYMBOLS = process.env.SYMBOLS.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    if (s.startsWith('mt5:')) { const c = s.slice(4); return { symbol: c, name: c.replace(/-/g, ' '), market: 'synthetic', source: 'mt5' }; }
    const d = M.DEFAULT_SYMBOLS.concat(M.WELTRADE_SYMBOLS || []).find((x) => x.symbol === s);
    return d || { symbol: s, name: s, market: /^frx/.test(s) ? 'forex' : /^cry/.test(s) ? 'crypto' : 'synthetic', source: 'deriv' };
  });
}

// ---------- engine + persistence ----------
const cfg = {};
if (process.env.TREND_MODE) cfg.trendMode = process.env.TREND_MODE;
if (process.env.MIN_SCORE) cfg.minScore = +process.env.MIN_SCORE;
const clients = new Set();
function broadcast(event, data) { const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const res of clients) res.write(msg); }
let saveT = null;
function save() { clearTimeout(saveT); saveT = setTimeout(() => fs.writeFile(SIG_FILE, JSON.stringify(engine.signals.slice(-3000)), () => {}), 500); }

// ---------- robot (optional auto-execution) ----------
let robot = null;
const ROBOT_MODE = (process.env.ROBOT_MODE || 'off').toLowerCase();
if (['paper', 'demo', 'real'].includes(ROBOT_MODE)) {
  if (ROBOT_MODE === 'real' && process.env.ROBOT_REAL_CONFIRM !== 'I_UNDERSTAND') { console.error('ROBOT_MODE=real needs ROBOT_REAL_CONFIRM=I_UNDERSTAND. Robot not started.'); }
  else {
    let extra = {}; try { extra = JSON.parse(process.env.ROBOT_SETTINGS || '{}'); } catch (e) { console.error('ROBOT_SETTINGS is not valid JSON, using defaults'); }
    const rstore = { get: (k) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, k + '.json'), 'utf8')); } catch (e) { return null; } }, set: (k, v) => fs.writeFile(path.join(DATA_DIR, k + '.json'), JSON.stringify(v), () => {}) };
    robot = new RB.Robot(Object.assign({}, extra, { mode: ROBOT_MODE }), { store: rstore, log: (m) => console.log(new Date().toISOString(), m) });
  }
}
async function startRobot() {
  if (!robot) return;
  const broker = ROBOT_MODE === 'paper' ? new RB.PaperBroker({ balance: robot.set.paperBalance })
    : new RB.DerivBroker({ token: process.env.DERIV_TOKEN, appId: process.env.DERIV_APP_ID, accountType: ROBOT_MODE, accountId: process.env.DERIV_ACCOUNT || '' });
  try { await robot.start(broker); } catch (e) { console.error('robot not started:', e.message); }
}

const engine = new M.Engine(cfg, {
  onSignal(sig) { if (robot) Promise.resolve().then(() => robot.onSignal(sig)).catch((e) => console.error('robot', e.message)); save(); broadcast('signal', sig); telegram(signalText(sig)); console.log(new Date().toISOString(), 'SIGNAL', sig.dir, sig.symbol, sig.grade, sig.entry); },
  onUpdate(sig, prev) {
    save(); broadcast('update', { sig, prev });
    if (robot) Promise.resolve().then(() => robot.onUpdate(sig, prev)).catch((e) => console.error('robot', e.message));
    if (prev !== sig.status && ['TP1_HIT', 'TP2_HIT', 'SL_HIT', 'BE_HIT'].includes(sig.status)) {
      telegram(`${sig.name} ${sig.dir} → ${sig.status.replace('_', ' ')}${sig.result != null ? ` (${sig.result > 0 ? '+' : ''}${sig.result}R)` : ''}`);
      console.log(new Date().toISOString(), 'UPDATE', sig.symbol, prev, '->', sig.status, sig.result ?? '');
    }
  },
});
try { engine.restoreSignals(JSON.parse(fs.readFileSync(SIG_FILE, 'utf8'))); console.log('restored', engine.signals.length, 'signals'); } catch (e) {}

function signalText(s) {
  const d = s.dec, f = (x) => M.fmt(x, d);
  return `${s.dir === 'BUY' ? '🟢 BUY' : '🔴 SELL'} — ${s.name} · ${s.tf} · ${s.setup}${s.kind === 'SCALP' ? ' (scalp)' : ''}\nGrade ${s.grade} (${s.score}/100)\nEntry: ${f(s.entry)}${s.entryType === 'LIMIT' ? ' (limit)' : ''}\nSL: ${f(s.sl)}\nTP1: ${f(s.tp1)} (${s.r1.toFixed(2)}R): close half, SL to entry\nTP2: ${f(s.tp2)} (${s.r2.toFixed(2)}R)\n— Royal Trades · educational, not financial advice`;
}
async function telegram(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try { await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text }) }); } catch (e) { console.error('telegram', e.message); }
}

// ---------- feeds ----------
const feeds = {
  deriv: new M.DerivFeed({ onStatus: (s) => console.log('deriv feed:', s) }),
  mt5: new M.BridgeFeed(),
};
const BRIDGE_KEY = process.env.BRIDGE_KEY || KEY;
let lastTick = 0;
async function start() {
  await feeds.deriv.connect().catch((e) => console.error('deriv connect', e.message));
  startRobot();
  await M.startLive(engine, feeds, SYMBOLS, { concurrency: 3, log: console.log, onTick: (sym) => { lastTick = Date.now(); if (robot && robot.running) { const sn = engine.sym[sym]; if (sn && sn.price) robot.tick(sym, sn.price); } } });
  console.log('engine live on', SYMBOLS.length, 'markets');
}
function scanner() { const o = {}; for (const s of SYMBOLS) { const x = engine.snapshot(s.symbol); if (x) o[s.symbol] = x; } return o; }
setInterval(() => { if (clients.size) broadcast('scanner', scanner()); }, 5000);

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css' };
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, limit = 5e6) {
  return new Promise((resolve, reject) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > limit) { reject(new Error('too large')); req.destroy(); } }); req.on('end', () => resolve(b)); req.on('error', reject); });
}
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  // MT5 bridge: your MT5 terminal pushes Weltrade (or any broker) bars here
  if (u.pathname === '/api/bridge' && req.method === 'POST') {
    if (!BRIDGE_KEY) return send(res, 403, { error: 'set BRIDGE_KEY (or ACCESS_KEY) on the server first' });
    try {
      const body = JSON.parse((await readBody(req)).replace(/\u0000/g, ''));
      if (body.key !== BRIDGE_KEY) return send(res, 401, { error: 'bad bridge key' });
      let n = 0; for (const p of body.symbols || [body]) n += feeds.mt5.ingest(p);
      lastTick = Date.now();
      return send(res, 200, { ok: true, bars: n });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (u.pathname === '/api/health') return send(res, 200, { app: 'royal-trades', version: M.version, markets: SYMBOLS.length, lastTick, signals: engine.signals.length });
  if (u.pathname.startsWith('/api/')) {
    if (KEY && u.searchParams.get('key') !== KEY) return send(res, 401, { error: 'access key required' });
    if (u.pathname === '/api/signals') return send(res, 200, engine.signals.slice(-600));
    if (u.pathname === '/api/scanner') return send(res, 200, scanner());
    if (u.pathname === '/api/stats') return send(res, 200, M.stats(engine.signals));
    // flat feed for the MT5 robot EA (MQL5 has no JSON parser): one signal per line, fields separated by |
    if (u.pathname === '/api/robot/feed') {
      const since = Date.now() / 1000 - 6 * 3600, n = (x) => (x == null ? '' : String(x));
      const rows = engine.signals.filter((x) => (x.lastT || x.createdAt) >= since).map((x) => [x.id, x.symbol, x.source || 'deriv', x.market, x.dir, x.status, x.grade, x.unproven ? 1 : 0, x.entry, x.sl, x.slLive ?? x.sl, x.tp1, x.tp2, x.createdAt, x.filledAt ?? '', x.price ?? ''].map(n).join('|'));
      return send(res, 200, rows.join('\n'), 'text/plain; charset=utf-8');
    }
    if (u.pathname === '/api/robot') { if (!robot) return send(res, 200, { mode: 'off' }); const st = robot.state(); return send(res, 200, Object.assign(st, { journal: st.journal.slice(-50) })); }
    if (u.pathname === '/api/bridge/status') return send(res, 200, feeds.mt5.status());
    if (u.pathname === '/api/candles') {
      const sym = u.searchParams.get('symbol'), g = +u.searchParams.get('g') || 60, count = Math.min(10000, +u.searchParams.get('count') || 600), end = u.searchParams.get('end') || 'latest';
      const meta = SYMBOLS.find((x) => x.symbol === sym);
      if (!meta || meta.source !== 'mt5') return send(res, 404, { error: 'unknown MT5 symbol' });
      try { const d = feeds.mt5.data[sym]; if (!d) return send(res, 404, { error: 'no bridge data yet' }); return send(res, 200, await feeds.mt5.candles(sym, g, count, end)); }
      catch (e) { return send(res, 503, { error: e.message }); }
    }
    if (u.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
      res.write(': connected\n\n'); clients.add(res);
      const ka = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); });
      return;
    }
    return send(res, 404, { error: 'not found' });
  }
  // static: terminal + engine
  let file = u.pathname === '/' ? path.join(WEB_DIR, 'index.html') : u.pathname === '/moxie-engine.js' ? ENGINE_FILE : u.pathname === '/royal-robot.js' ? ROBOT_FILE : path.join(WEB_DIR, path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(WEB_DIR) && file !== ENGINE_FILE && file !== ROBOT_FILE) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => err ? send(res, 404, 'not found', 'text/plain') : send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream'));
});
server.listen(PORT, () => { console.log(`Royal Trades server on :${PORT}`); start(); });
process.on('SIGTERM', () => { fs.writeFileSync(SIG_FILE, JSON.stringify(engine.signals.slice(-3000))); process.exit(0); });
