// src/agents/brain.js — AI Trading Brain
import { callLLM } from '../llm/router.js';
import { fetchQuote, fetchOHLC, calcAllIndicators, scoreScalping, calcEntryPlan } from '../indicators/market.js';
import { analyzeOrderbookProxy, formatOrderbookForAI } from '../indicators/orderbookProxy.js';
import { getContext, addContext, saveAnalysis, getAnalysisHistory, getWinRate, getUserMemory } from '../db/database.js';

const SYSTEM_PROMPT = `Kamu adalah AI analis saham IDX Indonesia yang expert dalam scalping dan swing trading T+2.
Kamu menganalisis data teknikal (RSI, MACD, EMA, Bollinger Band, ATR, Support/Resistance) dan memberikan rekomendasi konkret.
Selalu jawab dalam Bahasa Indonesia yang jelas dan ringkas.
Format output selalu: Analisis → Sinyal → Entry/SL/TP → Alasan → Risk Warning.
Jangan terlalu panjang — maksimal 300 kata. Gunakan emoji untuk poin penting.`;

// Helper internal (Safety First)
const fmt = n => (n !== null && n !== undefined) ? Math.round(n).toLocaleString('id-ID') : 'N/A';
const p = n => (n !== null && n !== undefined) ? n.toFixed(2) + '%' : 'N/A';
// ── Full Stock Analysis ──────────────────────────────────────
export async function analyzeStock(symbol, options = {}) {
  const {
    provider = 'claude',
    model = null,
    userId = 'default',
    riskProfile = 'moderate',
    mode = 'scalping'
  } = options;

  // Fetch data
  const [quote, ohlc] = await Promise.all([fetchQuote(symbol), fetchOHLC(symbol, '3mo')]);
  const indicators = calcAllIndicators(ohlc);
  if (!indicators) return { error: 'Data tidak cukup untuk analisis' };

  const entry = calcEntryPlan(quote, indicators, riskProfile);
  const { score, reasons, signal, trend } = scoreScalping(quote, indicators);
  const orderbookInsight = analyzeOrderbookProxy(quote, ohlc);

  // Build context string for LLM
  const dataContext = buildDataContext(symbol, quote, indicators, entry, score, signal, trend);

  // Get conversation history
  const history = getContext(userId, 6);
  const pastAnalysis = getAnalysisHistory(symbol, 2);
  const winRate = getWinRate();

  // Tambahkan orderbook insight ke prompt AI
  const obText = orderbookInsight
    ? `\nORDERBOOK PROXY:\n` +
      `Bias: ${orderbookInsight.verdict} (${orderbookInsight.strength})\n` +
      `MFI: ${orderbookInsight.pf?.cmf?.toFixed(3) || 'N/A'}\n` +
      `Buy vol: ${orderbookInsight.buyPct}% vs Sell vol: ${orderbookInsight.sellPct}%\n` +
      `CVD Trend: ${orderbookInsight.pf?.obvTrend}\n` +
      `Large trades: ${(orderbookInsight.hasLargeOrder ? 1 : 0) || 0} event\n` +
      `Insights: ${orderbookInsight.insights?.join(' | ')}`
    : '';

  const prompt = `${dataContext}${obText}

Riwayat analisis sebelumnya: ${pastAnalysis.length > 0 ? pastAnalysis.map(a => `[${a.timestamp}] Signal: ${a.signal}, Score: ${a.score}`).join(' | ') : 'Belum ada'}
Win rate bot secara keseluruhan: ${winRate.winRate}% dari ${winRate.total} trade

Mode: ${mode.toUpperCase()} | Risk Profile: ${riskProfile.toUpperCase()}

Berikan analisis ${mode} untuk ${symbol}. Sertakan: sinyal (BELI/JUAL/HOLD), entry price, stop loss, take profit, dan alasan teknikal.`;

  // Call LLM
  const messages = [...history.map(h => ({ role: h.role, content: h.content })), { role: 'user', content: prompt }];
  const llmResult = await callLLM({ provider, model, systemPrompt: SYSTEM_PROMPT, messages, maxTokens: 800 });

  // Save to DB
  addContext(userId, 'user', `Analisis ${symbol}`);
  addContext(userId, 'assistant', llmResult.text);
  saveAnalysis({ symbol, userId, llm: `${provider}/${llmResult.model}`, analysis: llmResult.text, signal, entryPrice: entry.price, stopLoss: entry.stopLoss, takeProfit: entry.takeProfit1, score });

  const obSummary = orderbookInsight 
    ? `${orderbookInsight.verdict} (${orderbookInsight.strength}) | Buy: ${orderbookInsight.buyPct}%`
    : null;

  return { 
    quote, 
    indicators, 
    entry, 
    score, 
    signal, 
    trend, 
    reasons, 
    // Kita kirim string ringkas agar bot.js mudah menampilkannya
    orderbookInsight: obSummary, 
    analysis: llmResult.text, 
    provider: llmResult.provider, 
    model: llmResult.model 
  };
}

// ── Free Chat dengan context ─────────────────────────────────
export async function freeChat(message, options = {}) {
  const { provider = 'claude', model = null, userId = 'default' } = options;
  const history = getContext(userId, 10);
  const mem = getUserMemory(userId);

  const systemWithMemory = `${SYSTEM_PROMPT}

Memori user ini:
- Preferred LLM: ${mem.preferred_llm}
- Risk Profile: ${mem.risk_profile}
- Strategi favorit: ${mem.strategy}
- Watchlist: ${mem.watchlist}`;

  const messages = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message }
  ];

  const result = await callLLM({ provider, model, systemPrompt: systemWithMemory, messages, maxTokens: 800 });

  addContext(userId, 'user', message);
  addContext(userId, 'assistant', result.text);

  return result;
}

