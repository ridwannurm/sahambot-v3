// src/indicators/orderbookProxy.js
// Estimasi tekanan beli/jual dari data OHLCV
// Metode: Money Flow Index, Volume Delta, CVD, Price Action Analysis

// ── 1. Money Flow Index (MFI) ─────────────────────────────────
// Mengukur aliran uang masuk vs keluar — lebih baik dari RSI karena include volume
export function calcMFI(ohlc, period = 14) {
  if (ohlc.length < period + 1) return null;
  const slice = ohlc.slice(-(period + 1));

  let posFlow = 0, negFlow = 0;
  let prevTP = (slice[0].high + slice[0].low + slice[0].close) / 3;

  for (let i = 1; i < slice.length; i++) {
    const tp  = (slice[i].high + slice[i].low + slice[i].close) / 3;
    const rmf = tp * (slice[i].volume || 1); // Raw Money Flow
    if (tp > prevTP)      posFlow += rmf;
    else if (tp < prevTP) negFlow += rmf;
    prevTP = tp;
  }

  if (negFlow === 0) return 100;
  const mfr = posFlow / negFlow;
  return 100 - (100 / (1 + mfr));
}

// ── 2. Volume Delta (Estimasi Buy vs Sell Volume) ─────────────
// Candle bullish → lebih banyak buy pressure
// Candle bearish → lebih banyak sell pressure
export function calcVolumeDelta(ohlc, lookback = 20) {
  const slice = ohlc.slice(-lookback);
  let totalBuy = 0, totalSell = 0, totalVol = 0;
  const candles = [];

  for (const c of slice) {
    const body   = Math.abs(c.close - c.open);
    const range  = c.high - c.low || 1;
    const vol    = c.volume || 0;

    // Estimasi buy/sell volume dari posisi close dalam range candle
    // Close dekat high = lebih banyak beli, close dekat low = lebih banyak jual
    const closePos = range > 0 ? (c.close - c.low) / range : 0.5;
    const buyVol   = vol * closePos;
    const sellVol  = vol * (1 - closePos);

    totalBuy  += buyVol;
    totalSell += sellVol;
    totalVol  += vol;

    candles.push({
      date:    c.date,
      buyVol:  Math.round(buyVol),
      sellVol: Math.round(sellVol),
      delta:   buyVol - sellVol,
      isBull:  c.close >= c.open,
      closePos: closePos.toFixed(2)
    });
  }

  const cumDelta   = totalBuy - totalSell;
  const buyPct     = totalVol > 0 ? (totalBuy / totalVol * 100) : 50;
  const sellPct    = 100 - buyPct;
  const pressure   = buyPct > 55 ? 'BUY DOMINANT' : buyPct < 45 ? 'SELL DOMINANT' : 'BALANCED';

  return {
    totalBuy:  Math.round(totalBuy),
    totalSell: Math.round(totalSell),
    cumDelta:  Math.round(cumDelta),
    buyPct:    buyPct.toFixed(1),
    sellPct:   sellPct.toFixed(1),
    pressure,
    candles:   candles.slice(-5), // 5 candle terakhir
    trend:     cumDelta > 0 ? 'ACCUMULATION' : 'DISTRIBUTION'
  };
}

// ── 3. Cumulative Volume Delta (CVD) ──────────────────────────
// Tracking akumulasi delta volume dari waktu ke waktu
export function calcCVD(ohlc, lookback = 30) {
  const slice = ohlc.slice(-lookback);
  let cvd = 0;
  const cvdHistory = [];

  for (const c of slice) {
    const range  = c.high - c.low || 1;
    const vol    = c.volume || 0;
    const closeP = (c.close - c.low) / range;
    const delta  = vol * (2 * closeP - 1); // -1 to +1
    cvd += delta;
    cvdHistory.push(Math.round(cvd));
  }

  // CVD trend: rising = net buying, falling = net selling
  const first5  = cvdHistory.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
  const last5   = cvdHistory.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const cvdTrend = last5 > first5 * 1.05 ? 'RISING' : last5 < first5 * 0.95 ? 'FALLING' : 'FLAT';

  return {
    currentCVD: Math.round(cvd),
    cvdTrend,
    history: cvdHistory,
    interpretation: cvdTrend === 'RISING'
      ? 'Net buying pressure meningkat'
      : cvdTrend === 'FALLING'
        ? 'Net selling pressure meningkat'
        : 'Tekanan beli/jual seimbang'
  };
}

