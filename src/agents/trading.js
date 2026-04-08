// src/agents/trading.js — Master Trading Engine v3.1
import { fetchQuote, fetchOHLC, calcAllIndicators, scoreScalping, calcEntryPlan } from '../indicators/market.js';
import { analyzeOrderbookProxy, formatOrderbookForAI } from '../indicators/orderbookProxy.js';

import { getKongloData } from '../db/excelLoader.js';
import { getPortfolio, getDailyTradeCount, getOpenTrades, calcEV } from '../db/database.js';

const fmt    = n => (n!=null && !isNaN(n)) ? Math.round(n).toLocaleString('id-ID') : 'N/A';
const fmtPct = n => n!=null ? (n>=0?'+':'')+parseFloat(n).toFixed(2)+'%' : 'N/A';

// ── ARA / ARB (BEI per 8 April 2025 — fix 15%) ──────────────
export function calcARAARB(prevClose) {
  if (!prevClose || prevClose <= 0) return { ara: null, arb: null };
  let tick = 1;
  if (prevClose >= 200  && prevClose < 500)  tick = 2;
  if (prevClose >= 500  && prevClose < 2000) tick = 5;
  if (prevClose >= 2000 && prevClose < 5000) tick = 10;
  if (prevClose >= 5000)                     tick = 25;
  const arb = Math.floor(prevClose * 0.85 / tick) * tick;
  const ara = Math.floor(prevClose * 1.15 / tick) * tick;
  return { ara, arb, tick };
}

// ── Setup Classification ─────────────────────────────────────
export function classifySetup(quote, indicators, isKonglo = false) {
  if (!indicators) return { setup: null, confidence: 'Low', reason: 'Data tidak cukup' };

  const { rsi, macd, volRatio, ema9, ema20, trend, bb } = indicators;
  const price   = quote.price;
  const chgPct  = quote.changePct || 0;
  const scores  = { KONGLO_MOMENTUM: 0, BREAKOUT_VALID: 0, REVERSAL_AKUMULASI: 0 };
  const reasons = [];

  // ── KONGLO_MOMENTUM ────────────────────────────────────────
  if (isKonglo) {
    scores.KONGLO_MOMENTUM += 30;
    reasons.push('🏦 Saham konglomerat terdeteksi');
  }
  // Volume quality scoring
  if (volRatio >= 3.0) {
    scores.KONGLO_MOMENTUM += 25; scores.BREAKOUT_VALID += 25; scores.REVERSAL_AKUMULASI += 20;
    reasons.push(`🔥 Volume sangat tinggi ${volRatio.toFixed(1)}x — sinyal kuat`);
  } else if (volRatio >= 2.0) {
    scores.KONGLO_MOMENTUM += 20; scores.BREAKOUT_VALID += 20; scores.REVERSAL_AKUMULASI += 15;
    reasons.push(`⚡ Volume spike ${volRatio.toFixed(1)}x`);
  } else if (volRatio >= 1.5) {
    scores.KONGLO_MOMENTUM += 10; scores.BREAKOUT_VALID += 10; scores.REVERSAL_AKUMULASI += 8;
    reasons.push(`📊 Volume di atas rata-rata ${volRatio.toFixed(1)}x`);
  } else if (volRatio < 0.5) {
    scores.KONGLO_MOMENTUM -= 10; scores.BREAKOUT_VALID -= 15;
    reasons.push(`⚠️ Volume sangat rendah — sinyal lemah`);
  }
  if (chgPct > 1.5)   { scores.KONGLO_MOMENTUM += 15; }
  if (ema9 > ema20)   { scores.KONGLO_MOMENTUM += 10; }
  if (macd?.histogram > 0) { scores.KONGLO_MOMENTUM += 10; }

  // ── BREAKOUT_VALID ─────────────────────────────────────────
  if (indicators.resistance && price > indicators.resistance * 0.99) {
    scores.BREAKOUT_VALID += 35;
    reasons.push(`🚀 Harga mendekati/melewati resistance Rp ${fmt(indicators.resistance)}`);
  }
  if (volRatio > 1.5) { scores.BREAKOUT_VALID += 20; }
  if (trend === 'BULLISH') { scores.BREAKOUT_VALID += 15; }
  if (rsi > 50 && rsi < 70) { scores.BREAKOUT_VALID += 10; }
  // Failed breakout detection
  if (price < indicators.resistance * 0.97 && volRatio < 1.2) {
    scores.BREAKOUT_VALID -= 20;
    reasons.push('⚠️ Volume lemah — potensi false breakout');
  }

  // ── REVERSAL_AKUMULASI ─────────────────────────────────────
  if (rsi < 35) {
    scores.REVERSAL_AKUMULASI += 30;
    reasons.push(`⚡ RSI ${rsi.toFixed(0)} — oversold`);
  } else if (rsi < 45) {
    scores.REVERSAL_AKUMULASI += 15;
  }
  if (bb && price <= bb.lower * 1.02) {
    scores.REVERSAL_AKUMULASI += 20;
    reasons.push('📊 Harga di area Bollinger Lower');
  }
  if (volRatio > 1.8 && chgPct > 0) {
    scores.REVERSAL_AKUMULASI += 15;
    reasons.push('📊 Volume akumulasi terdeteksi');
  }
  if (indicators.support && price <= indicators.support * 1.02) {
    scores.REVERSAL_AKUMULASI += 15;
    reasons.push(`📐 Di area support Rp ${fmt(indicators.support)}`);
  }

  // Pilih setup terbaik
  const sorted = Object.entries(scores).sort((a,b) => b[1]-a[1]);
  const [primarySetup, primaryScore] = sorted[0];
  const [secondarySetup, secondaryScore] = sorted[1];

  // Confidence berdasarkan score
  let confidence = 'Low';
  if (primaryScore >= 60)  confidence = 'High';
  else if (primaryScore >= 35) confidence = 'Medium';

  const hasSecondary = secondaryScore >= 25 && secondaryScore >= primaryScore * 0.6;

  return {
    setup: primarySetup,
    confidence,
    score: primaryScore,
    reason: reasons.slice(0,3).join(' | ') || 'Analisis teknikal standar',
    secondary: hasSecondary ? { setup: secondarySetup, score: secondaryScore } : null
  };
}

