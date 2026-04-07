#!/usr/bin/env node
// SahamBot v2 — Multi-AI IDX Stock Analyzer
import { program } from 'commander';
import chalk from 'chalk';
import gradient from 'gradient-string';
import figlet from 'figlet';
import { promisify } from 'util';
import { initDB, getWatchlist, addToWatchlist } from './src/db/database.js';
import { startTelegramBot } from './src/telegram/bot.js';
import { analyzeStock, scanWatchlist, calcPositionSize } from './src/agents/brain.js';
import { fetchQuote, fetchMultipleQuotes, calcAllIndicators, fetchOHLC, calcEntryPlan, scoreScalping } from './src/indicators/market.js';
import { LLM_PROVIDERS } from './src/llm/router.js';
import { loadEnv, saveEnv } from './src/config.js';
import Table from 'cli-table3';

const figletAsync = promisify(figlet);

async function banner() {
  const text = await figletAsync('SahamBot v2', { font: 'Small' });
  console.log(gradient.atlas.multiline(text));
  console.log(chalk.gray('  🤖 Multi-AI IDX Analyzer | Yahoo Finance | Telegram Bot\n'));
}

// Init DB dulu
await initDB();
await banner();

const fmt = n => Math.round(n || 0).toLocaleString('id-ID');

program.name('sahambot').description('Multi-AI IDX Stock Analyzer').version('2.0.0');

// ── setup ─────────────────────────────────────────────────────
program.command('setup').description('Wizard konfigurasi API keys').action(async () => {
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q, def = '') => new Promise(r => rl.question(`  ${q}${def ? chalk.gray(` [${def}]`) : ''}: `, a => r(a.trim() || def)));

  console.log(chalk.cyan('\n  🔧 Setup SahamBot v2\n'));
  const anthropic = await ask('ANTHROPIC_API_KEY (Claude)', '(skip)');
  const openai    = await ask('OPENAI_API_KEY (ChatGPT)', '(skip)');
  const groq      = await ask('GROQ_API_KEY (Groq - gratis)', '(skip)');
  const gemini    = await ask('GEMINI_API_KEY (Google)', '(skip)');
  const tgToken   = await ask('TELEGRAM_BOT_TOKEN', '(skip)');
  const tgChatId  = await ask('TELEGRAM_CHAT_ID (untuk auto scan)', '(skip)');
  rl.close();

  const vars = {};
  if (anthropic !== '(skip)') vars.ANTHROPIC_API_KEY = anthropic;
  if (openai !== '(skip)')    vars.OPENAI_API_KEY = openai;
  if (groq !== '(skip)')      vars.GROQ_API_KEY = groq;
  if (gemini !== '(skip)')    vars.GEMINI_API_KEY = gemini;
  if (tgToken !== '(skip)')   vars.TELEGRAM_BOT_TOKEN = tgToken;
  if (tgChatId !== '(skip)')  vars.TELEGRAM_CHAT_ID = tgChatId;
  saveEnv(vars);

  console.log(chalk.green('\n  ✔ Konfigurasi tersimpan!\n'));
  console.log(chalk.cyan('  Jalankan:'));
  console.log('  node index.js telegram   — Start Telegram bot');
  console.log('  node index.js scan       — Scan watchlist');
  console.log('  node index.js analyze BBCA --ai claude\n');
});

// ── telegram ─────────────────────────────────────────────────
program.command('telegram').description('Start Telegram Bot (dengan auto scan 5 menit)').action(() => {
  console.log(chalk.cyan('  🤖 Memulai Telegram Bot...\n'));
  startTelegramBot();
  console.log(chalk.green('  ✔ Bot aktif! Buka Telegram dan kirim /start'));
  console.log(chalk.gray('  Tekan Ctrl+C untuk menghentikan\n'));
  process.on('SIGINT', () => { console.log(chalk.yellow('\n  Bot dihentikan.')); process.exit(0); });
});

// ── analyze ──────────────────────────────────────────────────
program.command('analyze <kode>').description('Analisis mendalam satu saham')
  .option('--ai <provider>', 'Provider AI (claude/openai/groq/gemini)', 'claude')
  .option('--model <model>', 'Model spesifik')
  .option('--mode <mode>', 'Mode analisis (scalping/swing)', 'scalping')
  .option('--risk <profile>', 'Risk profile (conservative/moderate/aggressive)', 'moderate')
  .action(async (kode, opts) => {
    const symbol = kode.toUpperCase();
    console.log(chalk.cyan(`  🔍 Menganalisis ${symbol} via ${opts.ai}...\n`));
    try {
      const result = await analyzeStock(symbol, { provider: opts.ai, model: opts.model, riskProfile: opts.risk, mode: opts.mode, userId: 'cli' });
      if (result.error) return console.log(chalk.red('  ✖ ' + result.error));

      const { quote, indicators: ind, entry, score, signal, trend, analysis } = result;
      printAnalysisTable(symbol, quote, ind, entry, score, signal, trend);
      console.log(chalk.cyan('\n  🤖 Analisis AI:'));
      console.log(chalk.white('  ' + analysis.split('\n').join('\n  ')));
      console.log(chalk.gray(`\n  — via ${result.provider}/${result.model}`));
    } catch (e) {
      console.log(chalk.red('  ✖ ' + e.message));
    }
  });

