#!/usr/bin/env node
/*
 * Royal Trades always-on phone alerts.
 * Runs every live version's engine side by side on Deriv's public feed and pushes each new
 * synthetics signal to ntfy, starting with the version it came from: "[v1.16] BUY Boom 1000 A+".
 * Meant for GitHub Actions (.github/workflows/alerts.yml), but runs anywhere with Node 22:
 *   NTFY_TOPIC=your-topic node server/alerts.js
 * Env: NTFY_TOPIC (required), RUN_MINUTES (stop after this long; 0 = forever), MARKETS ('syn' default | 'all').
 */
'use strict';
const path = require('path');
const root = path.join(__dirname, '..');

const TOPIC = (process.env.NTFY_TOPIC || '').trim();
const RUN_MIN = +(process.env.RUN_MINUTES || 0);
const ALL = process.env.MARKETS === 'all';
if (!TOPIC) { console.error('NTFY_TOPIC is not set'); process.exit(1); }

// Same settings each page uses on a fresh browser (see the page's applyMgmt / cfgVer steps).
const VERSIONS = [
  { label: 'v1.4.3', file: 'engine/moxie-engine.js', mgmt: null },
  { label: 'v1.11.1', file: 'server/engines/v1.11.1.js', mgmt: 'quality' },
  { label: 'v1.14.1', file: 'server/engines/v1.14.1.js', mgmt: 'volume' },
  { label: 'v1.15.1', file: 'v115/moxie-engine.js', mgmt: 'volume', extra: { softStop: null } },
  { label: 'v1.16', file: 'v116/moxie-engine.js', mgmt: 'volume', extra: { softStop: null } },
  { label: 'Sci', file: 'sci/moxie-engine.js', mgmt: null, name: 'TradesbySci' }, // Past Floor Retest test version
  { label: 'Sci2', file: 'sci2/moxie-engine.js', mgmt: null, name: 'TradesbySci v2' }, // KPOI + exhaustion (Master Rulebook)
];

function cfgFor(M, v) {
  const c = Object.assign({}, M.DEFAULTS);
  delete c.signalsEnabledFrom;
  const m = v.mgmt && M.MANAGEMENT && (M.MANAGEMENT[v.mgmt] || M.MANAGEMENT.quality);
  if (m) Object.assign(c, { minOrAtr: m.minOrAtr, maxOrAtr: m.maxOrAtr, hours: m.hours ? Object.assign({}, m.hours) : null, beAtR: m.beAtR, beLockR: m.beLockR, tp1Lock: m.tp1Lock,
    softStop: m.softStop ? Object.assign({}, m.softStop) : null, dyn: m.dyn ? Object.assign({}, m.dyn) : null, trail: Object.assign({}, m.trail) });
  return Object.assign(c, v.extra || {});
}

let sent = 0;
async function push(title, body, tags) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch('https://ntfy.sh/' + encodeURIComponent(TOPIC), { method: 'POST', body, headers: { Title: title.replace(/[^\x20-\x7e]/g, ''), Tags: tags, Priority: '4' } });
      if (r.ok) { sent++; return true; }
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  console.log('ntfy push failed:', title);
  return false;
}

async function main() {
  const started = Date.now();
  for (const v of VERSIONS) {
    const M = require(path.join(root, v.file));
    const symbols = M.DEFAULT_SYMBOLS.filter((s) => ALL || (s.market || 'synthetic') === 'synthetic');
    const engine = new M.Engine(cfgFor(M, v), {
      onSignal(sig) {
        if (!ALL && (sig.market || 'synthetic') !== 'synthetic') return;
        const d = sig.dec, f = (x) => M.fmt(x, d);
        const title = `[${v.label}] ${sig.dir} ${sig.name} ${sig.grade}`;
        const body = `Version: ${v.name || 'Royal Trades ' + v.label}\nEntry ${f(sig.entry)}  SL ${f(sig.sl)}  TP1 ${f(sig.tp1)}${sig.tp2 ? '  TP2 ' + f(sig.tp2) : ''}` +
          (sig.size > 0 && sig.size < 1 ? '\nHalf size (weaker pair)' : '') + (sig.unproven ? '\nRoyalty (no proven edge yet)' : '') + '\nEducational, not financial advice.';
        console.log(new Date().toISOString(), title, '|', body.split('\n')[1]);
        push(title, body, sig.dir === 'BUY' ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend');
      },
    });
    const feed = new M.DerivFeed({ onStatus: (s) => console.log(v.label, 'feed:', s) });
    try { await feed.connect(); } catch (e) { console.log(v.label, 'connect failed, will retry:', e.message); }
    let ready = 0;
    M.startLive(engine, { deriv: feed }, symbols, {
      concurrency: 2, log: (m) => { if (!/^ready /.test(m)) console.log(v.label, m); },
      onReady: () => { if (++ready === symbols.length) console.log(v.label, `scanning ${ready} markets`); },
    }).catch((e) => console.log(v.label, 'start failed:', e.message));
    await new Promise((r) => setTimeout(r, 5000)); // stagger the versions so the feed is not hammered
  }
  if (RUN_MIN > 0) setTimeout(() => { console.log(`stopping after ${RUN_MIN} min, ${sent} alerts sent`); process.exit(0); }, RUN_MIN * 60000);
  setInterval(() => console.log(new Date().toISOString(), `alive, ${sent} alerts sent, up ${Math.round((Date.now() - started) / 60000)} min`), 30 * 60000);
}
main().catch((e) => { console.error(e); process.exit(1); });
