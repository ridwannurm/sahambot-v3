// src/telegram/bot.js — Telegram Bot dengan grammY
import { Bot } from 'grammy';
import { safeSend, handleLLMError, trunc, fmt, fmtPct, safeFixed } from './utils.js';
import { handleOwnership, handleOwnershipCallback, handleOwnershipText, initOwnership } from './ownershipFlow.js';
import {
  handleEntry, handleExit, handlePositions,
  handleReport, handleHistory, handleStats, handleSetCapital,
  handlePartialExit, handlePartialExitCallback,
  handleCompound, handleRebalance, handleMultiDay,
  handleEntrySide, handleSetupSelect, handleConfidenceSelect,
  handleConfirmEntry, handleExitType,
  handlePendingEntryText, handlePendingExitText
} from './tradeFlow.js';
import { decisionEngine, formatAnalysisTelegram } from '../agents/trading.js';
import { initTradingTables } from '../db/database.js';
import { analyzeKonglo, formatKongloTelegram, getTopMovers, formatTopMoversTelegram, formatKongloListTelegram, getTopVolume, formatTopVolumeTelegram, getVolumeSpikes } from '../agents/konglo.js';
import { startAutoUpdateChecker, hasUpdate, getVersionInfo } from '../updater.js';
import chalk from 'chalk';
import cron from 'node-cron';
import { classifyIntent, LLM_PROVIDERS, compareAI } from '../llm/router.js';
import { analyzeStock, freeChat, scanWatchlist, calcPositionSize } from '../agents/brain.js';
import { fetchQuote, fetchMultipleQuotes, calcAllIndicators, fetchOHLC, calcEntryPlan, scoreScalping } from '../indicators/market.js';
import { getUserMemory, updateUserMemory, getWatchlist, addToWatchlist, removeFromWatchlist, getWinRate, saveScanResult } from '../db/database.js';
import { loadEnv } from '../config.js';

const SESSIONS = {};

function getSess(userId) {
  const uid = String(userId);
  if (!SESSIONS[uid]) {
    const mem = getUserMemory(uid);
    SESSIONS[uid] = { provider: mem.preferred_llm||'claude', model: null, riskProfile: mem.risk_profile||'moderate' };
  }
  return SESSIONS[uid];
}

