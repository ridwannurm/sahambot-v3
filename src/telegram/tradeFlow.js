// src/telegram/tradeFlow.js — Interactive Entry/Exit Flow v3.2
import { InlineKeyboard } from 'grammy';
import {
  getPendingEntry, setPendingEntry, clearPendingEntry,
  createTrade, createExit, createPartialExit,
  getOpenTrades, getOpenTradeBySymbol,
  updateTradeStatus, getPortfolio, getDailyTradeCount,
  incrementDailyTrade, getTradeHistory, getTradeStats,
  getStatsBySetup, calcEV, applyCompounding, autoRebalance,
  updatePortfolio, upsertOwnership
} from '../db/database.js';
import { decisionEngine, calcCompounding, buildMultiDayContext } from '../agents/trading.js';
import { fetchQuote } from '../indicators/market.js';
import { safeSend, fmt, fmtPct, fmtVol, handleLLMError } from './utils.js';

// ── /entry <kode> ─────────────────────────────────────────────
export async function handleEntry(ctx) {
  const userId = String(ctx.from.id);
  const symbol = ctx.match?.trim().toUpperCase();

  if (!symbol) {
    return safeSend(ctx, 'Gunakan format:\n/entry BBCA\n/entry TLKM');
  }

  const portfolio  = getPortfolio(userId);
  const openTrades = getOpenTrades(userId);
  const dailyCount = getDailyTradeCount(userId);

  if (openTrades.length >= portfolio.max_positions) {
    return safeSend(ctx, `Batas posisi tercapai. Max ${portfolio.max_positions} posisi, saat ini ${openTrades.length}.\nGunakan /positions untuk lihat posisi aktif.`);
  }
  if (dailyCount >= portfolio.daily_trade_limit) {
    return safeSend(ctx, `Batas trade harian tercapai. Max ${portfolio.daily_trade_limit} trade/hari, hari ini sudah ${dailyCount}.`);
  }

  await safeSend(ctx, `Mengambil data ${symbol}...`);

  let suggestedEntry = 0;
  let msgText = '';

  try {
    const result = await decisionEngine(symbol, userId);
    const { quote, entry, setupResult, finalScore, ara, arb } = result;
    const chg = (quote.changePct || 0).toFixed(2);
    suggestedEntry = entry.price;

    const obSummary = result.orderbookInsight
      ? `\nOrderbook Proxy:\n` +
        `Bias  : ${result.orderbookInsight.verdict} (${result.orderbookInsight.strength})\n` +
        `Buy   : ${result.orderbookInsight.buyPct}% vs Sell: ${result.orderbookInsight.sellPct}%\n` +
        `OBV   : ${result.orderbookInsight.pf?.obvTrend || 'N/A'}\n` +
        (result.orderbookInsight.hasLargeOrder
          ? `Large Order: ${result.orderbookInsight.largeOrderDir} terdeteksi\n` : '') +
        `\n`
      : '';

    msgText =
      `Saham ${symbol} saat ini di harga Rp ${fmt(quote.price)} (${parseFloat(chg) >= 0 ? '+' : ''}${chg}%).\n` +
      `Open: ${fmt(quote.open)} | High: ${fmt(quote.high)} | Low: ${fmt(quote.low)}\n\n` +
      `Skor teknikal: ${finalScore}/100\n` +
      `Setup: ${setupResult.setup.replace(/_/g, ' ')}\n\n` +
      obSummary +
      `Level penting:\n` +
      `- Support    : Rp ${fmt(result.indicators?.support)}\n` +
      `- Resistance : Rp ${fmt(result.indicators?.resistance)}\n` +
      `- Entry saran: Rp ${fmt(entry.price)}\n` +
      `- Stop Loss  : Rp ${fmt(entry.stopLoss)}\n` +
      `- TP1        : Rp ${fmt(entry.takeProfit1)}\n` +
      `- ARA (+15%) : Rp ${fmt(ara)}\n` +
      `- ARB (-15%) : Rp ${fmt(arb)}\n\n` +
      `Kamu mau beli atau jual ${symbol}?`;
  } catch (e) {
    const quote = await fetchQuote(symbol).catch(() => ({ price: 0, changePct: 0 }));
    suggestedEntry = quote.price;
    msgText = `Saham ${symbol} saat ini Rp ${fmt(quote.price)} (${(quote.changePct||0).toFixed(2)}%).\n\nKamu mau beli atau jual ${symbol}?`;
  }

  setPendingEntry(userId, { symbol, step: 'SIDE', suggestedEntry });

  const kb = new InlineKeyboard()
    .text('BELI (BUY)', `entry:buy:${symbol}`)
    .text('JUAL (SELL)', `entry:sell:${symbol}`)
    .row()
    .text('Batal', `entry:cancel:${symbol}`);

  await safeSend(ctx, msgText, { reply_markup: kb });
}