// ── Auto Scan All Watchlist ──────────────────────────────────
// ── Auto Scan All Watchlist ──────────────────────────────────
export async function scanWatchlist(watchlist, options = {}) {
  const { provider = 'claude', model = null, riskProfile = 'moderate' } = options;
  const results = [];

  for (const symbol of watchlist) {
    try {
      const [quote, ohlc] = await Promise.all([fetchQuote(symbol), fetchOHLC(symbol, '3mo')]);
      const indicators = calcAllIndicators(ohlc);
      if (!indicators) continue;

      const entry = calcEntryPlan(quote, indicators, riskProfile);
      const { score, signal, trend, reasons } = scoreScalping(quote, indicators);

      // --- LOGIKA ORDERBOOK UNTUK SCANNER ---
      const orderbookInsight = analyzeOrderbookProxy(quote, ohlc);
      const obSummary = orderbookInsight 
        ? `${orderbookInsight.verdict} (${orderbookInsight.strength})` 
        : null;

      results.push({ 
        symbol, 
        quote, 
        indicators, 
        entry, 
        score, 
        signal, 
        trend, 
        reasons,
        orderbookInsight: obSummary // Sekarang data ini tersedia untuk bot.js
      });
    } catch (e) {
      // skip jika error agar proses scan saham lain tidak terhenti
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ── Risk Management & Position Sizing ───────────────────────
export function calcPositionSize(capital, riskPctPerTrade, entry, stopLoss) {
  const riskAmount = capital * (riskPctPerTrade / 100);
  const riskPerShare = entry - stopLoss;
  if (riskPerShare <= 0) return { shares: 0, totalCost: 0, riskAmount: 0 };
  const shares = Math.floor(riskAmount / riskPerShare);
  // Round to lot (100 shares per lot in IDX)
  const lots = Math.max(1, Math.floor(shares / 100));
  const sharesRounded = lots * 100;
  return {
    lots,
    shares: sharesRounded,
    totalCost: sharesRounded * entry,
    riskAmount: sharesRounded * riskPerShare,
    riskPct: p(((sharesRounded * riskPerShare) / capital) * 100)
  };
}

// ── Build context string ─────────────────────────────────────
function buildDataContext(symbol, quote, ind, entry, score, signal, trend) {
  return `
DATA SAHAM ${symbol} (Yahoo Finance):
Harga:    Rp ${fmt(quote?.price)} | Change: ${p(quote?.changePct)}
Open:     Rp ${fmt(quote?.open)} | High: Rp ${fmt(quote?.high)} | Low: Rp ${fmt(quote?.low)}
Volume:   ${quote?.volume ? (quote.volume/1e6).toFixed(2)+'M lot' : 'N/A'}
Nilai:    Rp ${quote?.volume && quote?.price ? ((quote.volume * quote.price)/1e9).toFixed(2)+'B' : 'N/A'}
Vol Avg:  ${quote?.avgVolume ? (quote.avgVolume/1e6).toFixed(2)+'M lot' : 'N/A'}
Vol Rasio: ${quote?.avgVolume && quote?.volume ? (quote.volume / quote.avgVolume).toFixed(2)+'x rata-rata' : 'N/A'}
Market Cap: ${quote?.marketCap ? (quote.marketCap/1e12).toFixed(2)+'T' : 'N/A'} | PER: ${quote?.pe?.toFixed(1) || 'N/A'}x

INDIKATOR TEKNIKAL:
RSI(14): ${ind?.rsi?.toFixed(1) || 'N/A'} | Trend: ${trend}
MACD: ${ind?.macd?.MACD?.toFixed(0) || 'N/A'} | Signal: ${ind?.macd?.signal?.toFixed(0) || 'N/A'} | Hist: ${ind?.macd?.histogram?.toFixed(0) || 'N/A'}
EMA9: ${fmt(ind?.ema9)} | EMA20: ${fmt(ind?.ema20)} | EMA50: ${fmt(ind?.ema50)}
BB Upper: ${fmt(ind?.bb?.upper)} | BB Lower: ${fmt(ind?.bb?.lower)}
ATR: ${fmt(ind?.atr)} | VWAP: ${fmt(ind?.vwap)}
Support: ${fmt(ind?.support)} | Resistance: ${fmt(ind?.resistance)}
Volume Spike: ${ind?.volSpike ? 'YA (' + ind?.volRatio?.toFixed(1) + 'x)' : 'Tidak'}
Momentum 10h: ${ind?.momentum10?.toFixed(2) || 'N/A'}%

RENCANA ENTRY (Risk: ${p(entry?.riskPct)}, R:R = 1:${entry?.rr1 || 0}):
Entry: Rp ${fmt(entry?.price)} | SL: Rp ${fmt(entry?.stopLoss)} (${p(-entry?.riskPct)})
TP1: Rp ${fmt(entry?.takeProfit1)} (${p(entry?.tp1Pct)}) | TP2: Rp ${fmt(entry?.takeProfit2)} (${p(entry?.tp2Pct)})

SKOR TEKNIKAL: ${score}/100 → ${signal}
52W High: ${fmt(quote?.fiftyTwoWeekHigh)} | 52W Low: ${fmt(quote?.fiftyTwoWeekLow)}
`;
}
