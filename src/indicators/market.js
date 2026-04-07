// src/indicators/market.js — Multi-source IDX Data Fetcher + Technical Indicators
import axios from 'axios';
import { RSI, MACD, EMA, BollingerBands, ATR, Stochastic } from 'technicalindicators';

// ── Symbol Helper ────────────────────────────────────────────
function toYahooSymbol(s) { return s.endsWith('.JK') ? s : s + '.JK'; }

// ── Fetch Quote — Multi-source dengan fallback ───────────────
export async function fetchQuote(symbol) {
  // Source 1: Yahoo Finance v8 chart (paling reliable)
  try {
    const sym = toYahooSymbol(symbol);
    const r = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': '*/*', 'Referer': 'https://finance.yahoo.com' }, timeout: 8000 }
    );
    const meta = r.data?.chart?.result?.[0]?.meta;
    if (meta?.regularMarketPrice) {
      const prev = meta.previousClose || meta.chartPreviousClose || 0;
      const price = meta.regularMarketPrice;
      const change = price - prev;
      return {
        symbol, name: meta.longName || meta.shortName || symbol,
        price, prev, change,
        changePct: prev ? (change / prev) * 100 : 0,
        open: meta.regularMarketOpen || price,
        high: meta.regularMarketDayHigh || price,
        low: meta.regularMarketDayLow || price,
        volume: meta.regularMarketVolume || 0,
        marketCap: 0, pe: null, eps: null,
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || null,
        fiftyTwoWeekLow: meta.fiftyTwoWeekLow || null,
        bid: 0, ask: 0, avgVolume: 0,
        source: 'yahoo_v8'
      };
    }
  } catch (e) { /* fallback */ }

  // Source 2: Yahoo Finance v7 quotes
  try {
    const sym = toYahooSymbol(symbol);
    const r = await axios.get(
      `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${sym}`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, timeout: 8000 }
    );
    const q = r.data?.quoteResponse?.result?.[0];
    if (q?.regularMarketPrice) {
      return {
        symbol, name: q.longName || q.shortName || symbol,
        price: q.regularMarketPrice,
        prev: q.regularMarketPreviousClose || 0,
        change: q.regularMarketChange || 0,
        changePct: q.regularMarketChangePercent || 0,
        open: q.regularMarketOpen || 0,
        high: q.regularMarketDayHigh || 0,
        low: q.regularMarketDayLow || 0,
        volume: q.regularMarketVolume || 0,
        marketCap: q.marketCap || 0,
        pe: q.trailingPE || null,
        eps: q.epsTrailingTwelveMonths || null,
        fiftyTwoWeekHigh: q.fiftyTwoWeekHigh || null,
        fiftyTwoWeekLow: q.fiftyTwoWeekLow || null,
        bid: q.bid || 0, ask: q.ask || 0,
        avgVolume: q.averageDailyVolume10Day || 0,
        source: 'yahoo_v7'
      };
    }
  } catch (e) { /* fallback */ }

  // Source 3: Stockbit exodus API (no auth needed untuk data publik)
  try {
    const r = await axios.get(
      `https://exodus.stockbit.com/stream/v3/symbol/${symbol}`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://stockbit.com', 'Origin': 'https://stockbit.com' }, timeout: 8000 }
    );
    const d = r.data?.data;
    if (d?.last_done) {
      const price = d.last_done, prev = d.previous_close || 0;
      return {
        symbol, name: d.company_name || symbol,
        price, prev, change: price - prev,
        changePct: prev ? ((price - prev) / prev) * 100 : 0,
        open: d.open || price, high: d.high || price, low: d.low || price,
        volume: d.volume || 0, marketCap: d.market_cap || 0,
        pe: d.pe || null, eps: d.eps || null,
        fiftyTwoWeekHigh: null, fiftyTwoWeekLow: null,
        bid: d.bid || 0, ask: d.offer || 0, avgVolume: 0,
        source: 'stockbit'
      };
    }
  } catch (e) { /* fallback */ }

  // Source 4: Mock data (demo mode)
  return mockQuote(symbol);
}