// ── AI Decision Engine ───────────────────────────────────────
export async function decisionEngine(symbol, userId = 'default') {
  const [quote, ohlc] = await Promise.all([fetchQuote(symbol), fetchOHLC(symbol, '3mo')]);
  const indicators    = calcAllIndicators(ohlc);
  if (!indicators) return { action: 'SKIP', reason: 'Data tidak cukup untuk analisis' };
  const obProxy = analyzeOrderbookProxy(quote, ohlc);
  

  const { data: kongloData, reverseIndex } = await getKongloData();
  const isKonglo   = !!(reverseIndex[symbol]);
  const kongloInfo = reverseIndex[symbol] || [];

  // Setup classification
  const setupResult = classifySetup(quote, indicators, isKonglo);

  // Technical score
  const { score: techScore } = scoreScalping(quote, indicators);

  // Combined score
  // Orderbook boost ke score
  let obBoost = 0;
  if (orderbookInsight) {
    if (orderbookInsight.verdict === 'BELI DOMINAN' && orderbookInsight.strength === 'KUAT') obBoost = +10;
    else if (orderbookInsight.verdict === 'BELI DOMINAN') obBoost = +5;
    else if (orderbookInsight.verdict === 'JUAL DOMINAN' && orderbookInsight.strength === 'KUAT') obBoost = -10;
    else if (orderbookInsight.verdict === 'JUAL DOMINAN') obBoost = -5;
  }
  const finalScore = Math.min(100, Math.max(0, Math.round((techScore * 0.45) + (setupResult.score * 0.45) + obBoost)));

  // ARA/ARB
  const { ara, arb } = calcARAARB(quote.prev || quote.price);

  // Entry plan (risk moderate)
  const entry = calcEntryPlan(quote, indicators, 'moderate');

  // EV historis
  const ev = calcEV(userId);

  // Portfolio check
  const portfolio  = getPortfolio(userId);
  const openTrades = getOpenTrades(userId);
  const dailyCount = getDailyTradeCount(userId);

  // Risk checks
  const riskChecks = [];
  if (openTrades.length >= portfolio.max_positions) riskChecks.push(`⚠️ Max posisi (${portfolio.max_positions}) tercapai`);
  if (dailyCount >= portfolio.daily_trade_limit)    riskChecks.push(`⚠️ Batas trade harian (${portfolio.daily_trade_limit}) tercapai`);
  if (finalScore < 70) riskChecks.push(`⚠️ Score ${finalScore}/100 — di bawah threshold 70`);

  // Trap detection
  let trapWarning = null;
  if (quote.changePct > 3 && indicators.volRatio < 1.2) {
    trapWarning = '🪤 Potensi bull trap — harga naik tanpa volume';
  }
  if (quote.changePct < -3 && indicators.volRatio < 1.2) {
    trapWarning = '🪤 Potensi bear trap — harga turun tanpa volume';
  }

  // Decision
  let action = 'SKIP';
  let actionReason = '';

  if (riskChecks.length > 0) {
    action = 'WAIT';
    actionReason = riskChecks.join(' | ');
  } else if (finalScore >= 70 && setupResult.confidence !== 'Low' && !trapWarning) {
    action = 'BUY';
    actionReason = `Score ${finalScore}/100 — ${setupResult.confidence} conviction`;
  } else if (finalScore >= 55) {
    action = 'WAIT';
    actionReason = `Score ${finalScore}/100 — tunggu konfirmasi`;
  } else {
    action = 'SKIP';
    actionReason = `Score ${finalScore}/100 — tidak ada setup bagus`;
  }

  // Position sizing
  const riskAmt    = portfolio.capital * (portfolio.risk_per_trade_pct / 100);
  const riskPerShr = (entry.price - entry.stopLoss);
  const maxLots    = riskPerShr > 0 ? Math.max(1, Math.floor(riskAmt / (riskPerShr * 100))) : 1;

  return {
    symbol, quote, indicators, isKonglo, kongloInfo,
    setupResult, techScore, finalScore, action, actionReason,
    entry, ara, arb, riskChecks, trapWarning,
    portfolio, openTrades: openTrades.length, dailyCount,
    maxLots, riskAmt, ev, orderbookInsight
  };
}