export function startTelegramBot() {
  const env = loadEnv();
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token || token==='(skip)') { console.log(chalk.red('  ✖ TELEGRAM_BOT_TOKEN tidak ada di .env')); return null; }

  const bot = new Bot(token);

  // Init trading tables
  initTradingTables();
  initOwnership();

  bot.command('start', async ctx => {
    getUserMemory(String(ctx.from.id));
    await ctx.reply(trunc('🤖 *SahamBot v2 — Multi-AI IDX Analyzer*\n\nKetik bebas dalam Bahasa Indonesia atau gunakan command:\n/analyze BBCA | /scalp BBCA | /scan | /watchlist\n/add KODE | /remove KODE | /setai claude | /models\n/compare BBCA | /sizing 10000000 BBCA | /setrisiko moderate\n/performance | /help'), {parse_mode:'Markdown'});
  });

  bot.command('help', async ctx => {
    await ctx.reply(trunc('📚 *Panduan SahamBot v2*\n\n🔍 *Analisis:*\n/analyze BBCA — Analisis teknikal+AI\n/scalp TLKM — Scalping T+2\n/compare BBCA — Bandingkan semua AI\n\n📋 *Watchlist:*\n/watchlist /add KODE /remove KODE\n\n🔎 *Scanner:*\n/scan — Scan semua watchlist\n\n🤖 *AI:*\n/models — Lihat provider\n/setai claude|openai|groq|gemini|ollama\n\n💰 *Risk:*\n/sizing 10000000 BBCA\n/setrisiko conservative|moderate|aggressive\n\n📊 /performance\n\n💬 Atau ketik bebas dalam Bahasa Indonesia!'), {parse_mode:'Markdown'});
  });

  bot.command('analyze', async ctx => {
    const sym = ctx.match?.trim().toUpperCase();
    if (!sym) return ctx.reply('❓ Contoh: /analyze BBCA');
    await doAnalysis(ctx, sym, 'swing');
  });

  bot.command('scalp', async ctx => {
    const sym = ctx.match?.trim().toUpperCase();
    if (!sym) return ctx.reply('❓ Contoh: /scalp BBCA');
    await doAnalysis(ctx, sym, 'scalping');
  });

  bot.command('scan', async ctx => { await doScan(ctx); });

  bot.command('watchlist', async ctx => {
    const wl = getWatchlist();
    const quotes = await fetchMultipleQuotes(wl);
    let text = '📋 *Watchlist:*\n\n';
    for (const q of quotes) {
      const icon = (q.changePct||0) >= 0 ? '🟢' : '🔴';
      text += `${icon} *${q.symbol}* Rp ${fmt(q.price)} (${(q.changePct||0).toFixed(2)}%)\n`;
    }
    ctx.reply(trunc(text+'\n_/add KODE | /remove KODE_'), {parse_mode:'Markdown'});
  });

  bot.command('add', async ctx => {
    const sym = ctx.match?.trim().toUpperCase();
    if (!sym) return ctx.reply('❓ /add BBCA');
    addToWatchlist(sym, sym);
    ctx.reply(`✅ *${sym}* ditambahkan!`, {parse_mode:'Markdown'});
  });

  bot.command('remove', async ctx => {
    const sym = ctx.match?.trim().toUpperCase();
    if (!sym) return ctx.reply('❓ /remove BBCA');
    removeFromWatchlist(sym);
    ctx.reply(`🗑️ *${sym}* dihapus.`, {parse_mode:'Markdown'});
  });

  bot.command('setai', async ctx => {
    const uid = String(ctx.from.id);
    const args = ctx.match?.trim().toLowerCase().split(' ');
    const p = args[0], m = args[1];
    if (!LLM_PROVIDERS[p]) return ctx.reply(`❌ Pilihan: ${Object.keys(LLM_PROVIDERS).join(', ')}`);
    const sess = getSess(uid); sess.provider=p; sess.model=m||null;
    updateUserMemory(uid, {preferred_llm:p});
    ctx.reply(`✅ AI → *${LLM_PROVIDERS[p].name}*${m?` (${m})`:''}`, {parse_mode:'Markdown'});
  });

  bot.command('models', async ctx => {
    const env2 = loadEnv();
    let text = '🤖 *Provider AI:*\n\n';
    for (const [k,v] of Object.entries(LLM_PROVIDERS)) {
      const ok = !v.envKey || env2[v.envKey];
      text += `${ok?'✅':'❌'} *${k}* — ${v.name}\n${v.models.slice(0,3).join(', ')}\n\n`;
    }
    ctx.reply(trunc(text), {parse_mode:'Markdown'});
  });

  bot.command('compare', async ctx => {
    const sym = ctx.match?.trim().toUpperCase();
    if (!sym) return ctx.reply('❓ /compare BBCA');
    await doCompare(ctx, sym);
  });

  bot.command('sizing', async ctx => {
    const uid = String(ctx.from.id);
    const parts = ctx.match?.trim().split(' ')||[];
    const capital = parseInt(parts[0]?.replace(/[.,]/g,''));
    const symbol = parts[1]?.toUpperCase();
    if (!capital) return ctx.reply('❓ /sizing 10000000 BBCA');
    const sess = getSess(uid);
    let ep=1000, sl=980;
    if (symbol) {
      try { const [q,ohlc]=await Promise.all([fetchQuote(symbol),fetchOHLC(symbol,'3mo')]); const ind=calcAllIndicators(ohlc); if(ind){const pl=calcEntryPlan(q,ind,sess.riskProfile);ep=pl.price;sl=pl.stopLoss;} } catch{}
    }
    const rp = {conservative:1,moderate:2,aggressive:3}[sess.riskProfile]||2;
    const pos = calcPositionSize(capital, rp, ep, sl);
    ctx.reply(trunc(`💰 *Position Sizing*\nModal: Rp ${capital.toLocaleString('id-ID')}\nRisk: *${sess.riskProfile}* (${rp}%)\n${symbol?`${symbol}: Entry ${fmt(ep)} | SL ${fmt(sl)}\n`:''}\n*Lot: ${pos.lots} lot* (${pos.shares.toLocaleString()} lembar)\nModal diperlukan: Rp ${pos.totalCost?.toLocaleString('id-ID')}\nMax loss: Rp ${pos.riskAmount?.toLocaleString('id-ID')} (${pos.riskPct}%)`), {parse_mode:'Markdown'});
  });

  bot.command('setrisiko', async ctx => {
    const uid = String(ctx.from.id);
    const p = ctx.match?.trim().toLowerCase();
    if (!['conservative','moderate','aggressive'].includes(p)) return ctx.reply('❌ Pilihan: conservative | moderate | aggressive');
    getSess(uid).riskProfile=p; updateUserMemory(uid,{risk_profile:p});
    ctx.reply(`✅ Risk profile: *${p}*`, {parse_mode:'Markdown'});
  });

  bot.command('performance', async ctx => {
    const wr = getWinRate();
    ctx.reply(`📊 Win Rate: *${wr.winRate}%* | Total: ${wr.total} | Avg PnL: ${wr.avgPnl}%`, {parse_mode:'Markdown'});
  });



  // ═══════════════════════════════════════════════════
  // TRADING SYSTEM COMMANDS (v3.1)
  // ═══════════════════════════════════════════════════

  // /entry — buka posisi dengan interactive flow
  bot.command('entry', handleEntry);

  // /exit — tutup posisi dengan interactive flow
  bot.command('exit', handleExit);

  // /positions — lihat semua posisi terbuka
  bot.command('positions', handlePositions);

  // /report — laporan performa lengkap
  bot.command('report', handleReport);

  // /history — riwayat trade
  bot.command('history', ctx => handleHistory(ctx));

  // /stats — statistik per saham
  bot.command('stats', ctx => handleStats(ctx));

  // /setcapital — set modal portfolio
  bot.command('setcapital', handleSetCapital);

  // /ownership — kepemilikan saham
  bot.command('ownership', handleOwnership);

  // Callback untuk ownership buttons
  bot.callbackQuery(/^own:/, handleOwnershipCallback);

  // /partialexit
  bot.command('partialexit', handlePartialExit);

  // /compound
  bot.command('compound', handleCompound);

  // /rebalance
  bot.command('rebalance', handleRebalance);

  // /multiday
  bot.command('multiday', ctx => handleMultiDay(ctx));

  // ── Callback query handlers (inline buttons) ──────
  // BUY / SELL
  bot.callbackQuery(/^entry:(buy|sell|cancel):(.+)$/, handleEntrySide);

  // Setup selection
  bot.callbackQuery(/^setup:(KONGLO_MOMENTUM|BREAKOUT_VALID|REVERSAL_AKUMULASI):(.+)$/, handleSetupSelect);

  // Confidence selection
  bot.callbackQuery(/^conf:(High|Medium|Low):(.+)$/, handleConfidenceSelect);

  // Confirm entry
  bot.callbackQuery(/^confirm:entry:(.+)$/, handleConfirmEntry);

  // Exit type selection
  bot.callbackQuery(/^exit:(TAKE_PROFIT|STOP_LOSS|EARLY_EXIT|RE_ENTRY_EXIT):(.+)$/, handleExitType);

  // Partial exit callback
  bot.callbackQuery(/^pexit:(TAKE_PROFIT|EARLY_EXIT|RE_ENTRY_EXIT):(.+):(.+):(.+)$/, handlePartialExitCallback);

  // /fullscan
  bot.command('fullscan', async ctx => {
    const uid = String(ctx.from.id);
    const sess = getSess(uid);
    const args = ctx.match?.trim().toLowerCase() || '';
    const sectors = args.length > 0 ? args.split(',').map(s => s.trim()) : null;
    try {
      const { runFullScan, formatTelegramScan, IDX_ALL } = await import('../agents/fullscan.js');
      const total = sectors ? sectors.flatMap(s => IDX_ALL[s]||[]).length : Object.values(IDX_ALL).flat().length;
      await ctx.reply('Full Market Scan IDX - ' + total + ' saham dipindai. Mohon tunggu 1-3 menit...');
      const result = await runFullScan({ provider: sess.provider, model: sess.model, topN: 10, minScore: 55, sectors, withAI: true });
      const scanText = formatTelegramScan(result)
        .replace(/\*/g, '').replace(/_/g, '').replace(/`/g, '');
      await ctx.reply(trunc(scanText));
    } catch(e) { ctx.reply('❌ ' + e.message); }
  });

  // /sectors
  bot.command('sectors', async ctx => {
    const { IDX_ALL } = await import('../agents/fullscan.js');
    let text = '📋 *Sektor IDX Tersedia:*\n\n';
    for (const [s, kodes] of Object.entries(IDX_ALL)) {
      text += '*' + s + '* (' + kodes.length + ' saham)\n' + kodes.join(', ') + '\n\n';
    }
    text += '_Contoh: /fullscan perbankan,batubara_';
    ctx.reply(trunc(text), {parse_mode:'Markdown'});
  });


  // ── /ara ──────────────────────────────────────────────────
  bot.command('ara', async ctx => {
    const args = ctx.match?.trim().toUpperCase() || '';
    if (!args) return ctx.reply('❓ Contoh: /ara BBCA\nAtau multi: /ara BBCA,BBRI,TLKM');

    const symbols = args.split(',').map(s => s.trim()).filter(Boolean);
    await ctx.reply(`📊 Menghitung ARA & ARB untuk *${symbols.join(', ')}*...`, {parse_mode:'Markdown'});

    try {
      const { calcAraArb, calcDistanceToLimits, ARA_ARB_TABLE } = await import('../indicators/araArb.js');
      const { fetchMultipleQuotes } = await import('../indicators/market.js');

      const quotes = await fetchMultipleQuotes(symbols);

      let text = '📊 *ARA & ARB IDX*\n\n';

      for (const q of quotes) {
        const prev = q.prev || q.price;
        const current = q.price;
        const araArb = calcAraArb(prev, false, false);
        const r = calcDistanceToLimits(araArb, current);

        const hitAra = r.hitAra ? ' 🚨 *KENA ARA!*' : r.nearAra ? ' ⚡ Mendekati ARA' : '';
        const hitArb = r.hitArb ? ' 🚨 *KENA ARB!*' : r.nearArb ? ' ⚡ Mendekati ARB' : '';

        text += `*${q.symbol}* — Prev: Rp ${fmt(prev)} | Saat ini: Rp ${fmt(current)}\n`;
        text += `🟢 ARA: Rp ${fmt(r.ara)} (+${safeFixed(r.araPct, 0)}%) | Jarak: +${r.distToAraPct}%${hitAra}\n`;
        text += `🔴 ARB: Rp ${fmt(r.arb)} (-${safeFixed(r.arbPct, 0)}%) | Jarak: -${r.distToArbPct}%${hitArb}\n`;
        text += `Fraksi: Rp ${r.fraksi}\n\n`;
      }

      text += `_Aturan BEI: <Rp200: ±35% | Rp200-4999: ±25% | ≥Rp5000: ±20%_`;
      ctx.reply(trunc(text), {parse_mode:'Markdown'});
    } catch(e) {
      ctx.reply(`❌ ${e.message}`);
    }
  });


  // ── /update ───────────────────────────────────────────────
  bot.command('update', async ctx => {
    const uid = String(ctx.from.id);
    try {
      const { hasUpdate, doUpdate, getVersionInfo, getChangelog } = await import('../updater.js');
      const info = getVersionInfo();

      if (!info.isGitRepo) {
        return ctx.reply('❌ Bot belum terhubung ke GitHub.\nJalankan di VPS:\n`git init && git remote add origin <url>`', {parse_mode:'Markdown'});
      }

      await ctx.reply('🔄 Mengecek update...', {parse_mode:'Markdown'});
      const updateAvail = hasUpdate();

      if (!updateAvail) {
        return ctx.reply(
          `✅ *SahamBot sudah versi terbaru!*\nCommit: \`${info.commit}\` | Branch: ${info.branch}`,
          {parse_mode:'Markdown'}
        );
      }

      const changelog = getChangelog();
      await ctx.reply(
        `🆕 *Update tersedia!*\n\nPerubahan:\n\`\`\`\n${changelog.slice(0,500)}\n\`\`\`\n\nMenginstall update...`,
        {parse_mode:'Markdown'}
      );

      const result = await doUpdate({ restart: true });

      if (result.success) {
        ctx.reply(
          `✅ *Update berhasil!*\n${result.beforeCommit} → ${result.afterCommit}\n${result.depsUpdated ? '📦 Dependencies diupdate\n' : ''}\n_Bot akan restart dalam beberapa detik..._`,
          {parse_mode:'Markdown'}
        );
      } else {
        ctx.reply(`❌ Update gagal: ${result.message}`);
      }
    } catch(e) {
      ctx.reply(`❌ ${e.message}`);
    }
  });

  // ── /version ──────────────────────────────────────────────
  bot.command('version', async ctx => {
    try {
      const { getVersionInfo, hasUpdate } = await import('../updater.js');
      const info = getVersionInfo();
      const upd = info.isGitRepo ? hasUpdate() : null;
      ctx.reply(trunc(
        `📋 *Info Versi SahamBot v2*\n\n` +
        `Versi: *${info.version}*\n` +
        `Commit: \`${info.commit}\`\n` +
        `Branch: ${info.branch}\n` +
        `Node.js: ${info.nodeVersion}\n` +
        `Status: ${upd === null ? 'N/A' : upd ? '🟡 Ada update' : '✅ Terbaru'}\n\n` +
        `_Ketik /update untuk mengupdate_`
      ), {parse_mode:'Markdown'});
    } catch(e) { ctx.reply(`❌ ${e.message}`); }
  });


  // ── /konglo ───────────────────────────────────────────────
  bot.command('konglo', async ctx => {
    const uid = String(ctx.from.id);
    const sess = getSess(uid);
    const query = ctx.match?.trim();

    if (!query) {
      // Tampilkan daftar konglo
      return ctx.reply(trunc(formatKongloListTelegram()), {parse_mode:'Markdown'});
    }

    await ctx.reply(`🏦 Menganalisis konglomerat *${query}*...`, {parse_mode:'Markdown'});

    try {
      const result = await analyzeKonglo(query, {
        provider: sess.provider,
        model: sess.model
      });
      if (result.error) {
        return ctx.reply(result.error);
      }
      const fullText = formatKongloTelegram(result);

      // Kirim per bagian jika panjang (maks 3800 per pesan)
      const MAX = 3800;
      if (fullText.length <= MAX) {
        await ctx.reply(fullText);
      } else {
        // Split per saham (per separator ---)
        const parts = fullText.split('----------------------------');
        const header = parts[0];
        let buffer = header;
        for (let i = 1; i < parts.length; i++) {
          const chunk = '----------------------------' + parts[i];
          if ((buffer + chunk).length > MAX) {
            await ctx.reply(buffer.trim());
            buffer = chunk;
          } else {
            buffer += chunk;
          }
        }
        if (buffer.trim()) await ctx.reply(buffer.trim());
      }
    } catch(e) {
      ctx.reply('Error analisis: ' + e.message);
    }
  });

  // ── /topgainers ───────────────────────────────────────────
  bot.command('topgainers', async ctx => {
    await ctx.reply('🚀 Mengambil Top Gainers dari Yahoo Finance...');
    try {
      const movers = await getTopMovers('gainers', 10);
      ctx.reply(trunc(formatTopMoversTelegram(movers, 'gainers')), {parse_mode:'Markdown'});
    } catch(e) { ctx.reply(`❌ ${e.message}`); }
  });

  // ── /toplosers ────────────────────────────────────────────
  bot.command('toplosers', async ctx => {
    await ctx.reply('🔻 Mengambil Top Losers dari Yahoo Finance...');
    try {
      const movers = await getTopMovers('losers', 10);
      ctx.reply(trunc(formatTopMoversTelegram(movers, 'losers')), {parse_mode:'Markdown'});
    } catch(e) { ctx.reply(`❌ ${e.message}`); }
  });

  // ── /topvolume ────────────────────────────────────────────
  bot.command('topvolume', async ctx => {
    await ctx.reply('📊 Mengambil Top Volume dari Yahoo Finance...');
    try {
      const movers = await getTopVolume(15);
      ctx.reply(trunc(formatTopVolumeTelegram(movers)), {parse_mode:'Markdown'});
    } catch(e) { ctx.reply(`❌ ${e.message}`); }
  });

  // ── /volumespike ──────────────────────────────────────────
  bot.command('volumespike', async ctx => {
    const minRatio = parseFloat(ctx.match?.trim()) || 2.0;
    await ctx.reply(`⚡ Mencari saham dengan volume spike ≥${minRatio}x...`);
    try {
      const spikes = await getVolumeSpikes(minRatio, 15);
      if (!spikes.length) return ctx.reply('_Tidak ada volume spike signifikan saat ini_', {parse_mode:'Markdown'});
      let text = `⚡ *Volume Spike Alert* (≥${minRatio}x)\n\n`;
      for (const q of spikes) {
        const chg = (q.changePct||0).toFixed(2);
        text += `${q.volSignal} *${q.symbol}*${q.isKonglo?' 🏦':''}\n`;
        text += `   Rp ${fmt(q.price)} (${parseFloat(chg)>=0?'+':''}${chg}%) | Vol ${q.volMillion}M (${safeFixed(q.volRatio, 1)}x)\n\n`;
      }
      ctx.reply(trunc(text), {parse_mode:'Markdown'});
    } catch(e) { ctx.reply(`❌ ${e.message}`); }
  });

  // ── /uploadkonglo ─────────────────────────────────────────
  bot.command('uploadkonglo', async ctx => {
    ctx.reply(trunc(
      '📊 *Upload Data Konglomerat (Excel)*\n\n' +
      'Format file Excel yang diperlukan:\n' +
      '```\n' +
      'Kolom wajib:\n' +
      '• Kode       — kode saham (mis: BBCA)\n' +
      '• Nama       — nama emiten\n' +
      '• Konglo     — nama konglomerat\n' +
      '• Pemilik    — nama pemilik\n' +
      '• Pct        — % kepemilikan\n' +
      '```\n\n' +
      'Cara upload:\n' +
      '1. Simpan file sebagai `konglo.xlsx`\n' +
      '2. Upload ke folder `data/` di VPS:\n' +
      '   `scp konglo.xlsx user@IP:/root/sahambot-v2/data/`\n' +
      '3. Bot akan otomatis baca file baru\n\n' +
      '_Data default tetap tersedia jika file belum diupload_'
    ), {parse_mode:'Markdown'});
  });

  // Free text NLP — cek pending entry/exit dulu
  bot.on('message:text', async ctx => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return;
    const uid = String(ctx.from.id);

    // Handle pending multi-step flows dulu
    try {
      const handled = await handleOwnershipText(ctx)
        || await handlePendingExitText(ctx)
        || await handlePendingEntryText(ctx);
      if (handled) return;
    } catch(e) { /* lanjut ke NLP */ }

    // NLP intent
    const intent = classifyIntent(text);
    try { await handleIntent(ctx, uid, text, intent); }
    catch(e) { ctx.reply(`❌ ${e.message}`); }
  });

  // Auto scan cron 5 menit
  const env2 = loadEnv();
  const scanChatId = env2.TELEGRAM_CHAT_ID;
  if (scanChatId && scanChatId !== '(skip)') {
    console.log(chalk.cyan(`  ⏰ Auto scan aktif setiap 5 menit → Chat: ${scanChatId}`));
    cron.schedule('*/5 * * * *', async () => {
      const h = new Date().getHours();
      if (h < 9 || h >= 16) return;
      try {
        const wl = getWatchlist();
        const results = await scanWatchlist(wl, {});
        const tops = results.filter(r => r.score >= 65).slice(0, 3);
        if (!tops.length) return;
        let msg = `🔔 *Auto Scan ${new Date().toLocaleTimeString('id-ID')} WIB*\n\n`;
        for (const r of tops) {
          msg += `${r.score>=75?'🟢':'🟡'} *${r.symbol}* ${r.score}/100 | ${r.signal}\nEntry: ${fmt(r.entry?.price)} | SL: ${fmt(r.entry?.stopLoss)} | TP: ${fmt(r.entry?.takeProfit1)}\n\n`;
          saveScanResult(r.symbol, r.score, r.signal, r.quote?.price);
        }
        await bot.api.sendMessage(scanChatId, trunc(msg), {parse_mode:'Markdown'});
      } catch {}
    });
  }

  // ── Set Command Menu (muncul saat ketik / di Telegram) ──
  bot.api.setMyCommands([
    { command: 'analyze',     description: '📈 Analisis teknikal + AI  |  /analyze BBCA' },
    { command: 'scalp',       description: '⚡ Analisis scalping T+2  |  /scalp BBCA' },
    { command: 'compare',     description: '🤖 Bandingkan semua AI paralel  |  /compare BBCA' },
    { command: 'scan',        description: '🔎 Scan watchlist — cari peluang terbaik' },
    { command: 'fullscan',    description: '🌏 Scan 200+ saham IDX  |  /fullscan perbankan' },
    { command: 'sectors',     description: '📋 Lihat daftar sektor IDX tersedia' },
    { command: 'ara',         description: '📊 Cek ARA & ARB  |  /ara BBCA,BBRI,TLKM' },
    { command: 'watchlist',   description: '👁 Lihat saham pantauan + harga live' },
    { command: 'add',         description: '➕ Tambah ke watchlist  |  /add BBCA' },
    { command: 'remove',      description: '➖ Hapus dari watchlist  |  /remove BBCA' },
    { command: 'setai',       description: '🤖 Ganti AI  |  /setai claude | openai | groq | gemini' },
    { command: 'models',      description: '📡 Lihat semua AI provider & model' },
    { command: 'sizing',      description: '💰 Hitung position size  |  /sizing 10000000 BBCA' },
    { command: 'setrisiko',   description: '⚖️ Set risk profile  |  conservative | moderate | aggressive' },
    { command: 'performance', description: '📊 Win rate & statistik bot' },
    { command: 'version',     description: '🔖 Info versi & status update' },
    { command: 'update',      description: '🔄 Update bot dari GitHub' },
    { command: 'help',        description: '📚 Panduan lengkap semua fitur' },
    { command: 'konglo',      description: '🏦 Analisis konglomerat  |  /konglo SALIM' },
    { command: 'topgainers',  description: '🚀 Top saham naik hari ini (tandai konglo 🏦)' },
    { command: 'toplosers',   description: '🔻 Top saham turun hari ini (tandai konglo 🏦)' },
    { command: 'topvolume',    description: '📊 Top saham volume terbesar hari ini' },
    { command: 'volumespike',  description: '⚡ Saham dengan volume spike  |  /volumespike 2.0' },
    { command: 'uploadkonglo', description: '📊 Panduan upload Excel data konglomerat' },
    { command: 'entry',        description: '📥 Buka posisi trading  |  /entry BBCA' },
    { command: 'exit',         description: '📤 Tutup posisi trading  |  /exit BBCA' },
    { command: 'positions',    description: '📊 Lihat semua posisi terbuka' },
    { command: 'report',       description: '📈 Laporan performa & win rate' },
    { command: 'history',      description: '📋 Riwayat trade terakhir' },
    { command: 'stats',        description: '📊 Statistik per saham  |  /stats BBCA' },
    { command: 'setcapital',   description: '💰 Set modal portfolio  |  /setcapital 50000000' },
    { command: 'ownership',    description: '📦 Kepemilikan saham  |  /ownership atau /ownership BBCA' },
    { command: 'partialexit',  description: '📤 Partial exit  |  /partialexit BBCA 3 9500' },
    { command: 'compound',     description: '📈 Compounding strategy & proyeksi' },
    { command: 'rebalance',    description: '⚖️ Cek & saran rebalancing portfolio' },
    { command: 'multiday',     description: '📊 Multi-day context  |  /multiday BBCA' },
  ]).then(() => console.log('\x1b[32m  ✔ Command menu Telegram berhasil diset\x1b[0m'))
    .catch(e => console.log('\x1b[33m  ⚠ Gagal set command menu: ' + e.message + '\x1b[0m'));

  bot.start();

  // ── Auto Update Checker (setiap 60 menit) ────────────────
  startAutoUpdateChecker(60, async (result) => {
    if (scanChatId && scanChatId !== '(skip)' && result.success) {
      try {
        await bot.api.sendMessage(scanChatId,
          `🆕 *SahamBot diupdate otomatis!*\n${result.beforeCommit} → ${result.afterCommit}\n${result.changelog ? result.changelog.slice(0,200) : ''}\n\n_Bot akan restart sebentar..._`,
          {parse_mode:'Markdown'}
        );
      } catch {}
    }
  });

  return bot;
}