// ── Fetch OHLC History ───────────────────────────────────────
export async function fetchOHLC(symbol, period = '3mo') {
  // Source 1: Yahoo v8 chart history
  try {
    const sym = toYahooSymbol(symbol);
    const rangeMap = { '1mo': '1mo', '3mo': '3mo', '6mo': '6mo', '1y': '1y' };
    const range = rangeMap[period] || '3mo';
    const r = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=${range}`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://finance.yahoo.com' }, timeout: 10000 }
    );
    const result = r.data?.chart?.result?.[0];
    if (result?.timestamp?.length > 10) {
      const ts = result.timestamp;
      const { open, high, low, close, volume } = result.indicators.quote[0];
      return ts.map((t, i) => ({
        date: new Date(t * 1000).toISOString().split('T')[0],
        open: open[i], high: high[i], low: low[i],
        close: close[i], volume: volume[i]
      })).filter(d => d.close && d.close > 0);
    }
  } catch (e) { /* fallback */ }

  // Source 2: Yahoo v8 query2
  try {
    const sym = toYahooSymbol(symbol);
    const r = await axios.get(
      `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=3mo`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.yahoo.com' }, timeout: 10000 }
    );
    const result = r.data?.chart?.result?.[0];
    if (result?.timestamp?.length > 10) {
      const ts = result.timestamp;
      const { open, high, low, close, volume } = result.indicators.quote[0];
      return ts.map((t, i) => ({
        date: new Date(t * 1000).toISOString().split('T')[0],
        open: open[i], high: high[i], low: low[i],
        close: close[i], volume: volume[i]
      })).filter(d => d.close && d.close > 0);
    }
  } catch (e) { /* fallback */ }

  // Fallback: mock OHLC
  return generateMockOHLC(symbol, 90);
}

// ── Fetch Multiple Quotes ────────────────────────────────────
export async function fetchMultipleQuotes(symbols) {
  // Coba batch Yahoo dulu
  try {
    const syms = symbols.map(toYahooSymbol).join(',');
    const r = await axios.get(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${syms}`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, timeout: 10000 }
    );
    const quotes = r.data?.quoteResponse?.result || [];
    if (quotes.length > 0) {
      const mapped = quotes.map(q => ({
        symbol: q.symbol.replace('.JK', ''),
        name: q.longName || q.shortName || q.symbol,
        price: q.regularMarketPrice || 0,
        prev: q.regularMarketPreviousClose || 0,
        change: q.regularMarketChange || 0,
        changePct: q.regularMarketChangePercent || 0,
        open: q.regularMarketOpen || 0,
        high: q.regularMarketDayHigh || 0,
        low: q.regularMarketDayLow || 0,
        volume: q.regularMarketVolume || 0,
        marketCap: q.marketCap || 0,
        pe: q.trailingPE || null,
        fiftyTwoWeekHigh: q.fiftyTwoWeekHigh || null,
        fiftyTwoWeekLow: q.fiftyTwoWeekLow || null,
        source: 'yahoo_v7_batch'
      }));
      // Tambahkan yang tidak ada di hasil
      const found = new Set(mapped.map(m => m.symbol));
      for (const s of symbols) {
        if (!found.has(s)) mapped.push(mockQuote(s));
      }
      return mapped;
    }
  } catch (e) { /* fallback */ }

  // Fallback: fetch satu-satu
  const results = await Promise.allSettled(symbols.map(s => fetchQuote(s)));
  return results.map((r, i) => r.status === 'fulfilled' ? r.value : mockQuote(symbols[i]));
}