// ── Callback: BUY/SELL ────────────────────────────────────────
export async function handleEntrySide(ctx) {
  const userId = String(ctx.from.id);
  const [, side, symbol] = ctx.callbackQuery.data.split(':');

  if (side === 'cancel') {
    clearPendingEntry(userId);
    await ctx.answerCallbackQuery('Dibatalkan');
    return ctx.editMessageText('Entry dibatalkan.');
  }

  const pending   = getPendingEntry(userId);
  const suggested = pending?.suggestedEntry || 0;
  setPendingEntry(userId, { ...pending, symbol, side: side.toUpperCase(), step: 'PRICE' });
  await ctx.answerCallbackQuery();

  const msg =
    `${side === 'buy' ? 'BELI' : 'JUAL'} ${symbol}\n\n` +
    `Mau ${side === 'buy' ? 'beli' : 'jual'} di harga berapa?\n` +
    (suggested > 0 ? `Harga saran entry: Rp ${fmt(suggested)}\n\n` : '\n') +
    `Ketik harga entry (angka saja, contoh: ${suggested > 0 ? Math.round(suggested) : '9250'})`;

  await ctx.editMessageText(msg);
}

// ── Handler text pending entry ────────────────────────────────
export async function handlePendingEntryText(ctx) {
  const userId  = String(ctx.from.id);
  const text    = ctx.message.text.trim();
  const pending = getPendingEntry(userId);

  if (!pending || pending.side === 'EXIT') return false;

  const val = parseFloat(text.replace(/[.,\s]/g, ''));

  if (pending.step === 'PRICE') {
    if (isNaN(val) || val <= 0) {
      await safeSend(ctx, 'Harga tidak valid. Ketik angka saja, contoh: 9250');
      return true;
    }
    setPendingEntry(userId, { ...pending, price: val, step: 'LOTS' });
    await safeSend(ctx,
      `Harga: Rp ${fmt(val)}\n\n` +
      `Mau beli berapa lot?\n` +
      `(1 lot = 100 lembar saham)\n` +
      `Contoh: ketik 5 untuk 5 lot`
    );
    return true;
  }

  if (pending.step === 'LOTS') {
    const lots = parseInt(text);
    if (isNaN(lots) || lots <= 0) {
      await safeSend(ctx, 'Lot tidak valid. Ketik angka bulat, contoh: 5');
      return true;
    }
    const totalCost = lots * 100 * pending.price;
    setPendingEntry(userId, { ...pending, lots, step: 'SETUP' });

    const kb = new InlineKeyboard()
      .text('Konglo Momentum',    `setup:KONGLO_MOMENTUM:${pending.symbol}`)
      .row()
      .text('Breakout Valid',     `setup:BREAKOUT_VALID:${pending.symbol}`)
      .row()
      .text('Reversal Akumulasi', `setup:REVERSAL_AKUMULASI:${pending.symbol}`)
      .row()
      .text('Batal', `entry:cancel:${pending.symbol}`);

    await safeSend(ctx,
      `${lots} lot x Rp ${fmt(pending.price)} = Rp ${totalCost.toLocaleString('id-ID')}\n\n` +
      `Pilih setup trading:`,
      { reply_markup: kb }
    );
    return true;
  }

  return false;
}