async function handleIntent(ctx, uid, text, intent) {
  const sess = getSess(uid);
  const sym = text.toUpperCase().match(/\b([A-Z]{3,5})\b/)?.[1];

  if (intent==='STOCK_ANALYSIS') return sym ? doAnalysis(ctx,sym,'swing') : ctx.reply('❓ Sebutkan kode sahamnya');
  if (intent==='SCALP_ANALYSIS') return sym ? doAnalysis(ctx,sym,'scalping') : ctx.reply('❓ Sebutkan kode sahamnya');
  if (intent==='SCAN') return doScan(ctx);
  if (intent==='WATCHLIST_ADD' && sym) { addToWatchlist(sym); return ctx.reply(`✅ *${sym}* ditambahkan!`,{parse_mode:'Markdown'}); }
  if (intent==='WATCHLIST_REMOVE' && sym) { removeFromWatchlist(sym); return ctx.reply(`🗑️ *${sym}* dihapus.`,{parse_mode:'Markdown'}); }
  if (intent==='COMPARE_AI') return sym ? doCompare(ctx,sym) : ctx.reply('❓ Sebutkan kode saham');
  if (intent==='ENTRY_FLOW')  return sym ? handleEntry(ctx) : ctx.reply('❓ Contoh: "entry BBCA" atau /entry BBCA');
  if (intent==='EXIT_FLOW')   return sym ? handleExit(ctx)  : ctx.reply('❓ Contoh: "exit BBCA" atau /exit BBCA');
  if (intent==='POSITIONS')   return handlePositions(ctx);
  if (intent==='REPORT')      return handleReport(ctx);
  if (intent==='HISTORY')     return handleHistory(ctx);

  if (intent==='KONGLO') {
    // Extract konglo name from text
    const kongloMatch = text.match(/(SALIM|BAKRIE|HARTONO|DJARUM|THOHIR|SINARMAS|ASTRA|RIADY|AGUAN|PP|PRAJOGO|MAYAPADA|DJOKO|RACHMAT|EDDY|WINATA|MUKI|LIM|OEY|HAPPY|SJAMSUL|ISAM|HASHIM|CIPUTRA|NAGARIA)/i);
    const kongloQuery = kongloMatch ? kongloMatch[1].toUpperCase() : null;
    if (kongloQuery) {
      await ctx.reply(`🏦 Menganalisis konglomerat *${kongloQuery}*...`, {parse_mode:'Markdown'});
      try {
        const result = await analyzeKonglo(kongloQuery);
        const fullText = formatKongloTelegram(result);
        if (fullText.length <= 3800) {
          return ctx.reply(fullText);
        } else {
          const parts = fullText.split('----------------------------');
          const header = parts[0];
          let buffer = header;
          for (let i = 1; i < parts.length; i++) {
            const chunk = '----------------------------' + parts[i];
            if ((buffer + chunk).length > 3800) {
              await ctx.reply(buffer.trim());
              buffer = chunk;
            } else { buffer += chunk; }
          }
          if (buffer.trim()) return ctx.reply(buffer.trim());
        }
      } catch(e) { return ctx.reply(`❌ ${e.message}`); }
    }
    return ctx.reply(trunc(formatKongloListTelegram()), {parse_mode:'Markdown'});
  }

  if (intent==='TOP_GAINERS') {
    await ctx.reply('🚀 Mengambil Top Gainers...');
    try {
      const movers = await getTopMovers('gainers', 10);
      return ctx.reply(trunc(formatTopMoversTelegram(movers, 'gainers')), {parse_mode:'Markdown'});
    } catch(e) { return ctx.reply(`❌ ${e.message}`); }
  }

  if (intent==='TOP_LOSERS') {
    await ctx.reply('🔻 Mengambil Top Losers...');
    try {
      const movers = await getTopMovers('losers', 10);
      return ctx.reply(trunc(formatTopMoversTelegram(movers, 'losers')), {parse_mode:'Markdown'});
    } catch(e) { return ctx.reply(`❌ ${e.message}`); }
  }

  if (intent==='TOP_VOLUME') {
    await ctx.reply('📊 Mengambil Top Volume...');
    try {
      const movers = await getTopVolume(15);
      return ctx.reply(trunc(formatTopVolumeTelegram(movers)), {parse_mode:'Markdown'});
    } catch(e) { return ctx.reply(`❌ ${e.message}`); }
  }

  if (intent==='VOLUME_SPIKE') {
    await ctx.reply('⚡ Mencari Volume Spike...');
    try {
      const spikes = await getVolumeSpikes(2.0, 10);
      if (!spikes.length) return ctx.reply('_Tidak ada volume spike signifikan saat ini_', {parse_mode:'Markdown'});
      let text = '⚡ *Volume Spike Alert*\n\n';
      for (const q of spikes) {
        const chg = (q.changePct||0).toFixed(2);
        text += `${q.volSignal} *${q.symbol}*${q.isKonglo?' 🏦':''}\n`;
        text += `   Rp ${fmt(q.price)} (${parseFloat(chg)>=0?'+':''}${chg}%) | Vol ${q.volMillion}M (${safeFixed(q.volRatio, 1)}x)\n\n`;
      }
      return ctx.reply(trunc(text), {parse_mode:'Markdown'});
    } catch(e) { return ctx.reply(`❌ ${e.message}`); }
  }
  if (intent==='ARA_ARB') {
    if (sym) {
      const { calcAraArb, calcDistanceToLimits } = await import('../indicators/araArb.js');
      const { fetchQuote } = await import('../indicators/market.js');
      const q = await fetchQuote(sym);
      const prev = q.prev || q.price;
      const r = calcDistanceToLimits(calcAraArb(prev), q.price);
      return ctx.reply(trunc(
        `📊 *ARA & ARB — ${sym}*\nPrev: Rp ${fmt(prev)} | Sekarang: Rp ${fmt(q.price)}\n\n` +
        `🟢 ARA: Rp ${fmt(r.ara)} (+${safeFixed(r.araPct, 0)}%) — Jarak: +${r.distToAraPct}%${r.hitAra?' 🚨 KENA ARA!':r.nearAra?' ⚡ Mendekati ARA':''}\n` +
        `🔴 ARB: Rp ${fmt(r.arb)} (-${safeFixed(r.arbPct, 0)}%) — Jarak: -${r.distToArbPct}%${r.hitArb?' 🚨 KENA ARB!':r.nearArb?' ⚡ Mendekati ARB':''}\n` +
        `Fraksi: Rp ${r.fraksi}\n\n_Untuk multi saham: /ara BBCA,BBRI,TLKM_`
      ), {parse_mode:'Markdown'});
    }
    return ctx.reply('❓ Sebutkan kode sahamnya, contoh: "ARA BBCA" atau /ara BBCA,BBRI');
  }
  if (intent==='PERFORMANCE') { const wr=getWinRate(); return ctx.reply(`📊 Win Rate: *${wr.winRate}%* | Total: ${wr.total}`,{parse_mode:'Markdown'}); }
  if (intent==='CHANGE_LLM') {
    const pm = text.toLowerCase().match(/claude|openai|gpt|groq|gemini|ollama/);
    if (pm) { const p=pm[0]==='gpt'?'openai':pm[0]; sess.provider=p; updateUserMemory(uid,{preferred_llm:p}); return ctx.reply(`✅ AI → *${LLM_PROVIDERS[p]?.name||p}*`,{parse_mode:'Markdown'}); }
  }
  // Free chat
  await ctx.reply('Sedang berpikir...');
  try {
    const result = await freeChat(text, {provider:sess.provider, model:sess.model, userId:uid});
    ctx.reply(trunc(`${result.text}\n\n-- ${result.provider}/${result.model}`));
  } catch(fcErr) {
    ctx.reply(handleLLMError(fcErr, fcErr.message));
  }
}

