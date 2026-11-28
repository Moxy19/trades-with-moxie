// In-browser simulator of the ORB+ v4 chart-timeframe engine (trend turn, BOS restart, early reversal, pullbacks, spikes)
window.__sim = function (bars, P) {
  P = Object.assign({ tlLen: 21, fastLen: 9, pivLen: 2, bodyMult: 2, bodyLen: 20, atrLen: 14, atrMult: 1.5, pbMin: 30, pbMax: 60, maxAdds: 5, early: true, earlyBody: 0.6, earlyLook: 3, tz: 2 }, P || {});
  const n = bars.length, O = [], H = [], L = [], C = [], T = [];
  bars.forEach(b => { T.push(b[0]); O.push(b[1]); H.push(b[2]); L.push(b[3]); C.push(b[4]); });
  const ema = (src, len) => { const k = 2 / (len + 1); const r = []; let p = null; src.forEach((x, i) => { p = p === null ? x : p + k * (x - p); r.push(p); }); return r; };
  const tl = ema(C, P.tlLen), eF = ema(C, 9), eS = ema(C, 21);
  const tr = H.map((h, i) => i ? Math.max(h - L[i], Math.abs(h - C[i - 1]), Math.abs(L[i] - C[i - 1])) : h - L[i]);
  const atr = []; { let p = null; tr.forEach((x, i) => { p = p === null ? x : (p * (P.atrLen - 1) + x) / P.atrLen; atr.push(p); }); }
  const body = O.map((o, i) => Math.abs(C[i] - o));
  const fmt = t => new Date((t + P.tz * 3600) * 1000).toISOString().slice(5, 16).replace('T', ' ');
  let lineDir = 0, sh1 = null, sh2 = null, sl1 = null, sl2 = null, trend = 0, legN = 0, impHi = null, impLo = null, needLvl = null, pbArmed = false, pbExt = null, brk = null;
  const sig = []; let prevLineDir = 0, prevSpkU = false, prevSpkD = false;
  for (let i = 0; i < n; i++) {
    const slope = i ? tl[i] - tl[i - 1] : 0;
    prevLineDir = lineDir; lineDir = slope > 0 ? 1 : slope < 0 ? -1 : lineDir;
    const turnUp = lineDir === 1 && prevLineDir === -1, turnDn = lineDir === -1 && prevLineDir === 1;
    const pl = P.pivLen, j = i - pl;
    if (j - pl >= 0) {
      let isH = true, isL = true;
      for (let k = j - pl; k <= j + pl; k++) { if (k === j) continue; if (H[k] >= H[j]) isH = false; if (L[k] <= L[j]) isL = false; }
      if (isH) { sh2 = sh1; sh1 = H[j]; } if (isL) { sl2 = sl1; sl1 = L[j]; }
    }
    let avgB = 0; if (i >= P.bodyLen) { for (let k = i - P.bodyLen; k < i; k++) avgB += body[k]; avgB /= P.bodyLen; } else avgB = Infinity;
    const rng = H[i] - L[i];
    const big = body[i] >= P.bodyMult * avgB || (i && rng >= P.atrMult * atr[i - 1] && body[i] >= 0.5 * rng);
    const spU = big && C[i] > O[i], spD = big && C[i] < O[i];
    const spk = spU && !prevSpkU ? 1 : spD && !prevSpkD ? -1 : 0; prevSpkU = spU; prevSpkD = spD;
    let lo5 = Infinity, hi5 = -Infinity; for (let k = Math.max(0, i - 2 * pl); k <= i; k++) { lo5 = Math.min(lo5, L[k]); hi5 = Math.max(hi5, H[k]); }
    // early reversal: strong opposite candle from a fresh extreme that engulfs the previous body
    let hiN = -Infinity, loN = Infinity; for (let k = Math.max(0, i - P.earlyLook); k < i; k++) { hiN = Math.max(hiN, H[k]); loN = Math.min(loN, L[k]); }
    const earlyDn = P.early && trend === 1 && i > 0 && C[i] < O[i] && body[i] >= P.earlyBody * atr[i - 1] && C[i] < Math.min(O[i - 1], C[i - 1]) && Math.max(H[i], H[i - 1]) >= hiN;
    const earlyUp = P.early && trend === -1 && i > 0 && C[i] > O[i] && body[i] >= P.earlyBody * atr[i - 1] && C[i] > Math.max(O[i - 1], C[i - 1]) && Math.min(L[i], L[i - 1]) <= loN;
    let ev = null;
    let sBuy = turnUp || earlyUp, sSell = turnDn || earlyDn;
    if (!sBuy && !sSell && trend !== 1 && lineDir === 1 && sh1 !== null && C[i] > sh1 && C[i - 1] <= sh1) sBuy = true;
    if (!sBuy && !sSell && trend !== -1 && lineDir === -1 && sl1 !== null && C[i] < sl1 && C[i - 1] >= sl1) sSell = true;
    if (sBuy && trend !== 1) { trend = 1; legN = 1; impHi = H[i]; impLo = lo5; needLvl = null; pbArmed = false; brk = sh1; ev = 'BUY START' + (earlyUp && !turnUp ? '(early)' : ''); }
    else if (sSell && trend !== -1) { trend = -1; legN = 1; impLo = L[i]; impHi = hi5; needLvl = null; pbArmed = false; brk = sl1; ev = 'SELL START' + (earlyDn && !turnDn ? '(early)' : ''); }
    else if (trend === 1) {
      if (sl1 !== null && C[i] < sl1 && sl1 < impHi) { trend = 0; pbArmed = false; ev = 'INVALID'; }
      else {
        if (H[i] > impHi) impHi = H[i];
        const ok = needLvl === null || impHi > needLvl, r = impHi - impLo, retr = r > 0 ? 100 * (impHi - L[i]) / r : 0;
        const tE = (L[i] <= eF[i] || L[i] <= eS[i]) && C[i] > eS[i] - atr[i], rt = brk !== null && L[i] <= brk + 0.2 * atr[i] && C[i] >= brk - 0.2 * atr[i];
        if (!pbArmed && ok && ((retr >= P.pbMin && retr <= P.pbMax) || tE || rt)) { pbArmed = true; pbExt = L[i]; }
        if (pbArmed) { pbExt = Math.min(pbExt, L[i]); if ((C[i] > O[i] && C[i] > C[i - 1]) || (C[i] > O[i] && C[i] > H[i - 1])) { legN++; ev = 'RE-BUY ' + legN; needLvl = impHi; impLo = pbExt; pbArmed = false; } }
      }
    } else if (trend === -1) {
      if (sh1 !== null && C[i] > sh1 && sh1 > impLo) { trend = 0; pbArmed = false; ev = 'INVALID'; }
      else {
        if (L[i] < impLo) impLo = L[i];
        const ok = needLvl === null || impLo < needLvl, r = impHi - impLo, retr = r > 0 ? 100 * (H[i] - impLo) / r : 0;
        const tE = (H[i] >= eF[i] || H[i] >= eS[i]) && C[i] < eS[i] + atr[i], rt = brk !== null && H[i] >= brk - 0.2 * atr[i] && C[i] <= brk + 0.2 * atr[i];
        if (!pbArmed && ok && ((retr >= P.pbMin && retr <= P.pbMax) || tE || rt)) { pbArmed = true; pbExt = H[i]; }
        if (pbArmed) { pbExt = Math.max(pbExt, H[i]); if ((C[i] < O[i] && C[i] < C[i - 1]) || (C[i] < O[i] && C[i] < L[i - 1])) { legN++; ev = 'RE-SELL ' + legN; needLvl = impLo; impHi = pbExt; pbArmed = false; } }
      }
    }
    if (ev || spk) sig.push({ i, t: fmt(T[i]), ev: (ev || '') + (spk ? ' SPK' + (spk > 0 ? '+' : '-') : ''), c: C[i], legN });
  }
  return sig;
};