// ── scan ─────────────────────────────────────────────────────
program.command('scan').description('Scan seluruh watchlist')
  .option('--ai <provider>', 'Provider AI', 'claude')
  .option('--risk <profile>', 'Risk profile', 'moderate')
  .action(async (opts) => {
    const wl = getWatchlist();
    console.log(chalk.cyan(`  🔎 Scanning ${wl.length} saham (${wl.join(', ')})...\n`));
    const results = await scanWatchlist(wl, { provider: opts.ai, riskProfile: opts.risk });

    const table = new Table({
      head: [chalk.cyan('Kode'), chalk.cyan('Harga'), chalk.cyan('%'), chalk.cyan('RSI'), chalk.cyan('Trend'), chalk.cyan('Skor'), chalk.cyan('Signal'), chalk.cyan('SL'), chalk.cyan('TP1')],
      style: { border: ['gray'] }
    });
    for (const r of results) {
      const sColor = r.score >= 70 ? chalk.green : r.score >= 50 ? chalk.yellow : chalk.red;
      table.push([
        chalk.bold(r.symbol),
        `Rp ${fmt(r.quote?.price)}`,
        r.quote?.changePct >= 0 ? chalk.green(`+${r.quote.changePct?.toFixed(2)}%`) : chalk.red(`${r.quote?.changePct?.toFixed(2)}%`),
        r.indicators?.rsi?.toFixed(1) || 'N/A',
        r.trend || 'N/A',
        sColor(r.score + '/100'),
        r.signal === 'BELI' ? chalk.green(r.signal) : r.signal === 'JUAL/HINDARI' ? chalk.red(r.signal) : chalk.yellow(r.signal),
        `Rp ${fmt(r.entry?.stopLoss)}`,
        `Rp ${fmt(r.entry?.takeProfit1)}`
      ]);
    }
    console.log(table.toString());
    const tops = results.filter(r => r.score >= 70);
    if (tops.length > 0) console.log(chalk.green(`\n  ⭐ Top Pick: ${tops.map(r => r.symbol).join(', ')}`));
  });

// ── watchlist ─────────────────────────────────────────────────
program.command('watchlist').description('Kelola watchlist')
  .option('-a, --add <kode>', 'Tambah saham')
  .option('-r, --remove <kode>', 'Hapus saham')
  .action(async (opts) => {
    if (opts.add) { addToWatchlist(opts.add.toUpperCase()); console.log(chalk.green(`  ✔ ${opts.add.toUpperCase()} ditambahkan`)); return; }
    const wl = getWatchlist();
    console.log(chalk.cyan(`\n  📋 Watchlist (${wl.length} saham): ${wl.join(', ')}\n`));
  });

// ── models ────────────────────────────────────────────────────
program.command('models').description('Lihat semua AI provider dan model').action(() => {
  console.log(chalk.cyan('\n  🤖 Multi-AI Providers:\n'));
  const env = loadEnv();
  for (const [key, cfg] of Object.entries(LLM_PROVIDERS)) {
    const hasKey = !cfg.envKey || env[cfg.envKey];
    const status = hasKey ? chalk.green('✔ Aktif') : chalk.red('✖ Perlu API Key');
    console.log(`  ${status}  ${chalk.bold(key.padEnd(10))} ${cfg.name}`);
    console.log(`           Models: ${cfg.models.join(', ')}\n`);
  }
});

// parseAsync dipindah ke bawah

function printAnalysisTable(symbol, quote, ind, entry, score, signal, trend) {
  const sColor = score >= 70 ? chalk.green : score >= 50 ? chalk.yellow : chalk.red;
  const sigColor = signal === 'BELI' ? chalk.green : signal === 'JUAL/HINDARI' ? chalk.red : chalk.yellow;

  console.log(chalk.bold.white(`\n  ${symbol} — Rp ${fmt(quote?.price)} (${quote?.changePct?.toFixed(2)}%)`));
  console.log(`  Skor: ${sColor.bold(score + '/100')} | Signal: ${sigColor.bold(signal)} | Trend: ${trend}`);

  const t = new Table({ style: { border: ['gray'] } });
  t.push(
    [chalk.cyan('RSI'), ind?.rsi?.toFixed(1)||'N/A', chalk.cyan('MACD'), ind?.macd?.MACD?.toFixed(0)||'N/A'],
    [chalk.cyan('EMA9'), fmt(ind?.ema9), chalk.cyan('EMA20'), fmt(ind?.ema20)],
    [chalk.cyan('Support'), `Rp ${fmt(ind?.support)}`, chalk.cyan('Resist'), `Rp ${fmt(ind?.resistance)}`],
    [chalk.cyan('Entry'), `Rp ${fmt(entry?.price)}`, chalk.cyan('SL'), chalk.red(`Rp ${fmt(entry?.stopLoss)} (-${entry?.riskPct}%)`)],
    [chalk.cyan('TP1'), chalk.green(`Rp ${fmt(entry?.takeProfit1)} (+${entry?.tp1Pct}%)`), chalk.cyan('TP2'), chalk.green(`Rp ${fmt(entry?.takeProfit2)} (+${entry?.tp2Pct}%)`)],
  );
  console.log(t.toString());
}