async function doAnalysis(ctx, symbol, mode) {
  const uid = String(ctx.from?.id||'tg');
  const sess = getSess(uid);
  await ctx.reply(`🔍 Menganalisis *${symbol}*...`, {parse_mode:'Markdown'});
  try {
    let r;
    try {
      r = await analyzeStock(symbol, {provider:sess.provider, model:sess.model, userId:uid, riskProfile:sess.riskProfile, mode});
    } catch(llmErr) {
      const errMsg = handleLLMError(llmErr, llmErr.message);
      return ctx.reply(errMsg);
    }
    if (r.error) return ctx.reply(r.error);
    const {quote:q, indicators:ind, entry:e, score, signal, trend, analysis} = r;
    const si = signal==='BELI'?'🟢':signal==='JUAL/HINDARI'?'🔴':'🟡';

    // Volume detail
    const volActual = q?.volume || 0;
    const volAvg    = q?.avgVolume || 0;
    const volRatio  = ind?.volRatio || (volAvg > 0 ? volActual/volAvg : 1);
    const volValue  = volActual * (q?.price || 0);
    const volSignal = volRatio >= 3.0 ? '🔥 Sangat Tinggi' :
                      volRatio >= 2.0 ? '⚡ Spike' :
                      volRatio >= 1.5 ? '📊 Di atas rata-rata' :
                      volRatio < 0.5  ? '🔇 Rendah' : '⚪ Normal';

    const volLine = volActual > 0
      ? `Vol: *${(volActual/1e6).toFixed(2)}M lot* ${volSignal}` +
        (volAvg > 0 ? ` (${safeFixed(volRatio, 1)}x avg)` : '') +
        (volValue > 0 ? `\nNilai: Rp ${(volValue/1e9).toFixed(2)}B` : '')
      : 'Vol: N/A';

    // Plain text output (tanpa Markdown untuk hindari parse error)
    const volLine2 = volActual > 0
      ? `${(volActual/1e6).toFixed(2)}M lot ${volSignal}` +
        (volAvg > 0 ? ` (${safeFixed(volRatio, 1)}x avg)` : '') +
        (volValue > 0 ? ` | Nilai Rp ${(volValue/1e9).toFixed(2)}B` : '')
      : 'N/A';

    // Orderbook insight
    const obText = r.orderbookInsight
      ? ''
      : '';

    const outText =
      `[${signal}] ${symbol} - ${mode.toUpperCase()}\n` +
      `${r.provider}/${r.model}\n\n` +
      `Harga: Rp ${fmt(q?.price)} (${(q?.changePct||0).toFixed(2)}%) | Skor: ${score}/100\n` +
      `Open: ${fmt(q?.open)} | High: ${fmt(q?.high)} | Low: ${fmt(q?.low)}\n` +
      `Trend: ${trend}\n\n` +
      `Volume:\n${volLine2}\n\n` +
      `Indikator:\n` +
      `RSI: ${ind?.rsi?.toFixed(1)||'N/A'} | MACD: ${ind?.macd?.MACD?.toFixed(0)||'N/A'}\n` +
      `EMA9: ${fmt(ind?.ema9)} | EMA20: ${fmt(ind?.ema20)}\n` +
      `Support: ${fmt(ind?.support)} | Resist: ${fmt(ind?.resistance)}\n\n` +
      (obText ? obText + '\n' : '') +
      `Entry Plan (R:R 1:${e?.rr1}):\n` +
      `Entry: Rp ${fmt(e?.price)}\n` +
      `SL   : Rp ${fmt(e?.stopLoss)} (-${e?.riskPct}%)\n` +
      `TP1  : Rp ${fmt(e?.takeProfit1)} (+${e?.tp1Pct}%)\n` +
      `TP2  : Rp ${fmt(e?.takeProfit2)} (+${e?.tp2Pct}%)\n\n` +
      `Analisis AI:\n${analysis || 'Tidak ada analisis AI (cek API key)'}`;

    await ctx.reply(trunc(outText));
  } catch(e) {
    ctx.reply('Error: ' + handleLLMError(e, e.message));
  }
}