// ── Callback: setup ───────────────────────────────────────────
export async function handleSetupSelect(ctx) {
  const userId  = String(ctx.from.id);
  const [, setup, symbol] = ctx.callbackQuery.data.split(':');
  const pending = getPendingEntry(userId);

  if (!pending) { await ctx.answerCallbackQuery('Session habis, ulangi /entry'); return; }

  setPendingEntry(userId, { ...pending, setup, step: 'CONFIDENCE' });
  await ctx.answerCallbackQuery();

  const kb = new InlineKeyboard()
    .text('High - yakin banget',   `conf:High:${symbol}`)
    .row()
    .text('Medium - cukup yakin', `conf:Medium:${symbol}`)
    .row()
    .text('Low - coba-coba',      `conf:Low:${symbol}`)
    .row()
    .text('Batal', `entry:cancel:${symbol}`);

  await ctx.editMessageText(
    `Setup: ${setup.replace(/_/g, ' ')}\n\nSeberapa yakin kamu dengan setup ini?`,
    { reply_markup: kb }
  );
}

// ── Callback: confidence → confirm ───────────────────────────
export async function handleConfidenceSelect(ctx) {
  const userId  = String(ctx.from.id);
  const [, conf, symbol] = ctx.callbackQuery.data.split(':');
  const pending = getPendingEntry(userId);

  if (!pending) { await ctx.answerCallbackQuery('Session habis, ulangi /entry'); return; }

  setPendingEntry(userId, { ...pending, confidence: conf, step: 'CONFIRM' });
  await ctx.answerCallbackQuery();

  const shares    = pending.lots * 100;
  const totalCost = shares * pending.price;

  const kb = new InlineKeyboard()
    .text('KONFIRMASI ENTRY', `confirm:entry:${symbol}`)
    .row()
    .text('Batal', `entry:cancel:${symbol}`);

  await ctx.editMessageText(
    `Konfirmasi Entry:\n\n` +
    `Saham : ${symbol}\n` +
    `Arah  : ${pending.side === 'BUY' ? 'BELI' : 'JUAL'}\n` +
    `Harga : Rp ${fmt(pending.price)}\n` +
    `Lot   : ${pending.lots} lot (${shares.toLocaleString()} lembar)\n` +
    `Total : Rp ${totalCost.toLocaleString('id-ID')}\n` +
    `Setup : ${pending.setup?.replace(/_/g, ' ')}\n` +
    `Level : ${conf}\n\n` +
    `Sudah yakin?`,
    { reply_markup: kb }
  );
}

// ── Callback: confirm entry ───────────────────────────────────
export async function handleConfirmEntry(ctx) {
  const userId  = String(ctx.from.id);
  const pending = getPendingEntry(userId);

  if (!pending || pending.step !== 'CONFIRM') {
    await ctx.answerCallbackQuery('Session habis'); return;
  }

  const tradeId = createTrade({
    userId, symbol: pending.symbol, side: pending.side,
    entryPrice: pending.price, lots: pending.lots,
    setup: pending.setup, confidence: pending.confidence,
  });

  incrementDailyTrade(userId);
  clearPendingEntry(userId);

  // Update kepemilikan
  try { upsertOwnership(userId, pending.symbol, pending.lots, pending.price, 'BUY'); } catch {}

  await ctx.answerCallbackQuery('Berhasil dicatat!');
  await ctx.editMessageText(
    `Entry dicatat! Trade #${tradeId}\n\n` +
    `${pending.symbol} ${pending.side} @ Rp ${fmt(pending.price)} x ${pending.lots} lot\n` +
    `Setup: ${pending.setup?.replace(/_/g, ' ')}\n\n` +
    `Gunakan /exit ${pending.symbol} untuk tutup posisi.`
  );
}

