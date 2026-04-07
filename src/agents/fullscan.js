// src/agents/fullscan.js — Full IDX Market Scanner
import chalk from 'chalk';
import Table from 'cli-table3';
import { fetchMultipleQuotes, fetchOHLC, calcAllIndicators, calcEntryPlan, scoreScalping } from '../indicators/market.js';
import { callLLM } from '../llm/router.js';
import { saveScanResult, getWinRate } from '../db/database.js';

// ── Daftar 200+ Saham IDX (semua sektor) ────────────────────
export const IDX_ALL = {
  'Perbankan': ['BBCA','BBRI','BMRI','BBNI','BNGA','BTPS','BJTM','BJBR','BDMN','BRIS','NISP','PNBN','AGRO','MAYA','BTPN'],
  'Batubara': ['ADRO','PTBA','ITMG','HRUM','BUMI','BRMS','KKGI','DEWA','GEMS','MCOL','SMMT','BOSS'],
  'Energi & Minyak': ['PGAS','MEDC','ELSA','ENRG','RUIS','MITI','ESSA','RAJA'],
  'Tambang Mineral': ['ANTM','INCO','TINS','BRMS','PSAB','DKFT'],
  'Properti': ['BSDE','CTRA','PWON','SMRA','ASRI','LPKR','DILD','MTLA','APLN','JRPT','PJAA','BCIP'],
  'Telekomunikasi': ['TLKM','EXCL','ISAT','FREN','TBIG','TOWR','MTEL'],
  'Otomotif': ['ASII','IMAS','SMSM','GJTL','PRAS','AUTO','BOLT'],
  'Konsumer & FMCG': ['UNVR','ICBP','INDF','MYOR','SIDO','ULTJ','CLEO','SKBM','ROTI','BUDI','CAMP','DLTA','MLBI'],
  'Farmasi': ['KLBF','KAEF','MERK','PYFA','INAF','DVLA','TSPC','SQBB'],
  'Teknologi': ['GOTO','BUKA','EMTK','MLPT','MTDL','DMMX','CASH','WIFI','LUCK'],
  'Retail': ['MAPI','ACES','AMRT','HERO','RALS','MIDI','RANC','LPPF'],
  'Semen & Konstruksi': ['SMGR','INTP','WTON','WIKA','PTPP','ADHI','ACST','TOTL','SOCI'],
  'Media & Tower': ['MNCN','SCMA','BMTR','VIVA','KPIG'],
  'Plantation': ['AALI','SIMP','LSIP','SSMS','TAPG','SGRO','TBLA','DSNG'],
  'Logistik & Shipping': ['SMDR','MBSS','HITS','TMAS','SAFE','DEAL','TAXI'],
  'Healthcare': ['MIKA','SILO','HEAL','PRDA','OMED','PRIM'],
  'Infrastruktur': ['JSMR','CMNP','META','IPCM','INPP','PORT'],
};

export const IDX_ALL_FLAT = Object.values(IDX_ALL).flat();

