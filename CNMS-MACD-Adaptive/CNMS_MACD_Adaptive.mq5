//+------------------------------------------------------------------+
//|                                       CNMS_MACD_Adaptive.mq5    |
//|                          CryptoNite — Bitcoin MACD Adaptive EA  |
//|                                                                  |
//|  Strategy : H4 MACD trend bias + H1 MACD crossover entry        |
//|  Risk Mgmt: ATR-based SL / TP / Trailing Stop                   |
//|  Adoption : Detects manual trades and applies full management    |
//+------------------------------------------------------------------+
#property copyright "CryptoNite"
#property description "MTF MACD with adaptive manual trade adoption"
#property version     "1.00"
#property strict

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>

//────────────────────────────────────────────────────────────────────
// INPUT GROUPS
//────────────────────────────────────────────────────────────────────

input group "══ MACD Parameters ══"
input int                InpMacdFast   = 12;           // Fast EMA period
input int                InpMacdSlow   = 26;           // Slow EMA period
input int                InpMacdSignal = 9;            // Signal line period
input ENUM_APPLIED_PRICE InpMacdPrice  = PRICE_CLOSE;  // Applied price

input group "══ Timeframes ══"
input ENUM_TIMEFRAMES InpTrendTF = PERIOD_H4;  // Trend TF  (H4 default)
input ENUM_TIMEFRAMES InpEntryTF = PERIOD_H1;  // Entry TF  (H1 default)

input group "══ ATR Risk Management ══"
input int    InpAtrPeriod   = 14;   // ATR period
input double InpSlMulti     = 1.0;  // Stop Loss     (× ATR)          ← backtest optimised
input double InpTpMulti     = 2.0;  // Take Profit   (× ATR)  →  1:2 R:R
input double InpTrailStart  = 0.8;  // Trail activates when profit ≥ (× ATR)
input double InpTrailDist   = 0.8;  // Trail distance behind price (× ATR)
input double InpTrailStep   = 0.3;  // Min move before trail updates (× ATR)

input group "══ Trade Execution ══"
input int    InpMagicNumber  = 202600; // Bot magic number
input double InpLotSize      = 0.01;   // Lot size
input int    InpSlippage     = 50;     // Max slippage (points)
input int    InpMaxPositions = 1;      // Max bot positions at once

input group "══ Manual Trade Adoption ══"
input bool   InpAdoptManual  = true;   // Adopt manual trades
input bool   InpAlertOnAdopt = true;   // Alert when a trade is adopted
input bool   InpOverrideSL   = false;  // Override existing SL with ATR SL
input bool   InpOverrideTP   = false;  // Override existing TP with ATR TP

//────────────────────────────────────────────────────────────────────
// GLOBALS
//────────────────────────────────────────────────────────────────────
CTrade trade;

int    hMacdTrend  = INVALID_HANDLE;
int    hMacdEntry  = INVALID_HANDLE;
int    hAtr        = INVALID_HANDLE;

string g_sym       = "";
int    g_digits    = 5;

datetime g_lastBarTime = 0;   // New-bar tracker for entry TF

ulong  g_adoptedTickets[];    // Tickets of adopted manual trades

//+------------------------------------------------------------------+
//| INIT                                                             |
//+------------------------------------------------------------------+
int OnInit()
{
   g_sym    = Symbol();
   g_digits = (int)SymbolInfoInteger(g_sym, SYMBOL_DIGITS);

   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetDeviationInPoints(InpSlippage);
   trade.SetTypeFilling(ORDER_FILLING_IOC);

   // Create indicator handles
   hMacdTrend = iMACD(g_sym, InpTrendTF, InpMacdFast, InpMacdSlow, InpMacdSignal, InpMacdPrice);
   hMacdEntry = iMACD(g_sym, InpEntryTF, InpMacdFast, InpMacdSlow, InpMacdSignal, InpMacdPrice);
   hAtr       = iATR (g_sym, InpEntryTF, InpAtrPeriod);

   if(hMacdTrend == INVALID_HANDLE || hMacdEntry == INVALID_HANDLE || hAtr == INVALID_HANDLE)
   {
      Print("CNMS ERROR: Failed to create indicator handles. Check symbol/broker.");
      return INIT_FAILED;
   }

   ArrayResize(g_adoptedTickets, 0);

   PrintFormat("CNMS_MACD_Adaptive ready | Symbol=%s | Magic=%d | Trend=%s | Entry=%s",
               g_sym, InpMagicNumber,
               EnumToString(InpTrendTF), EnumToString(InpEntryTF));
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| DEINIT                                                           |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   if(hMacdTrend != INVALID_HANDLE) IndicatorRelease(hMacdTrend);
   if(hMacdEntry != INVALID_HANDLE) IndicatorRelease(hMacdEntry);
   if(hAtr       != INVALID_HANDLE) IndicatorRelease(hAtr);
}

