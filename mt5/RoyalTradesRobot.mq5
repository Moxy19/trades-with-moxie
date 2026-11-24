//+------------------------------------------------------------------+
//|  RoyalTradesRobot.mq5                                            |
//|  Places Royal Trades signals on your MT5 account automatically   |
//|  (Deriv MT5, Weltrade or any broker), with lot sizes.            |
//|                                                                  |
//|  Educational software, not financial advice. Automated trading   |
//|  can lose money fast. Run it on a DEMO account first.            |
//|                                                                  |
//|  How it works: every few seconds it reads the signal feed of     |
//|  your Royal Trades server (/api/robot/feed). New ACTIVE signals  |
//|  are opened at market with the signal's stop and targets,       |
//|  measured from your broker's price. It mirrors the engine: at    |
//|  TP1 one leg closes, the stop of the rest follows the engine's   |
//|  stop, and everything closes when the engine closes the trade.   |
//|                                                                  |
//|  Setup:                                                          |
//|  1. Run the Royal Trades server (server/server.js).              |
//|  2. MT5: Tools > Options > Expert Advisors > "Allow WebRequest   |
//|     for listed URL", add your server address.                    |
//|  3. Attach this EA to ONE chart, tick "Allow Algo Trading".      |
//|  4. Check SymbolMap matches your broker's symbol names.          |
//+------------------------------------------------------------------+
#property copyright "Royal Trades"
#property version   "1.00"
#property strict
#include <Trade\Trade.mqh>

enum LotModeT { LOT_FIXED = 0, LOT_RISK_PERCENT = 1 };
enum DirT { DIR_BOTH = 0, DIR_BUY = 1, DIR_SELL = 2 };

input string   ServerURL        = "http://127.0.0.1:8080";   // Royal Trades server (no trailing slash)
input string   AccessKey        = "";                         // ACCESS_KEY of the server, if it uses one
input LotModeT LotMode          = LOT_RISK_PERCENT;           // Fixed lot, or lot from % risk
input double   FixedLot         = 0.01;                       // Lot per trade (Fixed lot mode)
input double   RiskPercent      = 1.0;                        // % of balance lost if the stop is hit (whole signal)
input double   MaxRiskPercent   = 3.0;                        // Skip when the broker's minimum lot would risk more than this %
input int      TradesPerSignal  = 2;                          // 1 = one position; 2 = half closes at TP1, half runs (max 3)
input DirT     Direction        = DIR_BOTH;                   // Buy, Sell or both
input string   Grades           = "A+,A";                     // Grades to trade
input bool     SkipRoyalty      = true;                       // Skip markets with no proven edge
input string   Markets          = "synthetic,forex,crypto";   // Market groups to trade
input int      MaxOpenSignals   = 2;                          // Max signals open at once
input int      MaxSignalsPerDay = 8;                          // Max new signals a day
input double   MaxDailyLossPct  = 6.0;                        // Stop for the day at this % loss (closed trades)
input int      MaxSignalAgeSec  = 180;                        // Skip signals older than this
input double   MaxSlipR         = 0.3;                        // Skip if price already ran this many R past entry
input int      PollSeconds      = 3;
input long     Magic            = 7700119;
input string   SymbolMap        = "stpRNG=Step Index;R_25=Volatility 25 Index;R_50=Volatility 50 Index;R_75=Volatility 75 Index;R_100=Volatility 100 Index;1HZ25V=Volatility 25 (1s) Index;1HZ75V=Volatility 75 (1s) Index;BOOM1000=Boom 1000 Index;CRASH1000=Crash 1000 Index;frxXAUUSD=XAUUSD;frxXAGUSD=XAGUSD;frxEURUSD=EURUSD;frxGBPUSD=GBPUSD;frxUSDJPY=USDJPY;frxAUDUSD=AUDUSD;frxUSDCAD=USDCAD;frxUSDCHF=USDCHF;frxNZDUSD=NZDUSD;frxGBPJPY=GBPJPY;frxEURJPY=EURJPY;frxEURGBP=EURGBP;cryBTCUSD=BTCUSD;cryETHUSD=ETHUSD";
input string   SymbolSuffix     = "";                          // e.g. ".m" if your broker adds one

CTrade trade;
string g_done[];          // signal ids already handled (opened or skipped)
string g_mapFrom[], g_mapTo[];
double g_dayStartBal = 0; int g_dayKey = 0; int g_dayCount = 0; bool g_halted = false;