async function doScan(ctx) {
  await ctx.reply('🔎 Scanning watchlist...');
  try {
    const sess = getSess(String(ctx.from?.id||'tg'));
    const wl = getWatchlist();
    const results = await scanWatchlist(wl, {provider:sess.provider});
    let text = '🔎 *Hasil Scan Watchlist*\n\n';
    for (const r of results) {
      const ic = r.score>=70?'🟢':r.score>=50?'🟡':'🔴';
      text += `${ic} *${r.symbol}* ${r.score}/100 | ${r.signal}\n   SL:${fmt(r.entry?.stopLoss)} TP:${fmt(r.entry?.takeProfit1)}\n\n`;
      saveScanResult(r.symbol,r.score,r.signal,r.quote?.price);
    }
    const tops = results.filter(r=>r.score>=70);
    text += tops.length ? `⭐ *Top: ${tops.map(r=>r.symbol).join(', ')}*` : '_Tidak ada setup premium saat ini_';
    ctx.reply(trunc(text), {parse_mode:'Markdown'});
  } catch(e) { ctx.reply(`❌ ${e.message}`); }
}

async function doCompare(ctx, symbol) {
  await ctx.reply(`⚡ Membandingkan AI untuk *${symbol}*...`, {parse_mode:'Markdown'});
  try {
    const [q, ohlc] = await Promise.all([fetchQuote(symbol), fetchOHLC(symbol,'3mo')]);
    const ind = calcAllIndicators(ohlc);
    const {score,signal} = ind ? scoreScalping(q,ind) : {score:0,signal:'N/A'};
    const prompt = `Analisis scalping IDX: ${symbol} Harga:${fmt(q?.price)} RSI:${ind?.rsi?.toFixed(1)} MACD:${ind?.macd?.MACD?.toFixed(0)} Trend:${ind?.trend} Skor:${score} Signal:${signal}. Maks 80 kata, Bahasa Indonesia.`;

    const env2 = loadEnv();
    const providers = [];
    if (env2.ANTHROPIC_API_KEY) providers.push({provider:'claude', model:'claude-haiku-4-5-20251001'});
    if (env2.OPENAI_API_KEY) providers.push({provider:'openai', model:'gpt-4o-mini'});
    if (env2.GROQ_API_KEY) providers.push({provider:'groq', model:'llama-3.1-8b-instant'});
    if (!providers.length) return ctx.reply('❌ Tidak ada API key. Jalankan: node index.js setup');

    const results = await compareAI(providers, 'Analis saham IDX singkat Bahasa Indonesia.', prompt);
    let text = `⚡ *Compare AI — ${symbol}*\n\n`;
    for (const r of results) text += `${r.success?'✅':'❌'} *${r.provider.toUpperCase()}:*\n${r.text}\n\n`;
    ctx.reply(trunc(text), {parse_mode:'Markdown'});
  } catch(e) { ctx.reply(`❌ ${e.message}`); }
}

// ── Export helper untuk fullscan dari Telegram ───────────────
export async function runTelegramFullScan(bot, chatId, options = {}) {
  const { runFullScan, formatTelegramScan, IDX_ALL } = await import('../agents/fullscan.js');
  const { provider = 'claude', model = null, minScore = 55, topN = 10, sectors = null, withAI = false } = options;

  const sektorInfo = sectors ? sectors.join(', ') : 'Semua Sektor';
  const universeSize = sectors
    ? sectors.flatMap(s => IDX_ALL[s] || []).length
    : Object.values(IDX_ALL).flat().length;

  await bot.api.sendMessage(chatId,
    `🌏 *Full Market Scan IDX*\n_${universeSize} saham dipindai — ${sektorInfo}_\n\nMohon tunggu 1–3 menit...`,
    { parse_mode: 'Markdown' }
  );

  const result = await runFullScan({ provider, model, topN, minScore, sectors, withAI });
  const text = formatTelegramScan(result);

  await bot.api.sendMessage(chatId, trunc(text), { parse_mode: 'Markdown' });
  return result;
}
