//+------------------------------------------------------------------+
//|  RoyalTradesBridge.mq5                                       |
//|  Streams your MT5 broker's prices (e.g. Weltrade SyntX: FlipX,   |
//|  FiboX, QuadX, FX Vol...) to your Royal Trades server.      |
//|  It only reads prices. It never places, modifies or closes trades. |
//|                                                                  |
//|  Setup:                                                          |
//|  1. Tools > Options > Expert Advisors > tick "Allow WebRequest   |
//|     for listed URL" and add your server, e.g.                    |
//|     https://your-royal-trades-server.example.com                       |
//|  2. Attach this EA to any one chart (e.g. FlipX-1, M1).          |
//|  3. Set ServerURL, BridgeKey (same as BRIDGE_KEY on the server)  |
//|     and Symbols. Keep MT5 running (PC or VPS) for live capture.  |
//+------------------------------------------------------------------+
#property copyright "Royal Trades"
#property version   "1.00"
#property strict

input string ServerURL    = "https://your-royal-trades-server.example.com/api/bridge";
input string BridgeKey    = "change-me";
input string Symbols      = "FlipX-1,FlipX-2,FlipX-3,FlipX-4,FlipX-5,FiboX,QuadX,PlusX-1,FX-Vol-20,FX-Vol-40,FX-Vol-60,FX-Vol-99,SFX-Vol-20,SFX-Vol-40,GainX-400,GainX-600,PainX-400,PainX-600";
input int    PushSeconds  = 2;      // live push interval
input int    HistoryM1    = 6000;   // first push: M1 bars (about 4 days)
input int    HistoryM15   = 1500;
input int    HistoryH1    = 1500;

string g_syms[];
bool   g_hasHistory[];
int    g_offset = 0;          // broker server time minus UTC, in seconds
datetime g_lastOffsetCheck = 0;

//+------------------------------------------------------------------+
int OnInit()
  {
   int n = StringSplit(Symbols, ',', g_syms);
   if(n <= 0) { Print("Royal Trades bridge: no symbols"); return(INIT_PARAMETERS_INCORRECT); }
   ArrayResize(g_hasHistory, n);
   for(int i = 0; i < n; i++)
     {
      StringTrimLeft(g_syms[i]); StringTrimRight(g_syms[i]);
      g_hasHistory[i] = false;
      if(!SymbolSelect(g_syms[i], true)) Print("Royal Trades bridge: symbol not found at this broker: ", g_syms[i]);
     }
   UpdateOffset();
   EventSetTimer(MathMax(1, PushSeconds));
   Print("Royal Trades bridge started for ", n, " symbols, server offset ", g_offset / 3600, "h");
   return(INIT_SUCCEEDED);
  }
void OnDeinit(const int reason) { EventKillTimer(); }

//+------------------------------------------------------------------+
void UpdateOffset()
  {
   // bar times in MT5 are broker server time; the engine works in UTC
   long diff = (long)TimeTradeServer() - (long)TimeGMT();
   g_offset = (int)(MathRound(diff / 1800.0) * 1800);   // round to 30 min
   g_lastOffsetCheck = TimeLocal();
  }

string Num(double v, int digits) { return DoubleToString(v, digits); }

// rates -> [[utc,o,h,l,c],...]
string RatesJson(const string sym, ENUM_TIMEFRAMES tf, int count, int digits)
  {
   MqlRates r[];
   int got = CopyRates(sym, tf, 0, count, r);
   if(got <= 0) return("[]");
   string s = "[";
   for(int i = 0; i < got; i++)
     {
      if(i > 0) s += ",";
      s += "[" + IntegerToString((long)r[i].time - g_offset) + "," + Num(r[i].open, digits) + "," + Num(r[i].high, digits) + "," + Num(r[i].low, digits) + "," + Num(r[i].close, digits) + "]";
     }
   return(s + "]");
  }

string SymbolPayload(const string sym, bool history)
  {
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   string s = "{\"symbol\":\"" + sym + "\",\"digits\":" + IntegerToString(digits);
   if(history)
     {
      s += ",\"m1\":" + RatesJson(sym, PERIOD_M1, HistoryM1, digits);
      s += ",\"m15\":" + RatesJson(sym, PERIOD_M15, HistoryM15, digits);
      s += ",\"h1\":" + RatesJson(sym, PERIOD_H1, HistoryH1, digits);
     }
   else
     {
      s += ",\"m1\":" + RatesJson(sym, PERIOD_M1, 3, digits);    // last 2 closed + forming
      s += ",\"m15\":" + RatesJson(sym, PERIOD_M15, 2, digits);
      s += ",\"h1\":" + RatesJson(sym, PERIOD_H1, 2, digits);
     }
   return(s + "}");
  }

bool Post(const string json)
  {
   char data[], result[];
   string headers = "Content-Type: application/json\r\n", resHeaders;
   StringToCharArray(json, data, 0, WHOLE_ARRAY, CP_UTF8);
   ArrayResize(data, ArraySize(data) - 1);           // drop trailing \0
   ResetLastError();
   int code = WebRequest("POST", ServerURL, headers, 15000, data, result, resHeaders);
   if(code == -1)
     {
      int err = GetLastError();
      if(err == 4014) Print("Royal Trades bridge: add the server URL under Tools > Options > Expert Advisors > Allow WebRequest");
      else Print("Royal Trades bridge: WebRequest error ", err);
      return(false);
     }
   if(code != 200) { Print("Royal Trades bridge: server replied ", code, " ", CharArrayToString(result)); return(false); }
   return(true);
  }

//+------------------------------------------------------------------+
void OnTimer()
  {
   if(TimeLocal() - g_lastOffsetCheck > 3600) UpdateOffset();
   int n = ArraySize(g_syms);
   // 1) one symbol's history per tick until all are loaded (keeps each request small)
   for(int i = 0; i < n; i++)
     {
      if(g_hasHistory[i]) continue;
      string body = "{\"key\":\"" + BridgeKey + "\",\"symbols\":[" + SymbolPayload(g_syms[i], true) + "]}";
      if(Post(body)) { g_hasHistory[i] = true; Print("Royal Trades bridge: history sent for ", g_syms[i]); }
      return;
     }
   // 2) live: latest bars for every symbol in one small request
   string s = "{\"key\":\"" + BridgeKey + "\",\"symbols\":[";
   for(int i = 0; i < n; i++) { if(i > 0) s += ","; s += SymbolPayload(g_syms[i], false); }
   s += "]}";
   Post(s);
  }
//+------------------------------------------------------------------+