//+------------------------------------------------------------------+
//| TICK                                                             |
//+------------------------------------------------------------------+
void OnTick()
{
   // ── Step 1: Purge adopted list of closed trades ─────────────────
   PurgeClosedAdopted();

   // ── Step 2: Trail all managed positions every tick ──────────────
   ManageTrailingStops();

   // ── Step 3: Adopt unmanaged manual trades ───────────────────────
   if(InpAdoptManual)
      AdoptManualTrades();

   // ── Step 4: Signal check only on new entry-TF bar ───────────────
   if(!IsNewEntryBar()) return;

   // ── Step 5: Read indicators ─────────────────────────────────────
   double trendMain[], trendSig[];
   double entryMain[], entrySig[];
   double atrBuf[];

   if(!ReadMacd(hMacdTrend, trendMain, trendSig)) return;
   if(!ReadMacd(hMacdEntry, entryMain, entrySig)) return;
   if(!ReadAtr (hAtr, atrBuf))                    return;

   double atrVal = atrBuf[1];  // Last closed bar ATR

   // ── Step 6: Trend bias from H4 (use bar[1] = last closed H4 bar)─
   bool trendBull = (trendMain[1] > trendSig[1]);
   bool trendBear = (trendMain[1] < trendSig[1]);

   // ── Step 7: Crossover detection on H1 ───────────────────────────
   //   bar[2] = 2 bars ago, bar[1] = last closed bar
   bool bullCross = (entryMain[2] <= entrySig[2]) && (entryMain[1] > entrySig[1]);
   bool bearCross = (entryMain[2] >= entrySig[2]) && (entryMain[1] < entrySig[1]);

   // ── Step 8: Execute if aligned and under position limit ─────────
   if(CountBotPositions() < InpMaxPositions)
   {
      if(trendBull && bullCross)
         OpenTrade(ORDER_TYPE_BUY,  atrVal);
      else if(trendBear && bearCross)
         OpenTrade(ORDER_TYPE_SELL, atrVal);
   }
}

//+------------------------------------------------------------------+
//| Open a new bot trade with ATR SL / TP                           |
//+------------------------------------------------------------------+
void OpenTrade(ENUM_ORDER_TYPE type, double atrVal)
{
   double ask    = SymbolInfoDouble(g_sym, SYMBOL_ASK);
   double bid    = SymbolInfoDouble(g_sym, SYMBOL_BID);
   double slDist = InpSlMulti * atrVal;
   double tpDist = InpTpMulti * atrVal;

   double entry, sl, tp;

   if(type == ORDER_TYPE_BUY)
   {
      entry = ask;
      sl    = NormalizeDouble(entry - slDist, g_digits);
      tp    = NormalizeDouble(entry + tpDist, g_digits);
   }
   else
   {
      entry = bid;
      sl    = NormalizeDouble(entry + slDist, g_digits);
      tp    = NormalizeDouble(entry - tpDist, g_digits);
   }

   // Validate stops are above broker minimum distance
   double minStop = SymbolInfoInteger(g_sym, SYMBOL_TRADE_STOPS_LEVEL) *
                    SymbolInfoDouble (g_sym, SYMBOL_POINT);
   if(MathAbs(entry - sl) < minStop || MathAbs(entry - tp) < minStop)
   {
      Print("CNMS: SL/TP too close to entry (broker min stop). Trade skipped.");
      return;
   }

   string comment = StringFormat("CNMS_%s_H4H1", type == ORDER_TYPE_BUY ? "BUY" : "SELL");

   bool ok = (type == ORDER_TYPE_BUY)
             ? trade.Buy (InpLotSize, g_sym, entry, sl, tp, comment)
             : trade.Sell(InpLotSize, g_sym, entry, sl, tp, comment);

   if(ok && trade.ResultRetcode() == TRADE_RETCODE_DONE)
      PrintFormat("CNMS: Opened %s | Entry=%.5f SL=%.5f TP=%.5f ATR=%.5f",
                  comment, entry, sl, tp, atrVal);
   else
      PrintFormat("CNMS: Trade FAILED — %s (%d)", trade.ResultRetcodeDescription(), trade.ResultRetcode());
}

