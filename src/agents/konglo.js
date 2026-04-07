// src/agents/konglo.js — Konglomerat Analyzer v3
// Sumber data: Excel (wajib) + Yahoo Finance (market data)
// ARB: Fix 15% untuk semua saham

import { getKongloData } from '../db/excelLoader.js';
import { getSahamByKonglo, listAllKonglo, getCrossOwnership, getStats } from '../db/kongloData.js';
import { fetchMultipleQuotes, fetchOHLC, calcAllIndicators, calcEntryPlan, scoreScalping } from '../indicators/market.js';
import { buildOrderbookInsight } from '../indicators/orderbookProxy.js';

const fmt    = n => (n !== null && n !== undefined && !isNaN(n)) ? Math.round(n).toLocaleString('id-ID') : 'Data tidak tersedia';
const fmtPct = n => n !== null && n !== undefined ? (n >= 0 ? '+' : '') + parseFloat(n).toFixed(2) + '%' : 'N/A';
const trunc  = (t, max = 4000) => t.length > max ? t.slice(0, max) + '\n...(terpotong)' : t;

// ── ARB Fix 15% ──────────────────────────────────────────────
export function calcARB(prevClose) {
  if (!prevClose || prevClose <= 0) return null;
  let tick = 1;
  if (prevClose >= 200  && prevClose < 500)  tick = 2;
  if (prevClose >= 500  && prevClose < 2000) tick = 5;
  if (prevClose >= 2000 && prevClose < 5000) tick = 10;
  if (prevClose >= 5000)                     tick = 25;
  return Math.floor(prevClose * 0.85 / tick) * tick;
}

// ── ARA (sesuai rentang harga IDX) ──────────────────────────
export function calcARA(prevClose) {
  if (!prevClose || prevClose <= 0) return null;
  let tick = 1, pct = 0.35;
  if (prevClose >= 200  && prevClose < 500)  { tick = 2;  pct = 0.35; }
  if (prevClose >= 500  && prevClose < 5000) { tick = 5;  pct = 0.25; }
  if (prevClose >= 5000)                     { tick = 25; pct = 0.20; }
  return Math.floor(prevClose * (1 + pct) / tick) * tick;
}

// ── Orderbook Proxy ──────────────────────────────────────────
function analyzeOrderbook(quote, indicators) {
  if (!indicators || !quote?.price) return null;
  const { rsi, macd, volRatio, ema9, ema20, momentum10 } = indicators;
  const price = quote.price;
  const open  = quote.open || price;
  const high  = quote.high || price;
  const low   = quote.low  || price;

  const body      = Math.abs(price - open);
  const range     = high - low || 1;
  const candleStr = ((body / range) * 100).toFixed(0);
  const isBull    = price >= open;
  const chgPct    = quote.changePct || 0;

  const signals = [];
  let akumulasi = false, distribusi = false;

  // Volume spike
  if (volRatio > 2.0 && isBull  && chgPct > 0) { akumulasi = true;  signals.push('📊 Volume spike + candle naik → Akumulasi'); }
  if (volRatio > 2.0 && !isBull && chgPct < 0) { distribusi = true; signals.push('📊 Volume spike + candle turun → Distribusi'); }
  if (volRatio > 1.5 && !akumulasi && !distribusi) signals.push(`📊 Volume ${volRatio.toFixed(1)}x rata-rata`);

  // EMA
  if (ema9 && ema20) {
    if (ema9 > ema20 && price > ema9)  signals.push('📈 EMA bullish stack');
    if (ema9 < ema20 && price < ema9)  signals.push('📉 EMA bearish stack');
  }

  // RSI
  if (rsi < 35)      signals.push(`⚡ RSI ${rsi.toFixed(0)} oversold`);
  else if (rsi > 65) signals.push(`⚡ RSI ${rsi.toFixed(0)} overbought`);

  // MACD
  if (macd?.histogram > 0) signals.push('✅ MACD positif');
  else if (macd?.histogram < 0) signals.push('⚠️ MACD negatif');

  // Bias
  let bias = '🟡 Sideways';
  const bullScore = (isBull?1:0) + (ema9>ema20?1:0) + (rsi<55?1:0) + (macd?.histogram>0?1:0) + (akumulasi?2:0);
  const bearScore = (!isBull?1:0) + (ema9<ema20?1:0) + (rsi>55?1:0) + (macd?.histogram<0?1:0) + (distribusi?2:0);
  if (bullScore > bearScore + 1) bias = '🚀 Bullish';
  else if (bearScore > bullScore + 1) bias = '🔻 Bearish';

  return { akumulasi, distribusi, bias, signals: signals.slice(0, 3), candleStr, isBull, volRatio: volRatio?.toFixed(1) || '1.0' };
}