// ── fullscan ──────────────────────────────────────────────────
program.command('fullscan')
  .description('Scan 200+ saham IDX, AI pilih yang terbaik')
  .option('--ai <provider>', 'Provider AI untuk summary', 'claude')
  .option('--model <model>', 'Model spesifik')
  .option('--top <n>', 'Tampilkan top N saham', '15')
  .option('--min-score <n>', 'Skor minimum (0-100)', '55')
  .option('--sektor <nama>', 'Filter sektor tertentu (pisah koma)')
  .option('--with-ai', 'Aktifkan AI summary untuk top picks')
  .action(async (opts) => {
    const { runFullScan, printFullScanResult, IDX_ALL } = await import('./src/agents/fullscan.js');
    const sectors = opts.sektor ? opts.sektor.split(',').map(s => s.trim()) : null;
    const topN = parseInt(opts.top) || 15;
    const minScore = parseInt(opts.minScore) || 55;

    const sektorList = sectors ? sectors.join(', ') : 'Semua Sektor';
    console.log(chalk.cyan(`\n  🌏 Full Market Scan IDX — ${sektorList}`));
    console.log(chalk.gray(`  Filter: skor ≥ ${minScore} | Tampilkan top ${topN} | AI: ${opts.ai}`));
    console.log(chalk.gray('  Estimasi waktu: 1–3 menit tergantung koneksi\n'));

    let lastPct = 0;
    const result = await runFullScan({
      provider: opts.ai,
      model: opts.model,
      topN,
      minScore,
      sectors,
      withAI: opts.withAi || false,
      onProgress: (done, total) => {
        const pct = Math.floor((done / total) * 100);
        if (pct !== lastPct && pct % 10 === 0) {
          process.stdout.write(`\r  ${chalk.cyan('⏳')} Progress: ${pct}% (${done}/${total} saham)...`);
          lastPct = pct;
        }
      }
    });

    process.stdout.write('\r' + ' '.repeat(50) + '\r');
    printFullScanResult(result, opts);
  });

// ── sectors ───────────────────────────────────────────────────
program.command('sectors').description('Lihat daftar sektor IDX yang tersedia').action(async () => {
  const { IDX_ALL } = await import('./src/agents/fullscan.js');
  console.log(chalk.cyan('\n  📋 Sektor IDX Tersedia:\n'));
  for (const [sektor, kodes] of Object.entries(IDX_ALL)) {
    console.log(`  ${chalk.white.bold(sektor.padEnd(25))} ${chalk.gray(kodes.length + ' saham:')} ${kodes.join(', ')}`);
  }
  console.log(chalk.gray('\n  Contoh: node index.js fullscan --sektor Perbankan,Batubara'));
  console.log();
});


