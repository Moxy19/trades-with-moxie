/* Trades with Moxie — Pro v2 pair-aware quality gate.
 * This module filters v1 candidates; it does NOT claim a win probability.
 * Pair profiles are starting hypotheses and must be validated per broker/feed.
 */
'use strict';
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const PROFILES={
  gold:{minScore:82,minRoomR:1.35,minAtrRatio:0.45,maxAtrRatio:2.2,allowCounterTrend:false,cooldownBars:8},
  forex:{minScore:80,minRoomR:1.25,minAtrRatio:0.35,maxAtrRatio:2.5,allowCounterTrend:false,cooldownBars:6},
  synthetic_trend:{minScore:84,minRoomR:1.4,minAtrRatio:0.5,maxAtrRatio:2.4,allowCounterTrend:false,cooldownBars:10},
  synthetic_jump:{minScore:86,minRoomR:1.5,minAtrRatio:0.55,maxAtrRatio:2.0,allowCounterTrend:false,cooldownBars:12},
  crypto:{minScore:84,minRoomR:1.4,minAtrRatio:0.5,maxAtrRatio:2.3,allowCounterTrend:false,cooldownBars:10},
  default:{minScore:84,minRoomR:1.35,minAtrRatio:0.4,maxAtrRatio:2.3,allowCounterTrend:false,cooldownBars:8}
};
function classify(sig){
 const s=(sig.symbol+' '+sig.name).toLowerCase();
 if(/xau|gold/.test(s)) return 'gold';
 if(/boom|crash|jump|painx|gainx/.test(s)) return 'synthetic_jump';
 if(/volatility|vol-|flipx|fibox|quadx|plusx|step|stprng|sfx/.test(s)) return 'synthetic_trend';
 if(/btc|eth|crypto/.test(s)) return 'crypto';
 if(sig.market==='forex'||/^frx/.test(s)||/eur|gbp|usd|jpy|aud|cad|chf|nzd/.test(s)) return 'forex';
 return 'default';
}
class ProV2Gate{
 constructor(opts={}){this.profiles={...PROFILES,...(opts.profiles||{})};this.minSamples=opts.minSamples||30;this.stats=new Map();this.lastSignal=new Map();this.enabled=opts.enabled!==false;}
 _stat(sym){if(!this.stats.has(sym))this.stats.set(sym,{n:0,w:0,loss:0,sumR:0,lossStreak:0});return this.stats.get(sym);}
 assess(sig,st){
  if(!this.enabled)return {accept:true,meta:{gate:'disabled'}};
  const key=classify(sig),p=this.profiles[key]||this.profiles.default;
  if(sig.score<p.minScore)return {accept:false,reason:`${key} score ${sig.score} below ${p.minScore}`};
  if(sig.kind==='SCALP'&&!p.allowCounterTrend)return {accept:false,reason:`${key} profile blocks counter-trend scalps pending validation`};
  const room=(sig.v2Context&&sig.v2Context.roomR)||null;
  if(room!=null&&room<p.minRoomR)return {accept:false,reason:`room ${room.toFixed(2)}R below ${p.minRoomR}R`};
  const stat=this._stat(sig.symbol);
  if(stat.n>=this.minSamples&&stat.lossStreak>=3)return {accept:false,reason:'pair paused after 3 consecutive losses; review regime and recent sample'};
  const prev=this.lastSignal.get(sig.symbol);
  if(prev&&sig.createdAt-prev<p.cooldownBars*120)return {accept:false,reason:`pair cooldown (${p.cooldownBars} x 2m bars)`};
  this.lastSignal.set(sig.symbol,sig.createdAt);
  return {accept:true,meta:{profile:key,profileMinScore:p.minScore,gate:'Moxie Pro v2',sampleTrades:stat.n,warning:'score is confluence, not win probability'}};
 }
 record(sig){
  if(!sig||sig.result==null||!['TP2_HIT','BE_HIT','SL_HIT','TIME_EXIT'].includes(sig.status))return;
  const x=this._stat(sig.symbol);x.n++;x.sumR+=sig.result;if(sig.result>0){x.w++;x.lossStreak=0;}else if(sig.result<0){x.loss++;x.lossStreak++;}
 }
 report(){const out={};for(const [s,x] of this.stats)out[s]={...x,winRate:x.n?x.w/x.n:null,expectancyR:x.n?x.sumR/x.n:null};return out;}
}
module.exports={ProV2Gate,PROFILES,classify};