// ── Smart Money: Pergerakan Serentak ─────────────────────────
function detectSmartMoney(results) {
  const valid = results.filter(r => r.quote?.price > 0);
  const naik  = valid.filter(r => (r.quote?.changePct || 0) > 1.5);
  const turun = valid.filter(r => (r.quote?.changePct || 0) < -1.5);

  if (naik.length >= 2 && naik.length >= turun.length) {
    return {
      type: 'AKUMULASI', icon: '⚡',
      label: `Pergerakan Serentak BULLISH (${naik.length} saham)`,
      keyakinan: naik.length >= 3 ? '🔥 Keyakinan Tinggi' : '📊 Sinyal Sedang',
      saham: naik.map(r => r.kode),
      detail: `${naik.length} dari ${valid.length} saham konglo naik >1.5%`
    };
  }
  if (turun.length >= 2 && turun.length > naik.length) {
    return {
      type: 'DISTRIBUSI', icon: '🔻',
      label: `Pergerakan Serentak BEARISH (${turun.length} saham)`,
      keyakinan: turun.length >= 3 ? '🔥 Fase Distribusi Kuat' : '📊 Sinyal Distribusi',
      saham: turun.map(r => r.kode),
      detail: `${turun.length} dari ${valid.length} saham konglo turun >1.5%`
    };
  }
  return null;
}

// ── Main: Analisis Satu Konglo ────────────────────────────────
export async function analyzeKonglo(query) {
  const { data, reverseIndex, source, stats } = await getKongloData();

  // Cari konglo
  const konglo = getSahamByKonglo(query);
  if (!konglo) {
    const list = listAllKonglo().map(k => `• /konglo ${k.key} — ${k.nama} (${k.jumlahSaham} saham)`).join('\n');
    return { error: `Konglo "${query}" tidak ditemukan.\n\nTersedia ${stats.totalKonglo} konglomerat:\n${list}` };
  }

  const symbols = konglo.saham.map(s => s.kode);

  // Fetch semua data pasar dari Yahoo Finance
  const quotes = await fetchMultipleQuotes(symbols);

  // Analisis per saham
  const sahamResults = await Promise.all(
    konglo.saham.map(async (saham, i) => {
      const quote = quotes[i] || {};
      let indicators = null, orderbook = null;

      let entry = null, score = 0, signal = 'NETRAL', orderbookInsight = null;
      try {
        const ohlc = await fetchOHLC(saham.kode, '3mo');
        indicators = calcAllIndicators(ohlc);
        orderbook  = analyzeOrderbook(quote, indicators);
        orderbookInsight = buildOrderbookInsight(quote, ohlc);
        if (indicators && quote.price > 0) {
          entry = calcEntryPlan(quote, indicators, 'moderate');
          const sc = scoreScalping(quote, indicators);
          score  = sc.score;
          signal = sc.signal;
        }
      } catch {}

      const prev = quote.prev || quote.price || 0;
      const arb  = calcARB(prev);
      const ara  = calcARA(prev);

      return {
        kode: saham.kode, nama: saham.nama,
        sektor: saham.sektor, pct: saham.pct,
        quote, indicators, orderbook, orderbookInsight, entry, score, signal,
        arb, ara, prev,
        distToArb: (arb && quote.price) ? ((quote.price - arb) / quote.price * 100).toFixed(2) : null,
        distToAra: (ara && quote.price) ? ((ara - quote.price) / quote.price * 100).toFixed(2) : null,
        isKonglo: true,
        multiKonglo: (reverseIndex[saham.kode] || []).length > 1
      };
    })
  );

  // Cross ownership
  const crossOwned = sahamResults
    .filter(r => r.multiKonglo)
    .map(r => ({
      kode: r.kode,
      owners: (reverseIndex[r.kode] || []).map(o => o.kongloKey)
    }));

  // Smart money
  const smartMoney = detectSmartMoney(sahamResults);

  return {
    kongloKey: konglo.key, konglo,
    sahamResults, smartMoney, crossOwned,
    dataSource: source, stats
  };
}