//+------------------------------------------------------------------+
int OnInit()
  {
   string pairs[]; int n = StringSplit(SymbolMap, ';', pairs);
   ArrayResize(g_mapFrom, n); ArrayResize(g_mapTo, n);
   for(int i = 0; i < n; i++)
     {
      string kv[]; if(StringSplit(pairs[i], '=', kv) == 2) { g_mapFrom[i] = Trim(kv[0]); g_mapTo[i] = Trim(kv[1]); }
     }
   trade.SetExpertMagicNumber(Magic);
   trade.SetDeviationInPoints(50);
   NewDay();
   EventSetTimer(MathMax(1, PollSeconds));
   Print("Royal Trades robot started. Account ", AccountInfoInteger(ACCOUNT_LOGIN), (AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_DEMO ? " (demo)" : " (REAL)"), ". Educational, not financial advice.");
   return(INIT_SUCCEEDED);
  }
void OnDeinit(const int reason) { EventKillTimer(); }

string Trim(string s) { StringTrimLeft(s); StringTrimRight(s); return s; }
bool InList(const string csv, const string v) { string a[]; int n = StringSplit(csv, ',', a); for(int i = 0; i < n; i++) if(Trim(a[i]) == v) return true; return false; }
bool Done(const string id) { for(int i = 0; i < ArraySize(g_done); i++) if(g_done[i] == id) return true; return false; }
void MarkDone(const string id) { int n = ArraySize(g_done); if(n > 500) { ArrayRemove(g_done, 0, 100); n = ArraySize(g_done); } ArrayResize(g_done, n + 1); g_done[n] = id; }

string MapSymbol(const string sym, const string source)
  {
   if(source == "mt5") return sym + SymbolSuffix;
   for(int i = 0; i < ArraySize(g_mapFrom); i++) if(g_mapFrom[i] == sym) return g_mapTo[i] + SymbolSuffix;
   return "";
  }

int SastDay() { return (int)((TimeGMT() + 2 * 3600) / 86400); }
void NewDay()
  {
   int k = SastDay(); if(k == g_dayKey) return;
   g_dayKey = k; g_dayCount = 0; g_halted = false; g_dayStartBal = AccountInfoDouble(ACCOUNT_BALANCE);
  }
double ClosedPnlToday()
  {
   datetime from = (datetime)((long)g_dayKey * 86400 - 2 * 3600) + (TimeTradeServer() - TimeGMT());
   if(!HistorySelect(from, TimeTradeServer() + 60)) return 0;
   double s = 0;
   for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
     {
      ulong d = HistoryDealGetTicket(i); if(d == 0) continue;
      if(HistoryDealGetInteger(d, DEAL_MAGIC) != Magic) continue;
      s += HistoryDealGetDouble(d, DEAL_PROFIT) + HistoryDealGetDouble(d, DEAL_COMMISSION) + HistoryDealGetDouble(d, DEAL_SWAP);
     }
   return s;
  }

// positions of this robot for one signal id (comment "RT:<id>:<leg>")
int SignalPositions(const string id, ulong &tickets[])
  {
   ArrayResize(tickets, 0);
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i); if(t == 0) continue;
      if(PositionGetInteger(POSITION_MAGIC) != Magic) continue;
      string c = PositionGetString(POSITION_COMMENT);
      if(StringFind(c, "RT:" + id + ":") == 0) { int n = ArraySize(tickets); ArrayResize(tickets, n + 1); tickets[n] = t; }
     }
   return ArraySize(tickets);
  }
int OpenSignalCount()
  {
   string seen = "|"; int n = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i); if(t == 0 || PositionGetInteger(POSITION_MAGIC) != Magic) continue;
      string c = PositionGetString(POSITION_COMMENT); string p[]; if(StringSplit(c, ':', p) < 2) continue;
      if(StringFind(seen, "|" + p[1] + "|") < 0) { seen += p[1] + "|"; n++; }
     }
   return n;
  }

double NormLot(const string s, double lot)
  {
   double mn = SymbolInfoDouble(s, SYMBOL_VOLUME_MIN), mx = SymbolInfoDouble(s, SYMBOL_VOLUME_MAX), st = SymbolInfoDouble(s, SYMBOL_VOLUME_STEP);
   if(st <= 0) st = mn;
   lot = MathFloor(lot / st + 1e-9) * st;
   if(lot < mn) lot = mn; if(lot > mx) lot = mx;
   return NormalizeDouble(lot, 8);
  }