// ── Full Market Scan ─────────────────────────────────────────
export async function runFullScan(options = {}) {
  const {
    provider = 'claude',
    model = null,
    riskProfile = 'moderate',
    topN = 10,
    minScore = 55,
    sectors = null, // null = semua sektor
    onProgress = null,
    withAI = false,
  } = options;

  const universe = sectors
    ? sectors.flatMap(s => IDX_ALL[s] || [])
    : IDX_ALL_FLAT;

  const total = universe.length;
  const results = [];
  const errors = [];

  // Scan per batch 10 saham (hindari rate limit)
  const BATCH = 10;
  let done = 0;

  for (let i = 0; i < universe.length; i += BATCH) {
    const batch = universe.slice(i, i + BATCH);

    // Fetch quote batch
    let quotes = [];
    try {
      quotes = await fetchMultipleQuotes(batch);
    } catch (e) {
      quotes = batch.map(s => ({ symbol: s, price: 0, source: 'demo' }));
    }

    // Analisis tiap saham dalam batch
    await Promise.allSettled(
      quotes.map(async (quote, idx) => {
        const symbol = batch[idx];
        try {
          const ohlc = await fetchOHLC(symbol, '3mo');
          const ind = calcAllIndicators(ohlc);
          if (!ind) return;

          const entry = calcEntryPlan(quote, ind, riskProfile);
          const { score, signal, trend, reasons } = scoreScalping(quote, ind);

          // Filter score minimum
          if (score >= minScore) {
            results.push({ symbol, quote, indicators: ind, entry, score, signal, trend, reasons });
          }
        } catch (e) {
          errors.push(symbol);
        }
      })
    );

    done += batch.length;
    if (onProgress) onProgress(done, total);

    // Small delay antar batch
    await new Promise(r => setTimeout(r, 200));
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  // Simpan ke DB
  for (const r of results.slice(0, 20)) {
    saveScanResult(r.symbol, r.score, r.signal, r.quote?.price);
  }

  // AI Summary (top picks)
  let aiSummary = null;
  if (withAI && results.length > 0) {
    const tops = results.slice(0, topN);
    aiSummary = await getAISummary(tops, provider, model, riskProfile);
  }

  return {
    total: universe.length,
    scanned: done,
    found: results.length,
    errors: errors.length,
    topPicks: results.slice(0, topN),
    allResults: results,
    aiSummary
  };
}

// ── AI Summary untuk Top Picks ───────────────────────────────
async function getAISummary(topPicks, provider, model, riskProfile) {
  const fmt = n => Math.round(n || 0).toLocaleString('id-ID');
  const winRate = getWinRate();

  const dataStr = topPicks.map((r, i) =>
    `${i+1}. ${r.symbol} | Harga: Rp ${fmt(r.quote?.price)} | RSI: ${r.indicators?.rsi?.toFixed(1)} | MACD: ${r.indicators?.macd?.MACD?.toFixed(0)} | Trend: ${r.trend} | Skor: ${r.score}/100 | Signal: ${r.signal} | Entry: ${fmt(r.entry?.price)} | SL: ${fmt(r.entry?.stopLoss)} | TP1: ${fmt(r.entry?.takeProfit1)}`
  ).join('\n');

  const prompt = `Kamu adalah analis saham IDX profesional. Berikut hasil full market scan IDX:

${dataStr}

Win rate bot historis: ${winRate.winRate}% dari ${winRate.total} sinyal
Risk profile user: ${riskProfile}

Berikan:
1. 🏆 Top 3 pilihan TERBAIK dengan alasan singkat masing-masing
2. ⚠️ Saham yang perlu diwaspadai dari list ini
3. 📊 Kesimpulan kondisi pasar secara umum hari ini
4. 💡 Strategi yang disarankan (scalping/hold/wait)

Jawab dalam Bahasa Indonesia, ringkas dan actionable. Maks 300 kata.`;

  try {
    const result = await callLLM({
      provider, model,
      systemPrompt: 'Kamu analis saham IDX berpengalaman. Jawab ringkas, tajam, actionable dalam Bahasa Indonesia.',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 800
    });
    return { text: result.text, provider: result.provider, model: result.model };
  } catch (e) {
    return { text: `AI tidak tersedia: ${e.message}`, provider, model };
  }
}

// ── CLI Output ───────────────────────────────────────────────
export function printFullScanResult(result, opts = {}) {
  const { topPicks, total, scanned, found, errors, aiSummary } = result;
  const fmt = n => Math.round(n || 0).toLocaleString('id-ID');

  console.log();
  console.log(chalk.cyan.bold(`  📊 Full Market Scan Selesai`));
  console.log(chalk.gray(`  Total universe: ${total} saham | Berhasil scan: ${scanned} | Lolos filter: ${found} | Error: ${errors}`));
  console.log();

  if (topPicks.length === 0) {
    console.log(chalk.yellow('  ⚠ Tidak ada saham yang memenuhi kriteria saat ini.'));
    return;
  }

  const table = new Table({
    head: [
      chalk.cyan('No'), chalk.cyan('Kode'), chalk.cyan('Harga'), chalk.cyan('%'),
      chalk.cyan('RSI'), chalk.cyan('Trend'), chalk.cyan('Skor'), chalk.cyan('Signal'),
      chalk.cyan('SL'), chalk.cyan('TP1'), chalk.cyan('R:R')
    ],
    style: { border: ['gray'] },
    colAligns: ['right','left','right','right','right','center','right','center','right','right','right']
  });

  topPicks.forEach((r, i) => {
    const sColor = r.score >= 70 ? chalk.green : r.score >= 55 ? chalk.yellow : chalk.gray;
    const sigColor = r.signal === 'BELI' ? chalk.green : r.signal === 'NETRAL' ? chalk.yellow : chalk.red;
    const chgColor = (r.quote?.changePct || 0) >= 0 ? chalk.green : chalk.red;

    table.push([
      chalk.gray(i + 1),
      chalk.bold(r.symbol),
      `Rp ${fmt(r.quote?.price)}`,
      chgColor(`${(r.quote?.changePct || 0) >= 0 ? '+' : ''}${(r.quote?.changePct || 0).toFixed(2)}%`),
      r.indicators?.rsi?.toFixed(1) || 'N/A',
      r.trend || 'N/A',
      sColor.bold(`${r.score}/100`),
      sigColor(r.signal),
      chalk.red(`${fmt(r.entry?.stopLoss)}`),
      chalk.green(`${fmt(r.entry?.takeProfit1)}`),
      `1:${r.entry?.rr1}`
    ]);
  });

  console.log(table.toString());

  // Top 3 highlight
  const top3 = topPicks.slice(0, 3);
  console.log();
  console.log(chalk.green.bold(`  🏆 Top Pick: ${top3.map(r => r.symbol).join(' | ')}`));

  // Per sektor breakdown
  const bySector = {};
  for (const [sektor, kodes] of Object.entries(IDX_ALL)) {
    const hits = topPicks.filter(r => kodes.includes(r.symbol));
    if (hits.length > 0) bySector[sektor] = hits;
  }
  if (Object.keys(bySector).length > 0) {
    console.log();
    console.log(chalk.cyan('  📈 Distribusi per Sektor:'));
    for (const [sektor, hits] of Object.entries(bySector)) {
      console.log(`  ${chalk.gray('•')} ${sektor}: ${chalk.white(hits.map(h => h.symbol).join(', '))}`);
    }
  }

  // AI Summary
  if (aiSummary) {
    console.log();
    console.log(chalk.cyan.bold(`  🤖 Analisis AI (${aiSummary.provider}/${aiSummary.model}):`));
    console.log();
    aiSummary.text.split('\n').forEach(l => console.log('  ' + l));
  }

  console.log();
  console.log(chalk.gray(`  💡 Gunakan: node index.js analyze KODE --ai claude --mode scalping`));
  console.log();
}

// ── Format untuk Telegram ────────────────────────────────────
export function formatTelegramScan(result) {
  const { topPicks, total, found, aiSummary } = result;
  const fmt = n => Math.round(n || 0).toLocaleString('id-ID');

  let text = `🔎 *Full Market Scan IDX*\n`;
  text += `_${total} saham dipindai | ${found} lolos filter_\n\n`;

  const top = topPicks.slice(0, 10);
  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    const icon = r.score >= 75 ? '🟢' : r.score >= 60 ? '🟡' : '🟠';
    const chg = (r.quote?.changePct || 0).toFixed(2);
    text += `${icon} *${r.symbol}* — ${r.score}/100 | ${r.signal}\n`;
    text += `   Rp ${fmt(r.quote?.price)} (${chg >= 0 ? '+' : ''}${chg}%) | RSI: ${r.indicators?.rsi?.toFixed(1)} | ${r.trend}\n`;
    text += `   SL: ${fmt(r.entry?.stopLoss)} | TP: ${fmt(r.entry?.takeProfit1)} | R:R 1:${r.entry?.rr1}\n\n`;
  }

  if (topPicks.length > 0) {
    text += `⭐ *Top 3: ${topPicks.slice(0,3).map(r=>r.symbol).join(' | ')}*\n\n`;
  }

  if (aiSummary) {
    text += `🤖 *Analisis AI:*\n${aiSummary.text}\n`;
  }

  return text;
}