//+------------------------------------------------------------------+
//| Scan for manual trades (no magic) and adopt them                 |
//+------------------------------------------------------------------+
void AdoptManualTrades()
{
   double atrBuf[];
   if(!ReadAtr(hAtr, atrBuf)) return;
   double atrVal = atrBuf[1];

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != g_sym) continue;

      long magic = PositionGetInteger(POSITION_MAGIC);
      if(magic == InpMagicNumber)   continue;  // Bot's own trade — skip
      if(IsAlreadyAdopted(ticket))  continue;  // Already adopted — skip

      AdoptOneTrade(ticket, atrVal);
   }
}

//+------------------------------------------------------------------+
//| Apply ATR SL / TP to a single manual trade and register it       |
//+------------------------------------------------------------------+
void AdoptOneTrade(ulong ticket, double atrVal)
{
   if(!PositionSelectByTicket(ticket)) return;

   double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
   double curSL     = PositionGetDouble(POSITION_SL);
   double curTP     = PositionGetDouble(POSITION_TP);
   ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);

   double slDist = InpSlMulti * atrVal;
   double tpDist = InpTpMulti * atrVal;

   double newSL = curSL;
   double newTP = curTP;
   bool   doModify = false;

   if(posType == POSITION_TYPE_BUY)
   {
      double atrSL = NormalizeDouble(openPrice - slDist, g_digits);
      double atrTP = NormalizeDouble(openPrice + tpDist, g_digits);

      // Apply SL: if none exists, or InpOverrideSL is true
      if(curSL == 0 || InpOverrideSL) { newSL = atrSL; doModify = true; }
      if(curTP == 0 || InpOverrideTP) { newTP = atrTP; doModify = true; }
   }
   else  // SELL
   {
      double atrSL = NormalizeDouble(openPrice + slDist, g_digits);
      double atrTP = NormalizeDouble(openPrice - tpDist, g_digits);

      if(curSL == 0 || InpOverrideSL) { newSL = atrSL; doModify = true; }
      if(curTP == 0 || InpOverrideTP) { newTP = atrTP; doModify = true; }
   }

   if(doModify)
   {
      trade.PositionModify(ticket, newSL, newTP);
      if(trade.ResultRetcode() == TRADE_RETCODE_DONE)
         PrintFormat("CNMS: Adopted trade #%I64u | newSL=%.5f newTP=%.5f", ticket, newSL, newTP);
      else
         PrintFormat("CNMS: Adopt modify FAILED #%I64u — %s", ticket, trade.ResultRetcodeDescription());
   }

   // Register in adopted list regardless (for trailing management)
   RegisterAdopted(ticket);

   if(InpAlertOnAdopt)
      Alert(StringFormat("CNMS: Manual trade #%I64u adopted — trailing stop active", ticket));
}