// ── 4. Large Trade Detection (Smart Money Footprint) ──────────
// Volume bar jauh di atas rata-rata = kemungkinan institutional activity
export function detectLargeTrades(ohlc, multiplier = 2.5) {
  if (ohlc.length < 10) return { events: [], count: 0 };

  const avgVol = ohlc.slice(-20).reduce((a, b) => a + (b.volume || 0), 0) / 20;
  const events = [];

  for (const c of ohlc.slice(-10)) {
    if ((c.volume || 0) > avgVol * multiplier) {
      const range   = c.high - c.low || 1;
      const closeP  = (c.close - c.low) / range;
      const type    = closeP > 0.6 ? 'LARGE BUY' : closeP < 0.4 ? 'LARGE SELL' : 'LARGE NEUTRAL';
      const ratio   = ((c.volume || 0) / avgVol).toFixed(1);

      events.push({
        date:   c.date,
        volume: c.volume,
        type,
        ratio,
        price:  c.close,
        closePos: (closeP * 100).toFixed(0) + '%'
      });
    }
  }

  return {
    events,
    count:          events.length,
    hasLargeBuy:    events.some(e => e.type === 'LARGE BUY'),
    hasLargeSell:   events.some(e => e.type === 'LARGE SELL'),
    lastEvent:      events[events.length - 1] || null
  };
}

// ── 5. Bid/Ask Spread Proxy (dari High-Low & Close-Open) ──────
export function calcBidAskProxy(quote) {
  if (!quote?.price) return null;
  const price    = quote.price;
  const bid      = quote.bid  || 0;
  const ask      = quote.ask  || 0;
  const bidAsk   = (bid > 0 && ask > 0) ? ask - bid : null;
  const bidAskPct = bidAsk ? (bidAsk / price * 100).toFixed(3) : null;

  // Proxy spread dari intraday range
  const range    = (quote.high || price) - (quote.low || price);
  const rangeP   = (range / price * 100).toFixed(2);

  // Close position dalam range hari ini
  const closePos = range > 0
    ? ((price - (quote.low || price)) / range * 100).toFixed(1)
    : 50;

  let pressure = 'Netral';
  if (parseFloat(closePos) > 60)       pressure = 'Tekanan Beli (close di atas 60% range)';
  else if (parseFloat(closePos) < 40)  pressure = 'Tekanan Jual (close di bawah 40% range)';

  return {
    bid:        bid || null,
    ask:        ask || null,
    spread:     bidAsk,
    spreadPct:  bidAskPct,
    rangeToday: range,
    rangePct:   rangeP,
    closePos,
    pressure,
    hasBidAsk:  bid > 0 && ask > 0
  };
}

// ── 6. Master Orderbook Insight ───────────────────────────────
export function buildOrderbookInsight(quote, ohlc) {
  if (!ohlc || ohlc.length < 15) return null;

  const mfi          = calcMFI(ohlc);
  const volumeDelta  = calcVolumeDelta(ohlc, 20);
  const cvd          = calcCVD(ohlc, 30);
  const largeTrades  = detectLargeTrades(ohlc, 2.5);
  const bidAsk       = calcBidAskProxy(quote);

  // Overall signal
  let buySignals  = 0, sellSignals = 0;
  const insights  = [];

  // MFI
  if (mfi !== null) {
    if (mfi > 60) { buySignals++;  insights.push(`MFI ${mfi.toFixed(0)}: aliran uang masuk kuat`); }
    if (mfi < 40) { sellSignals++; insights.push(`MFI ${mfi.toFixed(0)}: aliran uang keluar kuat`); }
    if (mfi > 80) { buySignals++;  insights.push(`MFI ${mfi.toFixed(0)}: overbought — hati-hati distribusi`); }
    if (mfi < 20) { buySignals++;  insights.push(`MFI ${mfi.toFixed(0)}: oversold — potensi reversal`); }
  }

  // Volume Delta
  if (parseFloat(volumeDelta.buyPct) > 55) {
    buySignals++;
    insights.push(`Buy ${volumeDelta.buyPct}% > Sell ${volumeDelta.sellPct}% — dominan beli`);
  } else if (parseFloat(volumeDelta.buyPct) < 45) {
    sellSignals++;
    insights.push(`Sell ${volumeDelta.sellPct}% > Buy ${volumeDelta.buyPct}% — dominan jual`);
  } else {
    insights.push(`Buy ${volumeDelta.buyPct}% vs Sell ${volumeDelta.sellPct}% — seimbang`);
  }

  // CVD
  if (cvd.cvdTrend === 'RISING')  { buySignals++;  insights.push(`CVD naik — akumulasi berlanjut`); }
  if (cvd.cvdTrend === 'FALLING') { sellSignals++; insights.push(`CVD turun — distribusi berlanjut`); }

  // Large trades
  if (largeTrades.hasLargeBuy) {
    buySignals++;
    const ev = largeTrades.events.filter(e => e.type === 'LARGE BUY').pop();
    insights.push(`Large buy ${ev?.ratio}x avg vol @ Rp ${Math.round(ev?.price || 0).toLocaleString('id-ID')}`);
  }
  if (largeTrades.hasLargeSell) {
    sellSignals++;
    const ev = largeTrades.events.filter(e => e.type === 'LARGE SELL').pop();
    insights.push(`Large sell ${ev?.ratio}x avg vol @ Rp ${Math.round(ev?.price || 0).toLocaleString('id-ID')}`);
  }

  // Bid/Ask proxy
  if (bidAsk?.pressure !== 'Netral') {
    if (bidAsk.pressure.includes('Beli')) buySignals++;
    else sellSignals++;
    insights.push(bidAsk.pressure);
  }

  // Overall bias
  let overallBias, biasStrength;
  if (buySignals > sellSignals + 1) {
    overallBias   = 'BELI DOMINAN';
    biasStrength  = buySignals >= 3 ? 'KUAT' : 'SEDANG';
  } else if (sellSignals > buySignals + 1) {
    overallBias   = 'JUAL DOMINAN';
    biasStrength  = sellSignals >= 3 ? 'KUAT' : 'SEDANG';
  } else {
    overallBias   = 'SEIMBANG';
    biasStrength  = 'LEMAH';
  }

  return {
    mfi,
    volumeDelta,
    cvd,
    largeTrades,
    bidAsk,
    buySignals,
    sellSignals,
    overallBias,
    biasStrength,
    insights: insights.slice(0, 5)
  };
}