// ── /exit <kode> ─────────────────────────────────────────────
export async function handleExit(ctx) {
  const userId = String(ctx.from.id);
  const symbol = ctx.match?.trim().toUpperCase();

  if (!symbol) return safeSend(ctx, 'Format: /exit BBCA');

  const trade = getOpenTradeBySymbol(userId, symbol);
  if (!trade) {
    return safeSend(ctx, `Tidak ada posisi terbuka untuk ${symbol}.\nGunakan /positions untuk lihat posisi aktif.`);
  }

  const quote  = await fetchQuote(symbol).catch(() => ({ price: trade.entry_price }));
  const unrlzd = ((quote.price - trade.entry_price) / trade.entry_price * 100);
  const unrlRp = (quote.price - trade.entry_price) * trade.shares;

  setPendingEntry(userId, { symbol, tradeId: trade.id, step: 'EXIT_PRICE', side: 'EXIT' });

  await safeSend(ctx,
    `Posisi kamu di ${symbol}:\n\n` +
    `Entry : Rp ${fmt(trade.entry_price)} x ${trade.lots} lot\n` +
    `Harga : Rp ${fmt(quote.price)}\n` +
    `PnL   : Rp ${unrlRp.toLocaleString('id-ID')} (${fmtPct(unrlzd)}) ${unrlzd >= 0 ? 'untung' : 'rugi'}\n\n` +
    `Mau exit di harga berapa?\n` +
    `(Ketik harga, atau "sekarang" untuk Rp ${fmt(quote.price)})`
  );
}

// ── Handler text pending exit ─────────────────────────────────
export async function handlePendingExitText(ctx) {
  const userId  = String(ctx.from.id);
  const text    = ctx.message.text.trim().toLowerCase();
  const pending = getPendingEntry(userId);

  if (!pending || pending.side !== 'EXIT') return false;

  if (pending.step === 'EXIT_PRICE') {
    let price = 0;
    if (text === 'sekarang' || text === 'market' || text === 'now') {
      const q = await fetchQuote(pending.symbol).catch(() => null);
      price = q?.price || 0;
    } else {
      price = parseFloat(text.replace(/[.,\s]/g, ''));
    }

    if (isNaN(price) || price <= 0) {
      await safeSend(ctx, 'Harga tidak valid. Ketik angka atau "sekarang".');
      return true;
    }

    const trade  = getOpenTradeBySymbol(userId, pending.symbol);
    if (!trade)  { await safeSend(ctx, 'Trade tidak ditemukan.'); return true; }

    const pnlRp  = (price - trade.entry_price) * trade.shares;
    const pnlPct = ((price - trade.entry_price) / trade.entry_price * 100);

    setPendingEntry(userId, {
      ...pending, exitPrice: price, pnlRp, pnlPct,
      result: pnlRp >= 0 ? 'WIN' : 'LOSS',
      tradeId: trade.id, step: 'EXIT_TYPE'
    });

    const kb = new InlineKeyboard()
      .text('Take Profit',   `exit:TAKE_PROFIT:${pending.symbol}`)
      .row()
      .text('Stop Loss',     `exit:STOP_LOSS:${pending.symbol}`)
      .row()
      .text('Early Exit',    `exit:EARLY_EXIT:${pending.symbol}`)
      .row()
      .text('Re-entry Exit', `exit:RE_ENTRY_EXIT:${pending.symbol}`);

    await safeSend(ctx,
      `Exit ${pending.symbol} @ Rp ${fmt(price)}\n` +
      `PnL: Rp ${pnlRp.toLocaleString('id-ID')} (${fmtPct(pnlPct)}) ${pnlRp >= 0 ? 'WIN' : 'LOSS'}\n\n` +
      `Alasan exit:`,
      { reply_markup: kb }
    );
    return true;
  }

  return false;
}

// ── Callback: exit type ───────────────────────────────────────
export async function handleExitType(ctx) {
  const userId   = String(ctx.from.id);
  const [, exitType, symbol] = ctx.callbackQuery.data.split(':');
  const pending  = getPendingEntry(userId);

  if (!pending || pending.step !== 'EXIT_TYPE') {
    await ctx.answerCallbackQuery('Session habis'); return;
  }

  const trade = getOpenTradeBySymbol(userId, symbol);
  if (!trade) { await ctx.answerCallbackQuery('Trade tidak ditemukan'); return; }

  createExit({
    tradeId: trade.id, userId, symbol,
    exitPrice: pending.exitPrice, lotsClosed: trade.lots,
    exitType, pnlRp: pending.pnlRp, pnlPct: pending.pnlPct, isPartial: false
  });
  updateTradeStatus(trade.id, 'CLOSED', pending.result);
  // Update kepemilikan
  try { upsertOwnership(userId, symbol, trade.lots, pending.exitPrice, 'SELL'); } catch {}
  clearPendingEntry(userId);

  await ctx.answerCallbackQuery('Exit dicatat!');
  await ctx.editMessageText(
    `${pending.result === 'WIN' ? 'WIN' : 'LOSS'} - Exit ${symbol}\n\n` +
    `Harga exit : Rp ${fmt(pending.exitPrice)}\n` +
    `Alasan     : ${exitType.replace(/_/g, ' ')}\n` +
    `PnL        : Rp ${pending.pnlRp?.toLocaleString('id-ID')} (${fmtPct(pending.pnlPct)})\n\n` +
    `Lihat statistik: /report`
  );
}