// ── Technical Indicators ─────────────────────────────────────
export function calcAllIndicators(ohlc) {
  if (!ohlc || ohlc.length < 26) return null;

  const closes = ohlc.map(d => d.close);
  const highs  = ohlc.map(d => d.high);
  const lows   = ohlc.map(d => d.low);
  const vols   = ohlc.map(d => d.volume || 0);

  // RSI 14
  const rsiArr = RSI.calculate({ values: closes, period: 14 });
  const rsi = rsiArr[rsiArr.length - 1];

  // MACD (12,26,9)
  const macdArr = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
  const macd = macdArr[macdArr.length - 1];

  // EMA 9, 20, 50
  const ema9  = EMA.calculate({ values: closes, period: 9  }).at(-1);
  const ema20 = EMA.calculate({ values: closes, period: 20 }).at(-1);
  const ema50 = closes.length >= 50 ? EMA.calculate({ values: closes, period: 50 }).at(-1) : null;

  // Bollinger Bands (20, 2)
  const bbArr = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
  const bb = bbArr[bbArr.length - 1];

  // ATR 14
  const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atr = atrArr[atrArr.length - 1];

  // Stochastic
  const stochArr = Stochastic.calculate({ high: highs, low: lows, close: closes, period: 14, signalPeriod: 3 });
  const stoch = stochArr[stochArr.length - 1];

  // VWAP (approx dari 20 hari terakhir)
  const vwap = calcVWAP(ohlc.slice(-20));

  // Support & Resistance
  const { support, resistance } = calcSupportResistance(ohlc);

  // Volume analysis
  const avgVol = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const lastVol = vols[vols.length - 1];
  const volSpike = lastVol > avgVol * 1.8;
  const volRatio = avgVol > 0 ? lastVol / avgVol : 1;

  // Momentum 10 hari
  const momentum10 = closes.length > 10
    ? ((closes[closes.length - 1] - closes[closes.length - 11]) / closes[closes.length - 11]) * 100
    : 0;

  // Trend berdasarkan EMA stack
  const trend = ema9 && ema20 && ema50
    ? (ema9 > ema20 && ema20 > ema50 ? 'BULLISH' : ema9 < ema20 && ema20 < ema50 ? 'BEARISH' : 'SIDEWAYS')
    : (ema9 && ema20 ? (ema9 > ema20 ? 'BULLISH' : 'BEARISH') : 'SIDEWAYS');

  return { rsi, macd, ema9, ema20, ema50, bb, atr, stoch, vwap, support, resistance, volSpike, volRatio, momentum10, trend, closes, highs, lows };
}

function calcVWAP(ohlc) {
  let sumTPV = 0, sumVol = 0;
  for (const d of ohlc) {
    const tp = (d.high + d.low + d.close) / 3;
    sumTPV += tp * (d.volume || 1);
    sumVol += (d.volume || 1);
  }
  return sumVol > 0 ? sumTPV / sumVol : null;
}

function calcSupportResistance(ohlc) {
  const recent = ohlc.slice(-30);
  const sortedHighs = recent.map(d => d.high).sort((a, b) => b - a);
  const sortedLows  = recent.map(d => d.low).sort((a, b) => a - b);
  const resistance = sortedHighs.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
  const support    = sortedLows.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
  return { support: Math.round(support), resistance: Math.round(resistance) };
}

// ── Entry / SL / TP Calculator ───────────────────────────────
export function calcEntryPlan(quote, indicators, riskProfile = 'moderate') {
  const price = quote.price;
  const atr   = indicators?.atr || price * 0.02;

  const m = {
    conservative: { sl: 1.0, tp1: 1.5, tp2: 2.5 },
    moderate:     { sl: 1.5, tp1: 2.0, tp2: 3.5 },
    aggressive:   { sl: 2.0, tp1: 3.0, tp2: 5.0 }
  }[riskProfile] || { sl: 1.5, tp1: 2.0, tp2: 3.5 };

  const stopLoss    = Math.round(price - atr * m.sl);
  const takeProfit1 = Math.round(price + atr * m.tp1);
  const takeProfit2 = Math.round(price + atr * m.tp2);
  const riskPct     = ((price - stopLoss) / price * 100).toFixed(2);
  const tp1Pct      = ((takeProfit1 - price) / price * 100).toFixed(2);
  const tp2Pct      = ((takeProfit2 - price) / price * 100).toFixed(2);
  const rr1         = (parseFloat(tp1Pct) / parseFloat(riskPct)).toFixed(1);

  return { price, stopLoss, takeProfit1, takeProfit2, riskPct, tp1Pct, tp2Pct, rr1, atr: Math.round(atr) };
}