// ── Format analisis untuk Telegram ───────────────────────────
export function formatAnalysisTelegram(r) {
  const { symbol, quote, indicators: ind, isKonglo, kongloInfo,
          setupResult, finalScore, action, actionReason,
          entry, ara, arb, trapWarning, maxLots, ev } = r;

  const actionIcon = action === 'BUY' ? '🚀 BUY' : action === 'WAIT' ? '⏳ WAIT' : '🚫 SKIP';
  const confIcon   = { High:'🔥', Medium:'⚡', Low:'💤' }[setupResult.confidence] || '💤';
  const chg        = (quote.changePct||0).toFixed(2);
  const chgIcon    = parseFloat(chg) >= 0 ? '🟢' : '🔴';

  let text = '';
  text += `📊 *${symbol}* ${isKonglo ? '🏦' : ''}\n`;
  text += `${chgIcon} Rp ${fmt(quote.price)} (${parseFloat(chg)>=0?'+':''}${chg}%)\n`;
  text += `Open: ${fmt(quote.open)} | Vol: ${quote.volume?(quote.volume/1e6).toFixed(1)+'M':'N/A'}\n\n`;

  if (isKonglo && kongloInfo.length > 0) {
    text += `🏦 *Konglo:* ${kongloInfo.map(k=>k.kongloKey).join(' & ')}\n\n`;
  }

  text += `*Setup:* ${setupResult.setup}\n`;
  text += `*Confidence:* ${confIcon} ${setupResult.confidence}\n`;
  text += `*Reason:* ${setupResult.reason}\n`;
  if (setupResult.secondary) {
    text += `*Secondary:* ${setupResult.secondary.setup} (score ${setupResult.secondary.score})\n`;
  }
  text += `\n`;

  text += `📐 *Level Kunci:*\n`;
  text += `• ARA (+15%): Rp ${fmt(ara)}\n`;
  text += `• ARB (−15%): Rp ${fmt(arb)}\n`;
  text += `• Entry:      Rp ${fmt(entry.price)}\n`;
  text += `• Stop Loss:  Rp ${fmt(entry.stopLoss)} (−${entry.riskPct}%)\n`;
  text += `• TP1:        Rp ${fmt(entry.takeProfit1)} (+${entry.tp1Pct}%)\n`;
  text += `• TP2:        Rp ${fmt(entry.takeProfit2)} (+${entry.tp2Pct}%)\n`;
  text += `• Support:    Rp ${fmt(ind?.support)}\n`;
  text += `• Resistance: Rp ${fmt(ind?.resistance)}\n\n`;

  text += `📊 *Indikator:*\n`;
  text += `RSI: ${ind?.rsi?.toFixed(1)||'N/A'} | MACD: ${ind?.macd?.MACD?.toFixed(0)||'N/A'}\n`;
  text += `EMA9: ${fmt(ind?.ema9)} | EMA20: ${fmt(ind?.ema20)}\n`;
  text += `Volume: ${(ind?.volRatio||1).toFixed(1)}x rata-rata\n\n`;

  if (trapWarning) text += `${trapWarning}\n\n`;

  text += `🎯 *Skor: ${finalScore}/100*\n`;
  text += `${actionIcon} — ${actionReason}\n`;

  if (action === 'BUY') {
    text += `\n💰 *Max lot disarankan: ${maxLots} lot*\n`;
    if (ev) text += `📈 EV historis: ${ev.ev}% | WR: ${ev.winrate}%\n`;
  }

  return text.length > 4000 ? text.slice(0,4000)+'...' : text;
}