// ── /positions ────────────────────────────────────────────────
export async function handlePositions(ctx) {
  const userId    = String(ctx.from.id);
  const trades    = getOpenTrades(userId);
  const portfolio = getPortfolio(userId);

  if (trades.length === 0) {
    return safeSend(ctx, 'Tidak ada posisi terbuka.\nGunakan /entry KODE untuk buka posisi baru.');
  }

  let text = `Posisi Terbuka (${trades.length}/${portfolio.max_positions}):\n\n`;
  for (const t of trades) {
    const quote = await fetchQuote(t.symbol).catch(() => ({ price: t.entry_price }));
    const unrl  = ((quote.price - t.entry_price) / t.entry_price * 100);
    text += `${unrl >= 0 ? 'Untung' : 'Rugi'} ${t.symbol} [#${t.id}]\n`;
    text += `${t.side} @ Rp ${fmt(t.entry_price)} x ${t.lots} lot\n`;
    text += `Sekarang: Rp ${fmt(quote.price)} (${fmtPct(unrl)})\n`;
    text += `Setup: ${t.setup?.replace(/_/g, ' ')}\n`;
    text += `/exit ${t.symbol}\n\n`;
  }

  await safeSend(ctx, text);
}

// ── /report ───────────────────────────────────────────────────
export async function handleReport(ctx) {
  const userId  = String(ctx.from.id);
  const stats   = getTradeStats(userId);
  const bySetup = getStatsBySetup(userId);
  const ev      = calcEV(userId);
  const port    = getPortfolio(userId);
  const daily   = getDailyTradeCount(userId);

  if (!stats || stats.total === 0) {
    return safeSend(ctx, 'Belum ada trade tercatat.\nGunakan /entry KODE untuk mulai.');
  }

  const wr  = ((stats.wins / stats.total) * 100).toFixed(1);
  let text  = `Performance Report:\n\n`;
  text += `Total : ${stats.total} trade\n`;
  text += `Win/Loss: ${stats.wins || 0}/${stats.losses || 0}\n`;
  text += `Win Rate: ${wr}%\n`;
  text += `Total PnL: Rp ${fmt(stats.total_pnl_rp)}\n`;
  text += `Avg PnL: ${fmtPct(stats.avg_pnl_pct)}\n\n`;

  if (ev) {
    text += `Expected Value: ${ev.ev}%\n`;
    text += `Avg win: +${ev.avgWin}% | Avg loss: -${ev.avgLoss}%\n\n`;
  }

  if (bySetup.length > 0) {
    text += `Per Setup:\n`;
    for (const s of bySetup) {
      const wr2 = s.total > 0 ? ((s.wins / s.total) * 100).toFixed(0) : 0;
      text += `${s.setup?.replace(/_/g, ' ')}: ${s.total} trade, WR ${wr2}%, PnL Rp ${fmt(s.total_pnl)}\n`;
    }
    text += '\n';
  }

  text += `Modal: Rp ${fmt(port.capital)}\n`;
  text += `Trade hari ini: ${daily}/${port.daily_trade_limit}`;

  await safeSend(ctx, text);
}