// money lost per 1.0 lot over a price distance
double LossPerLot(const string s, double dist)
  {
   double tv = SymbolInfoDouble(s, SYMBOL_TRADE_TICK_VALUE_LOSS), ts = SymbolInfoDouble(s, SYMBOL_TRADE_TICK_SIZE);
   if(tv <= 0) tv = SymbolInfoDouble(s, SYMBOL_TRADE_TICK_VALUE);
   if(tv <= 0 || ts <= 0) return 0;
   return dist / ts * tv;
  }

//+------------------------------------------------------------------+
void OnTimer()
  {
   NewDay();
   string url = ServerURL + "/api/robot/feed" + (AccessKey != "" ? "?key=" + AccessKey : "");
   char body[], res[]; string hdr;
   ResetLastError();
   int code = WebRequest("GET", url, "", 5000, body, res, hdr);
   if(code != 200) { static datetime warned = 0; if(TimeLocal() - warned > 300) { Print("Royal Trades robot: feed error ", code, " (", GetLastError(), "). Is the server running and its URL allowed in Tools > Options > Expert Advisors?"); warned = TimeLocal(); } return; }
   string text = CharArrayToString(res, 0, WHOLE_ARRAY, CP_UTF8);
   string lines[]; int n = StringSplit(text, '\n', lines);
   for(int i = 0; i < n; i++) Handle(lines[i]);
  }

void Handle(const string line)
  {
   string f[]; if(StringSplit(line, '|', f) < 16) return;
   string id = f[0], sym = f[1], source = f[2], market = f[3], dir = f[4], status = f[5], grade = f[6];
   bool royalty = f[7] == "1";
   double entry = StringToDouble(f[8]), sl = StringToDouble(f[9]), slLive = StringToDouble(f[10]), tp1 = StringToDouble(f[11]), tp2 = StringToDouble(f[12]);
   long created = StringToInteger(f[13]), filled = StringToInteger(f[14]);
   string s = MapSymbol(sym, source);
   ulong tk[]; int have = SignalPositions(id, tk);
   if(have > 0) { Manage(id, s, dir, status, entry, slLive, tk); return; }
   if(Done(id) || status != "ACTIVE") return;
   MarkDone(id);   // decide once per signal
   if(s == "" || !SymbolSelect(s, true)) { Print("Skip ", sym, ": no matching symbol at this broker (check SymbolMap)"); return; }
   if(!InList(Grades, grade)) return;
   if(Direction == DIR_BUY && dir != "BUY") return; if(Direction == DIR_SELL && dir != "SELL") return;
   if(!InList(Markets, market)) return;
   if(SkipRoyalty && royalty) { Print("Skip ", s, ": Royalty market (no proven edge)"); return; }
   long age = (long)TimeGMT() - (filled > 0 ? filled : created);
   if(age > MaxSignalAgeSec) { Print("Skip ", s, ": signal is ", age, "s old"); return; }
   if(g_halted) { Print("Skip ", s, ": robot paused for today"); return; }
   if(g_dayCount >= MaxSignalsPerDay) { Print("Skip ", s, ": daily limit reached"); return; }
   if(OpenSignalCount() >= MaxOpenSignals) { Print("Skip ", s, ": max open signals reached"); return; }
   double pnl = ClosedPnlToday();
   if(g_dayStartBal > 0 && -pnl >= g_dayStartBal * MaxDailyLossPct / 100.0) { g_halted = true; Print("Royal Trades robot paused for today: daily loss limit"); return; }
   Open(id, s, dir, entry, sl, tp1, tp2);
  }

