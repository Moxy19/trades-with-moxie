// ============================================================================
//  TradesbySci SMC — Deriv signal engine (Node worker)
//  Connects to Deriv over WebSocket (ws lib), runs EMA 9/21 + Smart Money
//  Concepts (BOS/CHoCH, OB, FVG, liquidity sweep) with a 1H/2H/4H bias stack
//  anchored on the 3am/3pm hourly candle, and writes live BUY/SELL signals
//  into Supabase (live_signals). Also advances status (TP1/TP2/TP3/SL).
//  Run: `node worker.js`  (needs a .env — see .env.example)
// ============================================================================
import "dotenv/config";
import WebSocket from "ws";
import { createClient } from "@supabase/supabase-js";

const APP_ID    = process.env.DERIV_APP_ID || "1089";
const MIN_SCORE = Number(process.env.TBS_MIN_SCORE || "55");
const CROSS_MODE = (process.env.TBS_CROSS_MODE || "1") !== "0"; // signal on every confirmed EMA cross
const POLL_MS   = Number(process.env.POLL_MS || "20000");
const SUPA_URL  = process.env.SUPABASE_URL;
const SVC_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SVC_KEY) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }

const sb = createClient(SUPA_URL, SVC_KEY, { auth: { persistSession: false } });

const SYMBOLS = (process.env.DERIV_SYMBOLS ||
  "BOOM1000:Boom 1000,CRASH500:Crash 500,R_75:Volatility 75,R_100:Volatility 100")
  .split(",").map((s) => { const [code, name] = s.split(":"); return { code, name: name || code }; });

const ENTRY_TFS = [{ g: 60, label: "1m" }, { g: 120, label: "2m" }, { g: 180, label: "3m" }, { g: 300, label: "5m" }];
const HTF_GRANS = [3600, 7200, 14400]; // 1H, 2H, 4H
const W = { wEMA: 30, wHTF: 25, wStruct: 15, wZone: 15, wAlign: 10, wKey: 5 };
const round = (x) => Math.round(x * 1e5) / 1e5;