//+------------------------------------------------------------------+
//| Trail all managed positions (bot-owned + adopted)                |
//+------------------------------------------------------------------+
void ManageTrailingStops()
{
   double atrBuf[];
   if(!ReadAtr(hAtr, atrBuf)) return;
   double atrVal     = atrBuf[0];  // Current bar (live) for trailing

   double trailStart = InpTrailStart * atrVal;
   double trailDist  = InpTrailDist  * atrVal;
   double trailStep  = InpTrailStep  * atrVal;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != g_sym) continue;

      long magic      = PositionGetInteger(POSITION_MAGIC);
      bool isBotOwned = (magic == InpMagicNumber);
      bool isAdopted  = IsAlreadyAdopted(ticket);

      if(!isBotOwned && !isAdopted) continue;  // Unmanaged — skip

      double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      double curSL     = PositionGetDouble(POSITION_SL);
      double curTP     = PositionGetDouble(POSITION_TP);
      ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);

      double ask = SymbolInfoDouble(g_sym, SYMBOL_ASK);
      double bid = SymbolInfoDouble(g_sym, SYMBOL_BID);
      double newSL = curSL;

      if(posType == POSITION_TYPE_BUY)
      {
         double profit = bid - openPrice;
         if(profit < trailStart) continue;          // Not in profit enough yet

         double idealSL = NormalizeDouble(bid - trailDist, g_digits);
         if(idealSL > curSL + trailStep)            // Moved enough to update
            newSL = idealSL;
      }
      else  // SELL
      {
         double profit = openPrice - ask;
         if(profit < trailStart) continue;

         double idealSL = NormalizeDouble(ask + trailDist, g_digits);
         if(idealSL < curSL - trailStep || curSL == 0)
            newSL = idealSL;
      }

      if(newSL != curSL && newSL > 0)
         trade.PositionModify(ticket, newSL, curTP);
   }
}

//────────────────────────────────────────────────────────────────────
// ADOPTED LIST HELPERS
//────────────────────────────────────────────────────────────────────

void RegisterAdopted(ulong ticket)
{
   int sz = ArraySize(g_adoptedTickets);
   ArrayResize(g_adoptedTickets, sz + 1);
   g_adoptedTickets[sz] = ticket;
}

bool IsAlreadyAdopted(ulong ticket)
{
   int sz = ArraySize(g_adoptedTickets);
   for(int i = 0; i < sz; i++)
      if(g_adoptedTickets[i] == ticket) return true;
   return false;
}

// Remove tickets of trades that are no longer open
void PurgeClosedAdopted()
{
   int sz = ArraySize(g_adoptedTickets);
   if(sz == 0) return;

   ulong live[];
   int   liveCount = 0;
   ArrayResize(live, sz);

   for(int i = 0; i < sz; i++)
   {
      if(PositionSelectByTicket(g_adoptedTickets[i]))
         live[liveCount++] = g_adoptedTickets[i];
   }

   ArrayResize(g_adoptedTickets, liveCount);
   ArrayCopy(g_adoptedTickets, live, 0, 0, liveCount);
}

//────────────────────────────────────────────────────────────────────
// INDICATOR READERS
//────────────────────────────────────────────────────────────────────

bool ReadMacd(int handle, double &main[], double &sig[])
{
   ArraySetAsSeries(main, true);
   ArraySetAsSeries(sig,  true);
   if(CopyBuffer(handle, MAIN_LINE,   0, 3, main) < 3) return false;
   if(CopyBuffer(handle, SIGNAL_LINE, 0, 3, sig)  < 3) return false;
   return true;
}

bool ReadAtr(int handle, double &buf[])
{
   ArraySetAsSeries(buf, true);
   return (CopyBuffer(handle, 0, 0, 3, buf) >= 3);
}

//────────────────────────────────────────────────────────────────────
// UTILITIES
//────────────────────────────────────────────────────────────────────

bool IsNewEntryBar()
{
   datetime t = iTime(g_sym, InpEntryTF, 0);
   if(t != g_lastBarTime)
   {
      g_lastBarTime = t;
      return true;
   }
   return false;
}

int CountBotPositions()
{
   int count = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) == g_sym &&
         PositionGetInteger(POSITION_MAGIC) == InpMagicNumber)
         count++;
   }
   return count;
}
//+------------------------------------------------------------------+