// ── Format Output Telegram (plain text, no markdown) ──────────
export function formatKongloTelegram(result) {
  if (result.error) return result.error;
  const { konglo, sahamResults, smartMoney, crossOwned, dataSource } = result;

  let text = '';

  // Header — plain text, no markdown
  text += `🏦 ${konglo.nama}\n`;
  text += `👤 ${konglo.pemilik}\n`;
  text += `${sahamResults.length} emiten | Sumber: ${dataSource === 'excel' ? 'Excel' : 'JSON'}\n\n`;

  // Smart money
  if (smartMoney) {
    text += `${smartMoney.icon} ${smartMoney.label}\n`;
    text += `${smartMoney.keyakinan} — ${smartMoney.detail}\n`;
    text += `Saham: ${smartMoney.saham.join(', ')}\n\n`;
  }

  // Cross ownership
  if (crossOwned.length > 0) {
    text += `Cross Ownership:\n`;
    for (const c of crossOwned) {
      text += `- ${c.kode}: dimiliki ${c.owners.join(' & ')}\n`;
    }
    text += '\n';
  }

  // Per saham — lengkap dengan entry plan
  for (const r of sahamResults) {
    const { kode, nama, sektor, quote, orderbook, arb, ara, distToArb, distToAra, entry, score, signal } = r;

    text += `----------------------------\n`;
    text += `${kode} — ${nama}\n`;
    if (sektor) text += `Sektor: ${sektor}\n`;

    if (!quote?.price || quote.price <= 0) {
      text += `Data tidak tersedia\n\n`;
      continue;
    }

    const chg    = (quote.changePct || 0).toFixed(2);
    const chgDir = parseFloat(chg) >= 0 ? '+' : '';

    // Data pasar
    text += `\nData Pasar (Yahoo Finance):\n`;
    text += `Open  : Rp ${fmt(quote.open)}\n`;
    text += `Harga : Rp ${fmt(quote.price)} (${chgDir}${chg}%)\n`;
    text += `High  : Rp ${fmt(quote.high)}\n`;
    text += `Low   : Rp ${fmt(quote.low)}\n`;
    text += `Volume: ${quote.volume ? (quote.volume/1e6).toFixed(2)+'M lot' : 'N/A'}\n`;

    // ARB & ARA
    text += `\nARB & ARA:\n`;
    text += `ARB (-15%): Rp ${fmt(arb)}${distToArb ? ' | jarak -'+distToArb+'%' : ''}\n`;
    text += `ARA (+15%): Rp ${fmt(ara)}${distToAra ? ' | jarak +'+distToAra+'%' : ''}\n`;

    // Indikator teknikal
    if (r.indicators) {
      const ind = r.indicators;
      text += `\nIndikator Teknikal:\n`;
      text += `RSI   : ${ind.rsi?.toFixed(1) || 'N/A'}\n`;
      text += `MACD  : ${ind.macd?.MACD?.toFixed(0) || 'N/A'} | Hist: ${ind.macd?.histogram?.toFixed(0) || 'N/A'}\n`;
      text += `EMA9  : Rp ${fmt(ind.ema9)} | EMA20: Rp ${fmt(ind.ema20)}\n`;
      text += `Support   : Rp ${fmt(ind.support)}\n`;
      text += `Resistance: Rp ${fmt(ind.resistance)}\n`;
      text += `Trend : ${ind.trend || 'N/A'}\n`;
    }

    // Entry plan (baru!)
    if (entry) {
      text += `\nRencana Entry:\n`;
      text += `Entry : Rp ${fmt(entry.price)}\n`;
      text += `SL    : Rp ${fmt(entry.stopLoss)} (-${entry.riskPct}%)\n`;
      text += `TP1   : Rp ${fmt(entry.takeProfit1)} (+${entry.tp1Pct}%)\n`;
      text += `TP2   : Rp ${fmt(entry.takeProfit2)} (+${entry.tp2Pct}%)\n`;
      text += `R:R   : 1:${entry.rr1}\n`;
    }

    // Orderbook proxy
    if (orderbook) {
      const biasText = orderbook.bias?.replace(/🚀|🔻|🟡/g, '').trim() || 'Netral';
      text += `\nOrderbook Proxy:\n`;
      text += `Bias  : ${biasText}\n`;
      text += `Candle: ${orderbook.isBull ? 'Bullish' : 'Bearish'} (${orderbook.candleStr}%)\n`;
      text += `Volume: ${orderbook.volRatio}x${parseFloat(orderbook.volRatio) > 2 ? ' (SPIKE)' : ''}\n`;
      if (orderbook.akumulasi)  text += `AKUMULASI terdeteksi\n`;
      if (orderbook.distribusi) text += `DISTRIBUSI terdeteksi\n`;
      for (const s of (orderbook.signals||[])) {
        text += `${s.replace(/[*_`]/g, '')}\n`;
      }
    }

    // Skor & signal
    text += `\nSkor: ${score}/100 | Signal: ${signal}\n\n`;
  }

  text += `Sumber: Excel + Yahoo Finance | ARB -15% | v3`;
  return trunc(text);
}

// ── Top Gainers & Top Losers ──────────────────────────────────
export async function getTopMovers(type = 'gainers', limit = 10) {
  const { reverseIndex } = await getKongloData();
  const kongloKodes = new Set(Object.keys(reverseIndex));

  const UNIVERSE = [
    'BBCA','BBRI','BMRI','BBNI','TLKM','ASII','UNVR','ICBP','INDF',
    'GOTO','BUKA','ANTM','PTBA','ADRO','ITMG','PGAS','MEDC','BSDE',
    'CTRA','SMGR','KLBF','KAEF','MAPI','ACES','GGRM','INDY','PTRO',
    'MNCN','BMTR','TBIG','TOWR','SMRA','PWON','BUMI','BRMS','INCO',
    'TINS','AALI','SIMP','LSIP','AMMN','MDKA','MBMA','ESSA','SRTG',
    'BREN','TPIA','CUAN','BYAN','EMTK','SCMA','AMRT','MIDI','ERAA',
  ];

  const quotes = await fetchMultipleQuotes(UNIVERSE);
  const valid  = quotes.filter(q => q?.price > 0 && q.changePct !== undefined);
  const sorted = type === 'gainers'
    ? valid.sort((a,b) => (b.changePct||0) - (a.changePct||0))
    : valid.sort((a,b) => (a.changePct||0) - (b.changePct||0));

  return sorted.slice(0, limit).map(q => ({
    ...q,
    isKonglo: kongloKodes.has(q.symbol),
    kongloInfo: reverseIndex[q.symbol] || [],
    arb: calcARB(q.prev || q.price)
  }));
}

export function formatTopMoversTelegram(movers, type) {
  const icon  = type === 'gainers' ? '🚀' : '🔻';
  const label = type === 'gainers' ? 'Top Gainers' : 'Top Losers';
  let text = `${icon} *${label} IDX*\n`;
  text += `_Sumber: Yahoo Finance | 🏦 = Saham Konglomerat_\n\n`;

  movers.forEach((q, i) => {
    const kongloTag  = q.isKonglo ? ` 🏦` : '';
    const kongloName = q.isKonglo && q.kongloInfo.length > 0
      ? ` _(${q.kongloInfo.map(k=>k.kongloKey).join('/')})_` : '';
    const chg     = (q.changePct || 0).toFixed(2);
    const chgIcon = parseFloat(chg) >= 0 ? '🟢' : '🔴';

    text += `${i+1}. *${q.symbol}*${kongloTag}${kongloName}\n`;
    text += `   Rp ${Math.round(q.price).toLocaleString('id-ID')} ${chgIcon} ${parseFloat(chg)>=0?'+':''}${chg}%\n`;
    text += `   Vol: ${q.volume ? (q.volume/1e6).toFixed(1)+'M' : 'N/A'} | ARB: Rp ${Math.round(q.arb||0).toLocaleString('id-ID')}\n\n`;
  });

  text += `_${new Date().toLocaleTimeString('id-ID')} WIB_`;
  return text.length > 4000 ? text.slice(0,4000)+'...' : text;
}

// ── Daftar semua konglo ───────────────────────────────────────
export function formatKongloListTelegram() {
  const list  = listAllKonglo();
  const stats = getStats();
  let text = `🏦 *Daftar Konglomerat IDX*\n`;
  text += `_${stats.totalKonglo} konglo | ${stats.totalSaham} saham | ${stats.crossOwnership} cross-ownership_\n\n`;

  for (const k of list) {
    text += `• \`/konglo ${k.key}\` — *${k.nama}* (${k.jumlahSaham} saham)\n`;
  }
  text += `\n_Sumber: List\\_Saham\\_Konglomerat\\_Indonesia.xlsx_`;
  return text.length > 4000 ? text.slice(0,4000)+'...' : text;
}