// ── /history ──────────────────────────────────────────────────
export async function handleHistory(ctx) {
  const userId = String(ctx.from.id);
  const limit  = parseInt(ctx.match?.trim()) || 10;
  const trades = getTradeHistory(userId, limit);

  if (trades.length === 0) return safeSend(ctx, 'Belum ada riwayat trade.');

  let text = `Riwayat ${trades.length} Trade Terakhir:\n\n`;
  for (const t of trades) {
    const icon = t.result === 'WIN' ? 'WIN' : t.result === 'LOSS' ? 'LOSS' : 'OPEN';
    const pnl  = t.pnl_pct ? ` ${fmtPct(t.pnl_pct)}` : '';
    text += `[${icon}] ${t.symbol} ${t.side} @ ${fmt(t.entry_price)} x ${t.lots}lot${pnl}\n`;
    text += `${t.setup?.replace(/_/g, ' ')} — ${t.entry_time?.split(' ')[0] || '-'}\n\n`;
  }

  await safeSend(ctx, text);
}

// ── /stats ────────────────────────────────────────────────────
export async function handleStats(ctx) {
  const userId = String(ctx.from.id);
  const symbol = ctx.match?.trim().toUpperCase() || null;
  const stats  = getTradeStats(userId, symbol);

  if (!stats || stats.total === 0) {
    return safeSend(ctx, symbol ? `Belum ada trade untuk ${symbol}.` : 'Belum ada trade tercatat.');
  }

  const wr = ((stats.wins / stats.total) * 100).toFixed(1);
  await safeSend(ctx,
    `Stats${symbol ? ' - ' + symbol : ' Keseluruhan'}:\n\n` +
    `Total: ${stats.total} | WR: ${wr}% (${stats.wins}W/${stats.losses}L)\n` +
    `PnL: Rp ${fmt(stats.total_pnl_rp)} | Avg: ${fmtPct(stats.avg_pnl_pct)}`
  );
}

// ── /partialexit ──────────────────────────────────────────────
export async function handlePartialExit(ctx) {
  const userId = String(ctx.from.id);
  const args   = ctx.match?.trim().split(' ');
  const symbol = args[0]?.toUpperCase();
  const lots   = parseInt(args[1]);
  const price  = parseFloat(args[2]);

  if (!symbol || !lots || !price) {
    return safeSend(ctx, 'Format: /partialexit KODE LOT HARGA\nContoh: /partialexit BBCA 3 9500');
  }

  const trade = getOpenTradeBySymbol(userId, symbol);
  if (!trade) return safeSend(ctx, `Tidak ada posisi terbuka untuk ${symbol}`);
  if (lots >= trade.lots) return safeSend(ctx, `Untuk exit penuh gunakan /exit ${symbol}`);

  const pnlRp  = (price - trade.entry_price) * (lots * 100);
  const pnlPct = ((price - trade.entry_price) / trade.entry_price * 100);

  const kb = new InlineKeyboard()
    .text('Take Profit',  `pexit:TAKE_PROFIT:${symbol}:${lots}:${price}`)
    .row()
    .text('Early Exit',   `pexit:EARLY_EXIT:${symbol}:${lots}:${price}`)
    .row()
    .text('Re-entry',     `pexit:RE_ENTRY_EXIT:${symbol}:${lots}:${price}`);

  await safeSend(ctx,
    `Partial Exit ${symbol}:\n\n` +
    `Exit ${lots} dari ${trade.lots} lot @ Rp ${fmt(price)}\n` +
    `PnL: Rp ${pnlRp.toLocaleString('id-ID')} (${fmtPct(pnlPct)})\n` +
    `Sisa: ${trade.lots - lots} lot\n\nAlasan exit:`,
    { reply_markup: kb }
  );
}

export async function handlePartialExitCallback(ctx) {
  const userId = String(ctx.from.id);
  const [, exitType, symbol, lotsStr, priceStr] = ctx.callbackQuery.data.split(':');
  const lots   = parseInt(lotsStr);
  const price  = parseFloat(priceStr);
  const trade  = getOpenTradeBySymbol(userId, symbol);

  if (!trade) { await ctx.answerCallbackQuery('Trade tidak ditemukan'); return; }

  const pnlRp  = (price - trade.entry_price) * (lots * 100);
  const pnlPct = ((price - trade.entry_price) / trade.entry_price * 100);
  const result = createPartialExit({ tradeId: trade.id, userId, symbol, exitPrice: price, lotsClosed: lots, exitType, pnlRp, pnlPct });

  await ctx.answerCallbackQuery('Partial exit dicatat!');
  await ctx.editMessageText(
    `Partial exit dicatat!\n\n` +
    `${symbol}: ${lots} lot @ Rp ${fmt(price)}\n` +
    `PnL: Rp ${pnlRp.toLocaleString('id-ID')} (${fmtPct(pnlPct)})\n` +
    `Sisa: ${result?.remaining || 0} lot`
  );
}