// ── ara ───────────────────────────────────────────────────────
program.command('ara <kode>')
  .description('Cek ARA & ARB suatu saham (bisa multi: BBCA,BBRI,TLKM)')
  .option('--ipo', 'Tandai sebagai saham IPO hari pertama (ARA 35%, no ARB)')
  .option('--khusus', 'Saham pemantauan khusus (±10%)')
  .action(async (kode, opts) => {
    const { calcAraArb, calcDistanceToLimits, formatAraArb, ARA_ARB_TABLE } = await import('./src/indicators/araArb.js');
    const { fetchMultipleQuotes } = await import('./src/indicators/market.js');

    const symbols = kode.toUpperCase().split(',').map(s => s.trim());
    console.log(chalk.cyan(`\n  📊 Kalkulasi ARA & ARB — ${symbols.join(', ')}\n`));

    const quotes = await fetchMultipleQuotes(symbols);

    for (const q of quotes) {
      const prev = q.prev || q.price;
      const current = q.price;
      const araArb = calcAraArb(prev, opts.ipo || false, opts.khusus || false);
      const result = calcDistanceToLimits(araArb, current);

      console.log(chalk.white(formatAraArb(result, q.symbol)));

      // Status alert
      if (result.hitAra)   console.log(chalk.green.bold('  🚨 SAHAM KENA ARA HARI INI!'));
      if (result.hitArb)   console.log(chalk.red.bold('  🚨 SAHAM KENA ARB HARI INI!'));
      if (result.nearAra)  console.log(chalk.yellow('  ⚡ Mendekati batas ARA'));
      if (result.nearArb)  console.log(chalk.yellow('  ⚡ Mendekati batas ARB'));

      console.log(chalk.gray('  ' + '─'.repeat(50)));
    }

    // Tampilkan tabel referensi
    console.log(chalk.cyan('\n  📋 Tabel ARA/ARB BEI (Aturan Umum):\n'));
    const { default: Table } = await import('cli-table3');
    const t = new Table({
      head: [chalk.cyan('Rentang Harga'), chalk.cyan('ARA'), chalk.cyan('ARB'), chalk.cyan('Fraksi'), chalk.cyan('Contoh')],
      style: { border: ['gray'] }
    });
    for (const row of ARA_ARB_TABLE) {
      t.push([row.range, chalk.green('+' + row.araPct + '%'), chalk.red('-' + row.arbPct + '%'), 'Rp ' + row.fraksi, chalk.gray(row.contoh)]);
    }
    console.log(t.toString());
    console.log(chalk.gray('  *IPO hari pertama: ARA +35%, tidak ada ARB'));
    console.log(chalk.gray('  *Saham pemantauan khusus: ±10%\n'));
  });

// ── update ────────────────────────────────────────────────────
program.command('update')
  .description('Update SahamBot ke versi terbaru dari GitHub')
  .option('--check', 'Hanya cek update tanpa menginstall')
  .option('--no-restart', 'Update tanpa restart otomatis')
  .action(async (opts) => {
    const { hasUpdate, doUpdate, getVersionInfo, getChangelog, getCurrentCommit, getRemoteCommit } = await import('./src/updater.js');

    const info = getVersionInfo();
    console.log(chalk.cyan('\n  🔄 SahamBot Updater\n'));
    console.log(`  Versi    : ${chalk.white(info.version)}`);
    console.log(`  Commit   : ${chalk.white(info.commit)}`);
    console.log(`  Branch   : ${chalk.white(info.branch)}`);
    console.log(`  Node.js  : ${chalk.white(info.nodeVersion)}`);

    if (!info.isGitRepo) {
      console.log(chalk.red('\n  ✖ Folder ini bukan git repo!'));
      console.log(chalk.gray('  Jalankan dulu:'));
      console.log(chalk.white('  git init'));
      console.log(chalk.white('  git remote add origin https://github.com/USERNAME/sahambot.git'));
      console.log(chalk.white('  git pull origin main'));
      return;
    }

    console.log(chalk.gray('\n  Mengecek update dari GitHub...'));
    const updateAvail = hasUpdate();

    if (!updateAvail) {
      console.log(chalk.green('\n  ✔ Sudah versi terbaru!'));
      return;
    }

    const changelog = getChangelog();
    console.log(chalk.yellow('\n  🆕 Update tersedia!'));
    console.log(chalk.gray('  Perubahan:'));
    changelog.split('\n').forEach(l => console.log(chalk.gray('    ' + l)));

    if (opts.check) {
      console.log(chalk.gray('\n  (Mode check only — jalankan tanpa --check untuk install)'));
      return;
    }

    console.log(chalk.cyan('\n  Mengupdate...'));
    const result = await doUpdate({ restart: !opts.noRestart });

    if (result.success) {
      console.log(chalk.green(`\n  ✔ ${result.message}`));
      if (result.depsUpdated) console.log(chalk.green('  ✔ Dependencies diupdate'));
    } else {
      console.log(chalk.red(`\n  ✖ ${result.message}`));
    }
  });

// ── version ───────────────────────────────────────────────────
program.command('version')
  .description('Lihat info versi SahamBot')
  .action(async () => {
    const { getVersionInfo, hasUpdate } = await import('./src/updater.js');
    const info = getVersionInfo();
    console.log(chalk.cyan('\n  📋 Info Versi SahamBot v2\n'));
    console.log(`  Versi    : ${chalk.white(info.version)}`);
    console.log(`  Commit   : ${chalk.white(info.commit)}`);
    console.log(`  Branch   : ${chalk.white(info.branch)}`);
    console.log(`  Node.js  : ${chalk.white(info.nodeVersion)}`);
    console.log(`  Git Repo : ${info.isGitRepo ? chalk.green('Ya') : chalk.red('Tidak')}`);
    if (info.isGitRepo) {
      const upd = hasUpdate();
      console.log(`  Status   : ${upd ? chalk.yellow('Ada update tersedia') : chalk.green('Sudah terbaru')}`);
    }
    console.log();
  });

program.parseAsync(process.argv);