// ── Top Volume ────────────────────────────────────────────────
export async function getTopVolume(limit = 15) {
  const { reverseIndex } = await getKongloData();
  const kongloKodes = new Set(Object.keys(reverseIndex));

  // Universe lebih luas untuk volume scan
  const VOLUME_UNIVERSE = [
    // Big caps & liquid
    'BBCA','BBRI','BMRI','BBNI','TLKM','ASII','UNVR','ICBP','INDF',
    'GOTO','BUKA','ANTM','PTBA','ADRO','ITMG','PGAS','MEDC','BSDE',
    'CTRA','SMGR','KLBF','KAEF','MAPI','ACES','GGRM','INDY','PTRO',
    'MNCN','BMTR','TBIG','TOWR','SMRA','PWON','BUMI','BRMS','INCO',
    'TINS','AALI','SIMP','LSIP','AMMN','MDKA','MBMA','ESSA','SRTG',
    'BREN','TPIA','CUAN','BYAN','EMTK','SCMA','AMRT','MIDI','ERAA',
    // Tambahan saham aktif IDX
    'DEWA','ENRG','HRUM','BRPT','TKIM','INKP','JPFA','MYOR','TBLA',
    'SIDO','ULTJ','WIKA','PTPP','ADHI','WTON','WSKT','JSMR','BJTM',
    'BJBR','BTPS','BRIS','NISP','MAYA','AGRO','BDMN','PNBN','BNLI',
    'BULL','NCKL','MBMA','ADMR','AADI','SRTG','EMAS','WIFI','BYAN',
  ];

  const quotes = await fetchMultipleQuotes(VOLUME_UNIVERSE);
  const valid  = quotes.filter(q => q?.price > 0 && q.volume > 0);

  // Sort by volume descending
  valid.sort((a, b) => (b.volume || 0) - (a.volume || 0));

  return valid.slice(0, limit).map((q, i) => {
    const isKonglo   = kongloKodes.has(q.symbol);
    const kongloInfo = reverseIndex[q.symbol] || [];
    const ara = calcARA(q.prev || q.price); const arb = calcARB(q.prev || q.price);

    // Volume quality signal
    const avgVol = q.avgVolume || 0;
    const volRatio = avgVol > 0 ? (q.volume / avgVol) : 1;
    let volSignal = '⚪ Normal';
    if (volRatio >= 3.0)      volSignal = '🔥 Sangat Tinggi';
    else if (volRatio >= 2.0) volSignal = '⚡ Spike';
    else if (volRatio >= 1.5) volSignal = '📊 Di atas rata-rata';

    return {
      rank: i + 1,
      ...q,
      isKonglo, kongloInfo,
      ara, arb, volRatio, volSignal,
      volBillion: (q.volume / 1e9).toFixed(2),
      volMillion: (q.volume / 1e6).toFixed(1),
    };
  });
}