// ── /compound ─────────────────────────────────────────────────
export async function handleCompound(ctx) {
  const userId = String(ctx.from.id);
  const port   = getPortfolio(userId);
  const ev     = calcEV(userId);
  const result = applyCompounding(userId);

  let text = `Compounding Strategy:\n\nModal saat ini: Rp ${fmt(port.capital)}\n`;
  if (result) {
    text += `Total PnL realisasi: Rp ${fmt(result.totalPnl)}\n`;
    text += `Modal setelah compound: Rp ${fmt(result.newCapital)}\n\n`;
  }
  if (ev) {
    const proj = calcCompounding(port.capital, parseFloat(ev.winrate) / 100, parseFloat(ev.avgWin), parseFloat(ev.avgLoss), port.risk_per_trade_pct, 20);
    text += `Proyeksi 20 trade (EV ${ev.ev}%):\nModal: Rp ${fmt(proj.initialCapital)} -> Rp ${fmt(proj.finalEquity)} (${proj.growth}%)`;
  } else {
    text += `Belum ada data EV (butuh min 5 trade selesai)`;
  }

  await safeSend(ctx, text);
}

// ── /rebalance ────────────────────────────────────────────────
export async function handleRebalance(ctx) {
  const userId = String(ctx.from.id);
  const result = autoRebalance(userId);

  if (result.status === 'no_positions') return safeSend(ctx, 'Tidak ada posisi terbuka.');

  let text = `Auto Rebalancing:\nPosisi: ${result.openPositions}/${result.maxPositions}\n\n`;
  if (result.suggestions.length === 0) {
    text += `Semua posisi dalam batas normal.`;
  } else {
    for (const s of result.suggestions) {
      text += `- ${s.symbol || ''} ${s.action}: ${s.reason}\n`;
      if (s.suggestion) text += `  ${s.suggestion}\n`;
    }
  }
  await safeSend(ctx, text);
}

// ── /multiday ─────────────────────────────────────────────────
export async function handleMultiDay(ctx) {
  const symbol = ctx.match?.trim().toUpperCase();
  if (!symbol) return safeSend(ctx, 'Format: /multiday BBCA');

  await safeSend(ctx, `Mengambil konteks multi-day untuk ${symbol}...`);
  try {
    const data = await buildMultiDayContext(symbol);
    if (!data) return safeSend(ctx, 'Data tidak cukup');
    await safeSend(ctx,
      `Multi-Day Context ${symbol}:\n\n` +
      `Trend 5D:  ${data.trend5d}\n` +
      `Trend 10D: ${data.trend10d}\n` +
      `Vol 5D:    ${fmtVol(data.avgVol5d)}\n` +
      `Vol 10D:   ${fmtVol(data.avgVol10d)}\n` +
      `Support 5D:   Rp ${fmt(data.support5d)}\n` +
      `Resist 5D:    Rp ${fmt(data.resistance5d)}`
    );
  } catch (e) { await safeSend(ctx, `Error: ${e.message}`); }
}

// ── /setcapital ───────────────────────────────────────────────
export async function handleSetCapital(ctx) {
  const userId  = String(ctx.from.id);
  const capital = parseInt(ctx.match?.trim().replace(/[.,]/g, ''));
  if (isNaN(capital) || capital < 1000000) {
    return safeSend(ctx, 'Format: /setcapital 50000000 (min Rp 1.000.000)');
  }
  updatePortfolio(userId, { capital });
  await safeSend(ctx, `Modal diupdate: Rp ${capital.toLocaleString('id-ID')}\nRisk 1% = Rp ${(capital * 0.01).toLocaleString('id-ID')}`);
}