// ── Format untuk output ───────────────────────────────────────
export function formatOrderbookInsight(ob, plain = true) {
  if (!ob) return 'Data tidak cukup untuk orderbook proxy.';

  const biasIcon = ob.overallBias === 'BELI DOMINAN' ? 'BELI' :
                   ob.overallBias === 'JUAL DOMINAN' ? 'JUAL' : 'SEIMBANG';

  let text = `Orderbook Proxy:\n\n`;
  text += `Bias   : ${biasIcon} (${ob.biasStrength})\n`;
  text += `Buy    : ${ob.buySignals} sinyal | Sell: ${ob.sellSignals} sinyal\n\n`;

  if (ob.mfi !== null) {
    text += `MFI (Money Flow Index): ${ob.mfi.toFixed(1)}\n`;
    text += `  ${ob.mfi > 60 ? 'Uang mengalir MASUK' : ob.mfi < 40 ? 'Uang mengalir KELUAR' : 'Aliran uang normal'}\n\n`;
  }

  text += `Volume Delta (${ob.volumeDelta.lookback || 20} candle terakhir):\n`;
  text += `  Buy Vol : ${ob.volumeDelta.buyPct}%\n`;
  text += `  Sell Vol: ${ob.volumeDelta.sellPct}%\n`;
  text += `  Dominan : ${ob.volumeDelta.pressure}\n\n`;

  text += `CVD (Cumulative Volume Delta):\n`;
  text += `  Trend: ${ob.cvd.cvdTrend}\n`;
  text += `  ${ob.cvd.interpretation}\n\n`;

  if (ob.largeTrades.count > 0) {
    text += `Large Trade Detection (${ob.largeTrades.count} event):\n`;
    for (const e of ob.largeTrades.events.slice(-3)) {
      text += `  ${e.type} @ Rp ${Math.round(e.price).toLocaleString('id-ID')} (${e.ratio}x vol, close di ${e.closePos} range)\n`;
    }
    text += '\n';
  }

  if (ob.bidAsk?.hasBidAsk) {
    text += `Bid/Ask Real:\n`;
    text += `  Bid: Rp ${Math.round(ob.bidAsk.bid).toLocaleString('id-ID')} | Ask: Rp ${Math.round(ob.bidAsk.ask).toLocaleString('id-ID')}\n`;
    text += `  Spread: ${ob.bidAsk.spreadPct}%\n\n`;
  }

  if (ob.bidAsk) {
    text += `Posisi Close (hari ini): ${ob.bidAsk.closePos}% dalam range\n`;
    text += `${ob.bidAsk.pressure}\n\n`;
  }

  text += `Insight:\n`;
  for (const ins of ob.insights) {
    text += `- ${ins}\n`;
  }

  return text;
}