export function formatTopVolumeTelegram(movers) {
  const fmt = n => n != null ? Math.round(n).toLocaleString('id-ID') : 'N/A';
  let text = `📊 *Top Volume IDX Hari Ini*\n`;
  text += `_Sumber: Yahoo Finance | 🏦 = Konglo | 🔥 = Volume Spike_\n\n`;

  for (const q of movers) {
    const kongloTag  = q.isKonglo ? ' 🏦' : '';
    const kongloName = q.isKonglo && q.kongloInfo.length > 0
      ? ` _(${q.kongloInfo.map(k => k.kongloKey).join('/')})_` : '';
    const chg     = (q.changePct || 0).toFixed(2);
    const chgIcon = parseFloat(chg) >= 0 ? '🟢' : '🔴';

    text += `${q.rank}. *${q.symbol}*${kongloTag}${kongloName}\n`;
    text += `   ${chgIcon} Rp ${fmt(q.price)} (${parseFloat(chg) >= 0 ? '+' : ''}${chg}%)\n`;
    text += `   📊 Vol: *${q.volMillion}M* ${q.volSignal}\n`;
    if (q.volRatio > 1) text += `   Rasio: ${q.volRatio.toFixed(1)}x rata-rata\n`;
    text += `   ARB: Rp ${fmt(q.arb)} | ARA: Rp ${fmt(q.ara)}\n\n`;
  }

  text += `_${new Date().toLocaleTimeString('id-ID')} WIB_`;
  return text.length > 4000 ? text.slice(0, 4000) + '...' : text;
}

// ── Volume Spike Alert (untuk analisis lebih akurat) ──────────
export async function getVolumeSpikes(minRatio = 2.0, limit = 10) {
  const all = await getTopVolume(50);
  return all
    .filter(q => q.volRatio >= minRatio)
    .slice(0, limit);
}