void Open(const string id, const string s, const string dir, double entry, double sl, double tp1, double tp2)
  {
   bool buy = dir == "BUY";
   double px = buy ? SymbolInfoDouble(s, SYMBOL_ASK) : SymbolInfoDouble(s, SYMBOL_BID);
   int dg = (int)SymbolInfoInteger(s, SYMBOL_DIGITS);
   double risk = MathAbs(entry - sl); if(risk <= 0 || px <= 0) return;
   // levels as distances from the signal entry, applied to this broker's price
   double sgn = buy ? 1 : -1;
   double runR = 0; double bid = SymbolInfoDouble(s, SYMBOL_BID);
   if(MathAbs(bid - entry) < risk * 5) runR = sgn * (bid - entry) / risk; // same feed (Deriv MT5 / Weltrade): compare directly
   if(runR > MaxSlipR) { Print("Skip ", s, ": price already ", DoubleToString(runR, 2), "R past entry"); return; }
   double slP = NormalizeDouble(px - sgn * risk, dg), t1 = NormalizeDouble(px + sgn * MathAbs(tp1 - entry), dg), t2 = NormalizeDouble(px + sgn * MathAbs(tp2 - entry), dg);
   int legs = MathMax(1, MathMin(3, TradesPerSignal));
   double lot;
   if(LotMode == LOT_FIXED) lot = NormLot(s, FixedLot);
   else
     {
      double lpl = LossPerLot(s, risk); if(lpl <= 0) { Print("Skip ", s, ": no tick value"); return; }
      double money = AccountInfoDouble(ACCOUNT_BALANCE) * RiskPercent / 100.0;
      lot = NormLot(s, money / lpl / legs);
     }
   double totalRisk = LossPerLot(s, risk) * lot * legs, bal = AccountInfoDouble(ACCOUNT_BALANCE);
   if(bal > 0 && totalRisk > bal * MaxRiskPercent / 100.0)
     {
      if(legs > 1 && LossPerLot(s, risk) * lot <= bal * MaxRiskPercent / 100.0) legs = 1;
      else { Print("Skip ", s, ": minimum lot risks ", DoubleToString(totalRisk, 2), " (", DoubleToString(totalRisk / bal * 100, 1), "%), over the ", MaxRiskPercent, "% cap"); return; }
     }
   int ok = 0;
   for(int k = 1; k <= legs; k++)
     {
      double tp = (k == 1 || legs == 1) ? t1 : t2;
      if(legs == 3 && k == 3) tp = 0; // third leg runs, closed by the engine
      string cm = "RT:" + id + ":" + IntegerToString(k);
      bool r = buy ? trade.Buy(lot, s, 0, slP, tp, cm) : trade.Sell(lot, s, 0, slP, tp, cm);
      if(r && trade.ResultRetcode() == TRADE_RETCODE_DONE) ok++;
      else Print("Order failed on ", s, ": ", trade.ResultRetcode(), " ", trade.ResultRetcodeDescription());
     }
   if(ok > 0) { g_dayCount++; Print("Opened ", dir, " ", s, " ", ok, " x ", DoubleToString(lot, 2), " lot, risk ~", DoubleToString(LossPerLot(s, risk) * lot * ok, 2), " ", AccountInfoString(ACCOUNT_CURRENCY)); }
  }

void Manage(const string id, const string s, const string dir, const string status, double entry, double slLive, ulong &tk[])
  {
   bool closed = status == "SL_HIT" || status == "TP2_HIT" || status == "TP5_HIT" || status == "BE_HIT" || status == "BE_EARLY" || status == "TRAIL_EXIT" || status == "SOFT_EXIT" || status == "DYN_STOP" || status == "TIME_EXIT" || status == "EXPIRED" || status == "CANCELLED";
   bool buy = dir == "BUY";
   for(int i = 0; i < ArraySize(tk); i++)
     {
      if(!PositionSelectByTicket(tk[i])) continue;
      string c = PositionGetString(POSITION_COMMENT);
      bool leg1 = StringFind(c, ":1", StringLen(c) - 2) >= 0;
      if(closed || (status == "TP1_HIT" && leg1 && ArraySize(tk) > 1)) { trade.PositionClose(tk[i]); continue; }
      // follow the engine's stop (only ever tighter), measured from the signal entry onto this position's open price
      double open = PositionGetDouble(POSITION_PRICE_OPEN), cur = PositionGetDouble(POSITION_SL), tp = PositionGetDouble(POSITION_TP);
      int dg = (int)SymbolInfoInteger(s, SYMBOL_DIGITS);
      double want = NormalizeDouble(open + (slLive - entry), dg);
      double pt = SymbolInfoDouble(s, SYMBOL_POINT);
      if(buy ? want > cur + pt : (cur == 0 || want < cur - pt))
        {
         double bid = SymbolInfoDouble(s, SYMBOL_BID), ask = SymbolInfoDouble(s, SYMBOL_ASK);
         if(buy ? want < bid : want > ask) trade.PositionModify(tk[i], want, tp);
        }
     }
  }
//+------------------------------------------------------------------+
