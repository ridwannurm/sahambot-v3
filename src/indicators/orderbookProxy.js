// src/indicators/orderbookProxy.js
// Proxy Orderbook dari OHLCV: Volume Pressure, OBV, CMF, Large Order, Price Flow

const r2 = n => Math.round((n||0)*100)/100;

// ── 1. Volume Pressure (Close Position Ratio) ─────────────────
function calcVolumePressure(ohlc, period=10) {
  const recent = ohlc.slice(-period);
  let buyVol=0, sellVol=0, totalVol=0;
  for (const d of recent) {
    const range = d.high - d.low || 1;
    const cpr   = (d.close - d.low) / range; // 1=full buy, 0=full sell
    buyVol  += d.volume * cpr;
    sellVol += d.volume * (1 - cpr);
    totalVol += d.volume;
  }
  const buyPct  = totalVol > 0 ? r2(buyVol/totalVol*100) : 50;
  const sellPct = totalVol > 0 ? r2(sellVol/totalVol*100) : 50;
  return { buyPct, sellPct, ratio: r2(buyVol/(sellVol||1)), dominance: buyPct>sellPct?'BUY':'SELL' };
}

// ── 2. OBV + CMF + Up/Down Days ──────────────────────────────
function calcPriceFlow(ohlc, period=14) {
  const recent = ohlc.slice(-period);
  if (recent.length < 5) return null;

  let obv=0, upVol=0, downVol=0, upDays=0, downDays=0;
  let cmfN=0, cmfD=0;
  const obvArr = [];

  for (let i=1; i<recent.length; i++) {
    const d=recent[i], prev=recent[i-1];
    // OBV
    if (d.close > prev.close) { obv += d.volume; upVol += d.volume; upDays++; }
    else if (d.close < prev.close) { obv -= d.volume; downVol += d.volume; downDays++; }
    obvArr.push(obv);
    // CMF
    const range = d.high - d.low || 1;
    cmfN += ((d.close-d.low)-(d.high-d.close))/range * d.volume;
    cmfD += d.volume;
  }

  const cmf      = cmfD > 0 ? r2(cmfN/cmfD) : 0;
  const obvTrend = obvArr.length>=3 ? (obvArr.at(-1)>obvArr[0]?'UP':'DOWN') : 'FLAT';
  const totalVol = upVol+downVol||1;

  return {
    upDays, downDays,
    upVolPct:  r2(upVol/totalVol*100),
    downVolPct:r2(downVol/totalVol*100),
    obvTrend, cmf,
    isAccumulation: upVol>downVol && obvTrend==='UP' && cmf>0.05,
    isDistribution: downVol>upVol && obvTrend==='DOWN' && cmf<-0.05,
  };
}

// ── 3. Large Order Detection (2 std dev) ─────────────────────
function detectLargeOrders(ohlc, period=20) {
  const recent = ohlc.slice(-period);
  const vols   = recent.map(d=>d.volume);
  const avg    = vols.reduce((a,b)=>a+b,0)/vols.length;
  const std    = Math.sqrt(vols.reduce((a,b)=>a+Math.pow(b-avg,2),0)/vols.length);
  const thresh = avg + 2*std;
  const last   = recent.at(-1);
  const isSpike = last.volume > thresh;
  return {
    avgVolume:  Math.round(avg),
    isSpike,
    direction:  isSpike ? (last.close>=last.open?'BUY':'SELL') : null,
    ratio:      r2(last.volume/(avg||1)),
    spikeCount: recent.filter(d=>d.volume>thresh).length,
  };
}

// ── 4. Candle Net Pressure (last 3 candles) ───────────────────
function calcCandlePressure(ohlc) {
  const last3 = ohlc.slice(-3);
  let netPressure = 0;
  for (const d of last3) {
    const range     = d.high-d.low||1;
    const body      = Math.abs(d.close-d.open);
    const isBull    = d.close >= d.open;
    const upperWick = d.high - Math.max(d.close,d.open);
    const lowerWick = Math.min(d.close,d.open) - d.low;
    const bp = (isBull?body/range:0) + (lowerWick/range)*0.5;
    const sp = (!isBull?body/range:0) + (upperWick/range)*0.5;
    netPressure += bp - sp;
  }
  return r2(netPressure / last3.length);
}