// ── Format trade summary ──────────────────────────────────────
export function formatTradeSummary(trade, exit = null) {
  const pnlIcon = exit?.pnl_rp >= 0 ? '✅' : '❌';
  let text = `📌 *Trade ${trade.symbol}*\n`;
  text += `Setup: ${trade.setup}\n`;
  text += `Entry: Rp ${fmt(trade.entry_price)} × ${trade.lots} lot\n`;
  text += `Status: ${trade.status}${trade.result ? ` — ${trade.result}` : ''}\n`;
  if (exit) {
    text += `Exit: Rp ${fmt(exit.exit_price)} | ${exit.exit_type}\n`;
    text += `${pnlIcon} PnL: Rp ${fmt(exit.pnl_rp)} (${fmtPct(exit.pnl_pct)})\n`;
  }
  return text;
}

// ── Multi-day Context Builder ────────────────────────────────
export async function buildMultiDayContext(symbol) {
  const { saveMultiDayContext } = await import('../db/database.js');
  const ohlc = await import('../indicators/market.js').then(m => m.fetchOHLC(symbol, '3mo'));
  if (!ohlc || ohlc.length < 10) return null;

  const last5  = ohlc.slice(-5);
  const last10 = ohlc.slice(-10);

  const trend5d  = last5[last5.length-1].close > last5[0].close ? 'UP' : 'DOWN';
  const trend10d = last10[last10.length-1].close > last10[0].close ? 'UP' : 'DOWN';
  const avgVol5d  = last5.reduce((a,b)=>a+b.volume,0) / 5;
  const avgVol10d = last10.reduce((a,b)=>a+b.volume,0) / 10;
  const highs5d   = last5.map(d=>d.high);
  const lows5d    = last5.map(d=>d.low);
  const support5d     = Math.min(...lows5d);
  const resistance5d  = Math.max(...highs5d);

  const ctx = { symbol, trend5d, trend10d, avgVol5d, avgVol10d, support5d, resistance5d };
  saveMultiDayContext(symbol, ctx);
  return ctx;
}

// ── Compounding Calculator ───────────────────────────────────
export function calcCompounding(capital, winrate, avgWinPct, avgLossPct, riskPct, trades) {
  let equity = capital;
  const history = [{ trade: 0, equity }];

  for (let i = 1; i <= trades; i++) {
    const risk  = equity * (riskPct / 100);
    const isWin = Math.random() < winrate;
    if (isWin) equity += risk * (avgWinPct / 100 / riskPct * 100) / 100 * risk;
    else       equity -= risk;
    history.push({ trade: i, equity: Math.round(equity) });
  }

  return {
    initialCapital: capital,
    finalEquity: Math.round(equity),
    growth: (((equity - capital) / capital) * 100).toFixed(1),
    trades, history: history.slice(-10)
  };
}