// ── Scalping Signal Scorer ───────────────────────────────────
export function scoreScalping(quote, indicators) {
  let score = 0;
  const reasons = [];
  const { rsi, macd, ema9, ema20, ema50, bb, volSpike, volRatio, momentum10, trend, vwap } = indicators;
  const price = quote.price;

  if (ema9 && ema20) {
    if (ema9 > ema20 && (!ema50 || ema20 > ema50)) { score += 20; reasons.push('✅ EMA Bullish Stack'); }
    else if (ema9 < ema20 && (!ema50 || ema20 < ema50)) { score -= 15; reasons.push('❌ EMA Bearish Stack'); }
    else reasons.push('⚠️ EMA Mixed/Sideways');
  }
  if (ema9) {
    if (price > ema9) { score += 10; reasons.push('✅ Harga > EMA9'); }
    else { score -= 8; reasons.push('❌ Harga < EMA9'); }
  }
  if (rsi !== undefined) {
    if (rsi >= 40 && rsi <= 60)       { score += 15; reasons.push(`✅ RSI ${rsi.toFixed(1)} zona ideal`); }
    else if (rsi < 30)                { score += 10; reasons.push(`⚠️ RSI ${rsi.toFixed(1)} oversold`); }
    else if (rsi > 70)                { score -= 15; reasons.push(`❌ RSI ${rsi.toFixed(1)} overbought`); }
    else                               { reasons.push(`ℹ️ RSI ${rsi.toFixed(1)}`); }
  }
  if (macd) {
    if (macd.histogram > 0 && macd.MACD > macd.signal) { score += 15; reasons.push('✅ MACD Bullish'); }
    else if (macd.histogram < 0)                        { score -= 10; reasons.push('❌ MACD Negatif'); }
  }
  if (volSpike)  { score += 15; reasons.push(`✅ Volume Spike ${(volRatio||1).toFixed(1)}x`); }
  else             { reasons.push(`ℹ️ Volume normal (${(volRatio||1).toFixed(1)}x)`); }
  if (bb && price) {
    if (price < bb.lower)  { score += 10; reasons.push('✅ Di bawah BB Lower (bounce?)'); }
    else if (price > bb.upper) { score -= 10; reasons.push('❌ Di atas BB Upper'); }
  }
  if (vwap && price) {
    if (price > vwap) { score += 8; reasons.push('✅ Di atas VWAP'); }
    else              { score -= 5; reasons.push('❌ Di bawah VWAP'); }
  }
  if (momentum10 > 2)       { score += 7; reasons.push(`✅ Momentum +${momentum10.toFixed(2)}%`); }
  else if (momentum10 < -2) { score -= 7; reasons.push(`❌ Momentum ${momentum10.toFixed(2)}%`); }

  const total  = Math.min(100, Math.max(0, score + 20));
  const signal = total >= 70 ? 'BELI' : total >= 50 ? 'NETRAL' : 'JUAL/HINDARI';
  return { score: total, reasons, signal, trend };
}

// ── Mock Data (fallback) ─────────────────────────────────────
function mockQuote(symbol) {
  const prices = {
    BBCA:9850, BBRI:4890, TLKM:3450, ASII:4750, BMRI:6125,
    GOTO:87, ANTM:1620, PTBA:2890, ADRO:2350, PTRO:2100,
    INDF:6750, ICBP:9450, UNVR:2580, PGAS:1580, TOWR:1255,
    BREN:12400, MEDC:1340, ELSA:580, INCO:3870, ITMG:24500
  };
  const base = prices[symbol] || 2000;
  const chg = (Math.random() - 0.5) * base * 0.04;
  return {
    symbol, name: symbol + ' (Demo)',
    price: base, prev: base - chg, change: chg,
    changePct: (chg / base) * 100,
    open: base, high: base * 1.02, low: base * 0.98,
    volume: 10_000_000, marketCap: 0,
    pe: 15, eps: 0,
    fiftyTwoWeekHigh: base * 1.3, fiftyTwoWeekLow: base * 0.7,
    source: 'demo'
  };
}

function generateMockOHLC(symbol, days) {
  const prices = {
    BBCA:9850, BBRI:4890, TLKM:3450, ASII:4750, BMRI:6125,
    PTRO:2100, GOTO:87, ANTM:1620, ADRO:2350, PTBA:2890
  };
  let p = prices[symbol] || 2000;
  const out = [];
  const today = new Date();
  for (let i = days; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const chg = (Math.random() - 0.48) * p * 0.025;
    const open = p, close = p + chg;
    out.push({
      date: d.toISOString().split('T')[0],
      open, high: Math.max(open, close) * (1 + Math.random() * 0.01),
      low: Math.min(open, close) * (1 - Math.random() * 0.01),
      close, volume: Math.floor(Math.random() * 30_000_000 + 1_000_000)
    });
    p = close;
  }
  return out;
}