// ---------- Deriv WS: one socket per cycle, correlate by req_id ----------
function derivFetch(reqs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`,
      { headers: { "User-Agent": "tbs-engine/1.0" } });
    const out = new Map();
    let pending = reqs.length, settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; clearTimeout(to); try { ws.close(); } catch {} fn(arg); };
    const to = setTimeout(() => done(reject, new Error("deriv timeout")), 28000);
    ws.on("open", () => { let k = 0; const pump = () => { if (k < reqs.length) { try { ws.send(JSON.stringify(reqs[k++])); } catch {} setTimeout(pump, 20); } }; pump(); });
    ws.on("message", (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m?.error && m?.req_id == null) { done(reject, new Error("deriv-api: " + (m.error.code || "") + " " + (m.error.message || ""))); return; }
      if (m?.req_id != null) { out.set(m.req_id, m); if (--pending <= 0) done(resolve, out); }
    });
    ws.on("error", (e) => done(reject, new Error("ws-error: " + (e?.message || e))));
    ws.on("close", (c, r) => { if (pending > 0) done(reject, new Error("ws-closed " + c + " " + (r || "") + " pending=" + pending)); });
  });
}
const toCandles = (msg) => (msg?.candles ?? []).map((c) => ({ epoch: +c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close }));

// ---------- indicators ----------
function ema(src, len) { const k = 2 / (len + 1); const out = []; let p = src[0]; for (let i = 0; i < src.length; i++) { p = i === 0 ? src[0] : src[i] * k + p * (1 - k); out.push(p); } return out; }
function atr(h, l, c, len) {
  const tr = []; for (let i = 0; i < h.length; i++) tr.push(i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  const out = []; let prev = 0;
  for (let i = 0; i < tr.length; i++) { if (i < len) { prev += tr[i]; out.push(prev / (i + 1)); if (i === len - 1) prev = prev / len; } else { prev = (prev * (len - 1) + tr[i]) / len; out.push(prev); } }
  return out;
}
const isPivotHigh = (h, i, n) => { if (i - n < 0 || i + n >= h.length) return false; for (let j = i - n; j <= i + n; j++) if (j !== i && h[j] >= h[i]) return false; return true; };
const isPivotLow  = (l, i, n) => { if (i - n < 0 || i + n >= l.length) return false; for (let j = i - n; j <= i + n; j++) if (j !== i && l[j] <= l[i]) return false; return true; };
function htfDir(c) { if (c.length < 25) return 0; const cl = c.map((x) => x.close); const ef = ema(cl, 9), es = ema(cl, 21); const i = cl.length - 1; return ef[i] > es[i] ? 1 : ef[i] < es[i] ? -1 : 0; }

// ---------- SMC evaluation (lines take precedent; SMC scores confluence) ----------
function evaluate(cndl, htf1, align, hourBias, keyHour, allowLong, allowShort) {
  const SWING = 5, OBLOOK = 20, EXPIRY = 60, n = cndl.length;
  if (n < 60) return null;
  const o = cndl.map((x) => x.open), h = cndl.map((x) => x.high), l = cndl.map((x) => x.low), c = cndl.map((x) => x.close);
  const ef = ema(c, 9), es = ema(c, 21), at = atr(h, l, c, 14);
  let lastPH = NaN, lastPL = NaN, structure = 0;
  let bosUp = false, chochUp = false, bosDn = false, chochDn = false;
  let bullOBtop = NaN, bullOBbot = NaN, bullOBbar = -1, bearOBtop = NaN, bearOBbot = NaN, bearOBbar = -1;
  let bFVGtop = NaN, bFVGbot = NaN, bFVGbar = -1, sFVGtop = NaN, sFVGbot = NaN, sFVGbar = -1;
  const EVAL = n - 2;
  for (let i = 1; i <= EVAL; i++) {
    const p = i - SWING;
    if (p >= 0) { if (isPivotHigh(h, p, SWING)) lastPH = h[p]; if (isPivotLow(l, p, SWING)) lastPL = l[p]; }
    bosUp = chochUp = bosDn = chochDn = false;
    const brokeHigh = !isNaN(lastPH) && c[i] > lastPH && c[i - 1] <= lastPH;
    const brokeLow  = !isNaN(lastPL) && c[i] < lastPL && c[i - 1] >= lastPL;
    if (brokeHigh) { if (structure <= 0) chochUp = true; else bosUp = true; structure = 1; }
    if (brokeLow)  { if (structure >= 0) chochDn = true; else bosDn = true; structure = -1; }
    if (chochUp || bosUp) for (let k = 1; k <= OBLOOK && i - k >= 0; k++) if (c[i - k] < o[i - k]) { bullOBtop = h[i - k]; bullOBbot = l[i - k]; bullOBbar = i; break; }
    if (chochDn || bosDn) for (let k = 1; k <= OBLOOK && i - k >= 0; k++) if (c[i - k] > o[i - k]) { bearOBtop = h[i - k]; bearOBbot = l[i - k]; bearOBbar = i; break; }
    if (i >= 2 && l[i] > h[i - 2]) { bFVGtop = l[i]; bFVGbot = h[i - 2]; bFVGbar = i; }
    if (i >= 2 && h[i] < l[i - 2]) { sFVGtop = l[i - 2]; sFVGbot = h[i]; sFVGbar = i; }
  }
  const i = EVAL;
  const emaBull = ef[i] > es[i], emaBear = ef[i] < es[i];
  const emaCrossUp = ef[i] > es[i] && ef[i - 1] <= es[i - 1];
  const emaCrossDn = ef[i] < es[i] && ef[i - 1] >= es[i - 1];
  const sweepLow  = !isNaN(lastPL) && l[i] < lastPL && c[i] > lastPL;
  const sweepHigh = !isNaN(lastPH) && h[i] > lastPH && c[i] < lastPH;
  const inBullOB  = !isNaN(bullOBbot) && (i - bullOBbar <= EXPIRY) && l[i] <= bullOBtop && c[i] >= bullOBbot;
  const inBearOB  = !isNaN(bearOBtop) && (i - bearOBbar <= EXPIRY) && h[i] >= bearOBbot && c[i] <= bearOBtop;
  const inBullFVG = !isNaN(bFVGbot)  && (i - bFVGbar  <= EXPIRY) && l[i] <= bFVGtop && c[i] >= bFVGbot;
  const inBearFVG = !isNaN(sFVGtop)  && (i - sFVGbar  <= EXPIRY) && h[i] >= sFVGbot && c[i] <= sFVGtop;
  const bullZone = sweepLow || inBullOB || inBullFVG, bearZone = sweepHigh || inBearOB || inBearFVG;
  const structShiftUp = bosUp || chochUp, structShiftDn = bosDn || chochDn;
  const htfBull = htf1 === 1, htfBear = htf1 === -1;
  const lineTrigUp = emaCrossUp || (emaBull && l[i] <= ef[i] && c[i] > ef[i]); // cross or bounce off the lines
  const lineTrigDn = emaCrossDn || (emaBear && h[i] >= ef[i] && c[i] < ef[i]); // cross or reject at the lines
  const hourOkLong = hourBias >= 0, hourOkShort = hourBias <= 0;
  const scoreLong = (htfBull ? W.wHTF : 0) + (align && htfBull ? W.wAlign : 0) + (structShiftUp ? W.wStruct : 0) + (bullZone ? W.wZone : 0) + ((emaBull || emaCrossUp) ? W.wEMA : 0) + (keyHour && hourBias >= 0 ? W.wKey : 0);
  const scoreShort = (htfBear ? W.wHTF : 0) + (align && htfBear ? W.wAlign : 0) + (structShiftDn ? W.wStruct : 0) + (bearZone ? W.wZone : 0) + ((emaBear || emaCrossDn) ? W.wEMA : 0) + (keyHour && hourBias <= 0 ? W.wKey : 0);
  // crossMode: the confirmed EMA cross IS the signal (lines take precedent), on this closed bar.
  // gated mode: require HTF + hour + line trigger + score confluence.
  const longSetup  = allowLong  && (CROSS_MODE ? emaCrossUp : (htfBull && hourOkLong  && lineTrigUp && scoreLong  >= MIN_SCORE));
  const shortSetup = allowShort && (CROSS_MODE ? emaCrossDn : (htfBear && hourOkShort && lineTrigDn && scoreShort >= MIN_SCORE));
  if (!longSetup && !shortSetup) return null;
  const e = c[i];
  if (longSetup) {
    let slRef = Math.min(isNaN(lastPL) ? l[i] : lastPL, l[i]); if (!isNaN(bullOBbot)) slRef = Math.min(slRef, bullOBbot);
    const sl = slRef - at[i] * 0.5, R = e - sl; if (R <= 0) return null;
    const ctx = sweepLow ? "sweep" : inBullOB ? "OB" : inBullFVG ? "FVG" : "-";
    return { action: "BUY", entry: e, sl, tp1: e + R, tp2: e + 2 * R, tp3: e + 3 * R, score: scoreLong, struct: chochUp ? "CHoCH" : "BOS", ctx, bar: cndl[i].epoch };
  }
  let slRef = Math.max(isNaN(lastPH) ? h[i] : lastPH, h[i]); if (!isNaN(bearOBtop)) slRef = Math.max(slRef, bearOBtop);
  const sl = slRef + at[i] * 0.5, R = sl - e; if (R <= 0) return null;
  const ctx = sweepHigh ? "sweep" : inBearOB ? "OB" : inBearFVG ? "FVG" : "-";
  return { action: "SELL", entry: e, sl, tp1: e - R, tp2: e - 2 * R, tp3: e - 3 * R, score: scoreShort, struct: chochDn ? "CHoCH" : "BOS", ctx, bar: cndl[i].epoch };
}

// ---------- one cycle ----------
async function cycle() {
  const reqs = []; let id = 0; const idx = {};
  for (const s of SYMBOLS) {
    for (const tf of ENTRY_TFS) { idx[`${s.code}:${tf.g}`] = ++id; reqs.push({ ticks_history: s.code, style: "candles", granularity: tf.g, count: 320, end: "latest", req_id: id }); }
    for (const g of HTF_GRANS) { idx[`${s.code}:${g}`] = ++id; reqs.push({ ticks_history: s.code, style: "candles", granularity: g, count: 80, end: "latest", req_id: id }); }
  }
  let res;
  try { res = await derivFetch(reqs); } catch (e) { console.error(new Date().toISOString(), "deriv:", String(e)); return; }

  const rows = []; const latest1m = {};
  for (const s of SYMBOLS) {
    const h1c = toCandles(res.get(idx[`${s.code}:3600`]));
    const d1 = htfDir(h1c), d2 = htfDir(toCandles(res.get(idx[`${s.code}:7200`]))), d3 = htfDir(toCandles(res.get(idx[`${s.code}:14400`])));
    const align = d1 !== 0 && d1 === d2 && d2 === d3;
    const lastH1 = h1c[h1c.length - 1];
    const hourBias = lastH1 ? (lastH1.close > lastH1.open ? 1 : lastH1.close < lastH1.open ? -1 : 0) : 0;
    for (const tf of ENTRY_TFS) {
      const cndl = toCandles(res.get(idx[`${s.code}:${tf.g}`]));
      if (tf.g === 60) latest1m[s.name] = cndl.slice(-6);
      const evalEpoch = cndl.length >= 2 ? cndl[cndl.length - 2].epoch : 0;
      const sastHour = evalEpoch ? (new Date(evalEpoch * 1000).getUTCHours() + 2) % 24 : -1;
      const keyHour = sastHour === 3 || sastHour === 15;
      const code = s.code.toLowerCase();
      const allowLong = !code.includes("crash");  // Crash = short-only
      const allowShort = !code.includes("boom");   // Boom = long-only
      const sig = evaluate(cndl, d1, align, hourBias, keyHour, allowLong, allowShort);
      if (!sig) continue;
      rows.push({ pair: s.name, action: sig.action, timeframe: tf.label, entry: round(sig.entry), sl: round(sig.sl),
        tp1: round(sig.tp1), tp2: round(sig.tp2), tp3: round(sig.tp3), score: sig.score, status: "LIVE", market: "synthetic",
        bar_time: new Date(sig.bar * 1000).toISOString(), signal_at: new Date().toISOString() });
    }
  }

  let inserted = 0;
  if (rows.length) {
    const { data, error } = await sb.from("live_signals").upsert(rows, { onConflict: "pair,timeframe,bar_time,action", ignoreDuplicates: true }).select("id");
    if (error) console.error("insert:", error.message); else inserted = data.length;
  }

  let advanced = 0;
  const { data: open } = await sb.from("live_signals").select("id,pair,action,entry,sl,tp1,tp2,tp3,status").in("status", ["LIVE", "TP1", "TP2"]);
  if (open) for (const r of open) {
    const cs = latest1m[r.pair]; if (!cs || !cs.length) continue;
    const hi = Math.max(...cs.map((x) => x.high)), lo = Math.min(...cs.map((x) => x.low));
    let next = r.status; const pre = r.status === "LIVE"; // only a pre-TP1 trade can stop out as a loss
    if (r.action === "BUY") {
      if (r.tp3 && hi >= r.tp3) next = "TP3";
      else if (r.tp2 && hi >= r.tp2) next = "TP2";
      else if (pre && r.tp1 && hi >= r.tp1) next = "TP1";
      else if (pre && lo <= r.sl) next = "SL";                       // loss
      else if (!pre && r.entry && lo <= r.entry) next = "TP1_BE";    // after TP1 the stop is break-even = win
    } else {
      if (r.tp3 && lo <= r.tp3) next = "TP3";
      else if (r.tp2 && lo <= r.tp2) next = "TP2";
      else if (pre && r.tp1 && lo <= r.tp1) next = "TP1";
      else if (pre && hi >= r.sl) next = "SL";
      else if (!pre && r.entry && hi >= r.entry) next = "TP1_BE";
    }
    if (next !== r.status) { await sb.from("live_signals").update({ status: next }).eq("id", r.id); advanced++; }
  }
  console.log(new Date().toISOString(), `candidates=${rows.length} inserted=${inserted} advanced=${advanced} symbols=${SYMBOLS.length}`);
}

const RUN_ONCE = (process.env.RUN_ONCE || "0") === "1";
const RUN_SECONDS = Number(process.env.RUN_SECONDS || "0"); // >0: loop this long then exit (for GitHub Actions)

console.log("TradesbySci engine starting —", SYMBOLS.map((s) => s.name).join(", "),
  `| poll ${POLL_MS}ms | minScore ${MIN_SCORE} | crossMode ${CROSS_MODE} | ${RUN_ONCE ? "once" : RUN_SECONDS ? RUN_SECONDS + "s" : "forever"}`);
await cycle();
if (RUN_ONCE) process.exit(0);
const timer = setInterval(cycle, POLL_MS);
if (RUN_SECONDS > 0) setTimeout(() => { clearInterval(timer); process.exit(0); }, RUN_SECONDS * 1000);