// ── MASTER: Full Orderbook Proxy ─────────────────────────────
export function analyzeOrderbookProxy(quote, ohlc) {
  if (!ohlc || ohlc.length < 10) return null;

  const vp   = calcVolumePressure(ohlc, 10);
  const pf   = calcPriceFlow(ohlc, 14);
  const lo   = detectLargeOrders(ohlc, 20);
  const cp   = calcCandlePressure(ohlc);

  let buyScore=0, sellScore=0;
  const insights = [];

  // Volume pressure (0-25 pts)
  if (vp.buyPct > 60)       { buyScore  += 25; insights.push(`Volume beli dominan ${vp.buyPct}% (${vp.ratio.toFixed(1)}x vs jual)`); }
  else if (vp.sellPct > 60) { sellScore += 25; insights.push(`Volume jual dominan ${vp.sellPct}% — tekanan jual kuat`); }
  else                       { insights.push(`Volume seimbang: beli ${vp.buyPct}% vs jual ${vp.sellPct}%`); }

  // Price flow — OBV & CMF (0-30 pts)
  if (pf) {
    if (pf.isAccumulation)       { buyScore  += 30; insights.push(`AKUMULASI: OBV naik, CMF +${pf.cmf.toFixed(2)} (uang masuk)`); }
    else if (pf.isDistribution)  { sellScore += 30; insights.push(`DISTRIBUSI: OBV turun, CMF ${pf.cmf.toFixed(2)} (uang keluar)`); }
    else if (pf.cmf > 0.02)      { buyScore  += 10; insights.push(`CMF positif ${pf.cmf.toFixed(2)} — lebih banyak uang masuk`); }
    else if (pf.cmf < -0.02)     { sellScore += 10; insights.push(`CMF negatif ${pf.cmf.toFixed(2)} — lebih banyak uang keluar`); }
    else                          { insights.push(`CMF netral ${pf.cmf.toFixed(2)} | OBV: ${pf.obvTrend}`); }

    if (pf.upDays > pf.downDays) { buyScore  += 5; }
    else if (pf.downDays > pf.upDays) { sellScore += 5; }
  }

  // Large order (0-20 pts)
  if (lo.isSpike) {
    if (lo.direction === 'BUY')  { buyScore  += 20; insights.push(`Large BUY ORDER terdeteksi — volume ${lo.ratio.toFixed(1)}x rata-rata`); }
    else                          { sellScore += 20; insights.push(`Large SELL ORDER terdeteksi — volume ${lo.ratio.toFixed(1)}x rata-rata`); }
  }

  // Candle pressure (0-15 pts)
  if (cp > 0.2)       { buyScore  += 15; insights.push(`Candle 3 hari terakhir: tekanan beli kuat (${cp.toFixed(2)})`); }
  else if (cp < -0.2) { sellScore += 15; insights.push(`Candle 3 hari terakhir: tekanan jual kuat (${cp.toFixed(2)})`); }

  // Verdict
  const total    = buyScore+sellScore||1;
  const buyPct   = r2(buyScore/total*100);
  const sellPct  = r2(sellScore/total*100);
  let verdict='Netral', strength='Lemah';
  if (buyPct >= 70)       { verdict='Banyak DIBELI';   strength = buyPct>=85?'Kuat':'Sedang'; }
  else if (sellPct >= 70) { verdict='Banyak DIJUAL';   strength = sellPct>=85?'Kuat':'Sedang'; }
  else if (buyPct > 55)   { verdict='Cenderung Beli';  strength='Lemah'; }
  else if (sellPct > 55)  { verdict='Cenderung Jual';  strength='Lemah'; }

  return {
    vp, pf, lo, cp,
    buyPct, sellPct, buyScore, sellScore,
    verdict, strength,
    insights: insights.slice(0,4),
    isAccumulation: pf?.isAccumulation || false,
    isDistribution: pf?.isDistribution || false,
    hasLargeOrder:  lo.isSpike,
    largeOrderDir:  lo.direction,
  };
}

// ── Format untuk AI prompt ────────────────────────────────────
export function formatOrderbookForAI(ob) {
  if (!ob) return 'Orderbook proxy tidak tersedia.';
  const {vp, pf, lo, verdict, strength, buyPct, sellPct, insights} = ob;
  return `ORDERBOOK PROXY:
Verdict: ${verdict} (${strength}) | Beli ${buyPct}% vs Jual ${sellPct}%
Volume Flow: Beli ${vp.buyPct}% | Jual ${vp.sellPct}% | Rasio ${vp.ratio}x
OBV Trend: ${pf?.obvTrend||'N/A'} | CMF: ${pf?.cmf?.toFixed(3)||'N/A'} ${pf?.cmf>0?'(uang masuk)':'(uang keluar)'}
Hari naik: ${pf?.upDays||0} | Hari turun: ${pf?.downDays||0}
Akumulasi: ${ob.isAccumulation?'YA':'Tidak'} | Distribusi: ${ob.isDistribution?'YA':'Tidak'}
Large Order: ${lo.isSpike?'YA - '+lo.direction+' ('+lo.ratio.toFixed(1)+'x)':'Tidak'}
Insights: ${insights.join(' | ')}`;
}

// ── Format untuk Telegram ─────────────────────────────────────
export function formatOrderbookTelegram(ob, symbol='') {
  if (!ob) return '';
  const {vp, pf, lo, verdict, strength, buyPct, sellPct, insights, isAccumulation, isDistribution} = ob;

  // Bar chart beli vs jual
  const bBars = Math.round(buyPct/10);
  const bar   = '[' + '#'.repeat(bBars) + '.'.repeat(10-bBars) + ']';

  let t = `Orderbook Proxy ${symbol}:\n`;
  t += `${bar}\n`;
  t += `Beli: ${buyPct}%  Jual: ${sellPct}%\n`;
  t += `Verdict: ${verdict} (${strength})\n\n`;
  t += `Volume Flow (10 hari):\n`;
  t += `Beli ${vp.buyPct}% vs Jual ${vp.sellPct}% | Rasio ${vp.ratio}x\n\n`;
  if (pf) {
    t += `Price Action (14 hari):\n`;
    t += `OBV: ${pf.obvTrend} | CMF: ${pf.cmf.toFixed(3)} ${pf.cmf>0?'(masuk)':'(keluar)'}\n`;
    t += `Naik ${pf.upDays}h (${pf.upVolPct}% vol) vs Turun ${pf.downDays}h (${pf.downVolPct}% vol)\n`;
    if (isAccumulation) t += `AKUMULASI terdeteksi\n`;
    if (isDistribution) t += `DISTRIBUSI terdeteksi\n`;
    t += '\n';
  }
  if (lo.isSpike) {
    t += `Large Order: ${lo.direction} terdeteksi (${lo.ratio.toFixed(1)}x avg vol)\n`;
    t += `Spike dalam 20 hari: ${lo.spikeCount} kali\n\n`;
  }
  t += `Insights:\n`;
  insights.forEach((s,i) => { t += `${i+1}. ${s}\n`; });
  return t;
}

// ── Alias exports untuk kompatibilitas ───────────────────────
export const buildOrderbookInsight = analyzeOrderbookProxy;
export const formatOrderbookInsight = formatOrderbookTelegram;
