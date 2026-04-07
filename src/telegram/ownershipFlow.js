// src/telegram/ownershipFlow.js — Kepemilikan Saham
import { InlineKeyboard } from 'grammy';
import {
  getOwnership, getOwnershipBySymbol, addManualOwnership,
  upsertOwnership, getOwnershipHistory,
  initOwnershipTable, getPendingEntry, setPendingEntry, clearPendingEntry
} from '../db/database.js';
import { fetchMultipleQuotes, fetchQuote } from '../indicators/market.js';
import { safeSend, fmt, fmtPct } from './utils.js';

// ── Inisialisasi tabel ────────────────────────────────────────
export function initOwnership() {
  initOwnershipTable();
}

// ── /ownership — menu utama ───────────────────────────────────
export async function handleOwnership(ctx) {
  const userId = String(ctx.from.id);
  const args   = ctx.match?.trim().toUpperCase() || '';

  // /ownership BBCA — lihat detail saham tertentu
  if (args && args.length <= 6 && !args.includes(' ')) {
    return handleOwnershipDetail(ctx, userId, args);
  }

  const list = getOwnership(userId);

  if (list.length === 0) {
    const kb = new InlineKeyboard()
      .text('Tambah Saham yang Dimiliki', `own:add_start:`)
      .row()
      .text('Batal', `own:cancel:`);

    return safeSend(ctx,
      `Kepemilikan Saham Kamu\n\n` +
      `Kamu belum punya saham tercatat di sini.\n\n` +
      `Apakah kamu sudah punya saham yang dibeli sebelumnya?\n` +
      `Saya bisa bantu tracking avg price, unrealized PnL, dan saran posisi.`,
      { reply_markup: kb }
    );
  }

  // Ambil harga terkini
  const symbols = list.map(l => l.symbol);
  const quotes  = await fetchMultipleQuotes(symbols);
  const qMap    = {};
  quotes.forEach(q => { if (q?.symbol) qMap[q.symbol] = q; });

  let text = `Kepemilikan Saham Kamu (${list.length} emiten):\n\n`;
  let totalCost = 0, totalValue = 0;

  for (const item of list) {
    const q         = qMap[item.symbol];
    const curPrice  = q?.price || item.avg_price;
    const curValue  = item.lots * 100 * curPrice;
    const costBasis = item.lots * 100 * item.avg_price;
    const unrlzd    = ((curPrice - item.avg_price) / item.avg_price * 100);
    const unrlzdRp  = curValue - costBasis;

    totalCost  += costBasis;
    totalValue += curValue;

    const icon = unrlzd >= 0 ? 'Untung' : 'Rugi';
    text += `${item.symbol}\n`;
    text += `  Avg  : Rp ${fmt(item.avg_price)} x ${item.lots} lot\n`;
    text += `  Harga: Rp ${fmt(curPrice)} (${fmtPct(q?.changePct || 0)} hari ini)\n`;
    text += `  PnL  : Rp ${unrlzdRp.toLocaleString('id-ID')} (${fmtPct(unrlzd)}) - ${icon}\n\n`;
  }

  const totalUnrl   = totalValue - totalCost;
  const totalUnrlPct = totalCost > 0 ? ((totalUnrl / totalCost) * 100) : 0;

  text += `Total Portofolio:\n`;
  text += `  Modal   : Rp ${totalCost.toLocaleString('id-ID')}\n`;
  text += `  Nilai   : Rp ${totalValue.toLocaleString('id-ID')}\n`;
  text += `  PnL     : Rp ${totalUnrl.toLocaleString('id-ID')} (${fmtPct(totalUnrlPct)})\n\n`;

  const kb = new InlineKeyboard()
    .text('+ Tambah Saham',       `own:add_start:`)
    .text('- Kurangi / Jual',     `own:sell_start:`)
    .row()
    .text('Lihat Detail',         `own:detail_menu:`)
    .text('Riwayat Transaksi',    `own:history:`);

  await safeSend(ctx, text, { reply_markup: kb });
}

// ── Detail satu saham ─────────────────────────────────────────
async function handleOwnershipDetail(ctx, userId, symbol) {
  const item = getOwnershipBySymbol(userId, symbol);

  if (!item || item.lots === 0) {
    return safeSend(ctx, `Kamu tidak punya saham ${symbol}.\nGunakan /ownership untuk lihat semua.`);
  }

  const q        = await fetchQuote(symbol).catch(() => ({ price: item.avg_price }));
  const curPrice = q.price || item.avg_price;
  const curValue = item.lots * 100 * curPrice;
  const cost     = item.lots * 100 * item.avg_price;
  const unrlzd   = ((curPrice - item.avg_price) / item.avg_price * 100);
  const unrlRp   = curValue - cost;

  // Saran dari bot
  let saran = '';
  if (unrlzd >= 10) {
    saran = `\nSaran: Pertimbangkan partial exit di TP ini (+${unrlzd.toFixed(1)}%) untuk lock profit.`;
  } else if (unrlzd <= -7) {
    saran = `\nSaran: Sudah turun ${Math.abs(unrlzd).toFixed(1)}%. Evaluasi apakah perlu cut loss atau average down.`;
  } else if (unrlzd >= 3) {
    saran = `\nSaran: Posisi bagus, trailing stop bisa dipasang di sekitar Rp ${fmt(item.avg_price * 1.02)}.`;
  } else {
    saran = `\nSaran: Posisi masih dalam range normal, pantau support Rp ${fmt(q.low || curPrice * 0.97)}.`;
  }

  const hist = getOwnershipHistory(userId, symbol, 3);
  let histText = '';
  if (hist.length > 0) {
    histText = '\nRiwayat terakhir:\n';
    for (const h of hist) {
      histText += `${h.action} ${h.lots}lot @ ${fmt(h.price)} (${h.timestamp?.split(' ')[0]})\n`;
    }
  }

  const kb = new InlineKeyboard()
    .text('Tambah Lot',  `own:add_lots:${symbol}`)
    .text('Jual Lot',    `own:sell_lots:${symbol}`)
    .row()
    .text('Kembali',     `own:back:`);

  await safeSend(ctx,
    `Detail Kepemilikan ${symbol}:\n\n` +
    `Lot     : ${item.lots} lot (${(item.lots * 100).toLocaleString()} lembar)\n` +
    `Avg Buy : Rp ${fmt(item.avg_price)}\n` +
    `Harga   : Rp ${fmt(curPrice)} (${fmtPct(q.changePct || 0)})\n` +
    `Nilai   : Rp ${curValue.toLocaleString('id-ID')}\n` +
    `Modal   : Rp ${cost.toLocaleString('id-ID')}\n` +
    `PnL     : Rp ${unrlRp.toLocaleString('id-ID')} (${fmtPct(unrlzd)})\n` +
    saran + histText,
    { reply_markup: kb }
  );
}

// ── Callback handlers ─────────────────────────────────────────
export async function handleOwnershipCallback(ctx) {
  const userId = String(ctx.from.id);
  const data   = ctx.callbackQuery.data;
  const parts  = data.split(':');
  const action = parts[1];
  const symbol = parts[2] || '';

  await ctx.answerCallbackQuery();

  if (action === 'cancel' || action === 'back') {
    clearPendingEntry(userId);
    return ctx.editMessageText('OK. Gunakan /ownership kapan saja.');
  }

  if (action === 'add_start') {
    setPendingEntry(userId, { step: 'OWN_SYMBOL', side: 'OWNERSHIP' });
    return ctx.editMessageText(
      'Tambah Kepemilikan Saham\n\n' +
      'Ketik kode saham yang sudah kamu miliki:\n' +
      'Contoh: BBCA'
    );
  }

  if (action === 'sell_start') {
    const list = getOwnership(userId);
    if (list.length === 0) return ctx.editMessageText('Belum ada saham. Tambah dulu dengan /ownership.');
    setPendingEntry(userId, { step: 'OWN_SELL_SYMBOL', side: 'OWNERSHIP' });
    const listText = list.map(l => `- ${l.symbol} (${l.lots} lot, avg ${fmt(l.avg_price)})`).join('\n');
    return ctx.editMessageText(`Saham yang kamu miliki:\n\n${listText}\n\nKetik kode saham yang mau dijual:`);
  }

  if (action === 'add_lots') {
    setPendingEntry(userId, { step: 'OWN_ADD_LOTS', side: 'OWNERSHIP', symbol });
    return ctx.editMessageText(`Tambah lot ${symbol}\n\nSekarang kamu punya ${getOwnershipBySymbol(userId, symbol)?.lots || 0} lot.\n\nBerapa lot yang mau ditambah?`);
  }

  if (action === 'sell_lots') {
    const own = getOwnershipBySymbol(userId, symbol);
    setPendingEntry(userId, { step: 'OWN_SELL_LOTS', side: 'OWNERSHIP', symbol });
    return ctx.editMessageText(`Jual lot ${symbol}\n\nKamu punya ${own?.lots || 0} lot.\n\nBerapa lot yang mau dijual?`);
  }

  if (action === 'history') {
    const list = getOwnership(userId);
    if (list.length === 0) return ctx.editMessageText('Belum ada kepemilikan.');
    let text = 'Pilih saham untuk lihat riwayat:';
    const kb = new InlineKeyboard();
    list.forEach(l => kb.text(l.symbol, `own:hist_detail:${l.symbol}`).row());
    kb.text('Kembali', 'own:back:');
    return ctx.editMessageText(text, { reply_markup: kb });
  }

  if (action === 'hist_detail') {
    const hist = getOwnershipHistory(userId, symbol, 10);
    if (!hist.length) return ctx.editMessageText(`Belum ada riwayat untuk ${symbol}.`);
    let text = `Riwayat Transaksi ${symbol}:\n\n`;
    for (const h of hist) {
      text += `[${h.action}] ${h.lots}lot @ Rp ${fmt(h.price)}\n`;
      if (h.avg_before !== h.avg_after) {
        text += `  Avg: ${fmt(h.avg_before)} -> ${fmt(h.avg_after)}\n`;
      }
      text += `  ${h.timestamp?.split(' ')[0]}\n\n`;
    }
    return ctx.editMessageText(text);
  }

  if (action === 'detail_menu') {
    const list = getOwnership(userId);
    if (!list.length) return ctx.editMessageText('Belum ada kepemilikan.');
    const kb = new InlineKeyboard();
    list.forEach(l => kb.text(l.symbol, `own:detail_sym:${l.symbol}`).row());
    kb.text('Kembali', 'own:back:');
    return ctx.editMessageText('Pilih saham untuk lihat detail:', { reply_markup: kb });
  }

  if (action === 'detail_sym') {
    return handleOwnershipDetail(ctx, userId, symbol);
  }
}

// ── Text handler untuk ownership flow ────────────────────────
export async function handleOwnershipText(ctx) {
  const userId  = String(ctx.from.id);
  const text    = ctx.message.text.trim();
  const pending = getPendingEntry(userId);

  if (!pending || pending.side !== 'OWNERSHIP') return false;

  // Step: input symbol baru
  if (pending.step === 'OWN_SYMBOL') {
    const symbol = text.toUpperCase().replace(/[^A-Z]/g, '');
    if (symbol.length < 2 || symbol.length > 6) {
      await safeSend(ctx, 'Kode saham tidak valid. Contoh: BBCA, TLKM, GOTO');
      return true;
    }
    const q = await fetchQuote(symbol).catch(() => null);
    setPendingEntry(userId, { ...pending, symbol, step: 'OWN_LOTS' });
    const priceInfo = q?.price ? ` (harga sekarang Rp ${fmt(q.price)})` : '';
    await safeSend(ctx, `${symbol}${priceInfo}\n\nBerapa lot yang kamu punya?\n(1 lot = 100 lembar)`);
    return true;
  }

  // Step: input lot
  if (pending.step === 'OWN_LOTS') {
    const lots = parseInt(text);
    if (isNaN(lots) || lots <= 0) {
      await safeSend(ctx, 'Jumlah lot tidak valid. Ketik angka, contoh: 10');
      return true;
    }
    setPendingEntry(userId, { ...pending, lots, step: 'OWN_AVG' });
    await safeSend(ctx,
      `${pending.symbol}: ${lots} lot\n\n` +
      `Berapa rata-rata harga beli kamu (avg price)?\n` +
      `Contoh: 9000`
    );
    return true;
  }

  // Step: input avg price
  if (pending.step === 'OWN_AVG') {
    const avg = parseFloat(text.replace(/[.,\s]/g, ''));
    if (isNaN(avg) || avg <= 0) {
      await safeSend(ctx, 'Harga tidak valid. Ketik angka, contoh: 9000');
      return true;
    }

    // Simpan
    addManualOwnership(userId, pending.symbol, pending.lots, avg);
    clearPendingEntry(userId);

    // Ambil harga sekarang untuk saran
    const q      = await fetchQuote(pending.symbol).catch(() => null);
    const curP   = q?.price || avg;
    const unrlzd = ((curP - avg) / avg * 100);
    const modal  = pending.lots * 100 * avg;
    const nilai  = pending.lots * 100 * curP;

    let saran = '';
    if (unrlzd >= 10)      saran = `Posisi sudah +${unrlzd.toFixed(1)}%, pertimbangkan partial exit untuk lock profit.`;
    else if (unrlzd <= -7) saran = `Posisi -${Math.abs(unrlzd).toFixed(1)}%. Evaluasi apakah hold atau cut loss.`;
    else                   saran = `Posisi masih dalam range wajar. Pantau terus perkembangannya.`;

    await safeSend(ctx,
      `Tersimpan!\n\n` +
      `${pending.symbol}: ${pending.lots} lot @ Rp ${fmt(avg)}\n` +
      `Harga sekarang: Rp ${fmt(curP)}\n` +
      `Modal: Rp ${modal.toLocaleString('id-ID')}\n` +
      `Nilai: Rp ${nilai.toLocaleString('id-ID')}\n` +
      `PnL  : ${fmtPct(unrlzd)}\n\n` +
      `Saran: ${saran}\n\n` +
      `Ketik /ownership untuk lihat semua kepemilikan.`
    );
    return true;
  }

  // Step: symbol untuk jual
  if (pending.step === 'OWN_SELL_SYMBOL') {
    const symbol = text.toUpperCase().replace(/[^A-Z]/g, '');
    const own    = getOwnershipBySymbol(userId, symbol);
    if (!own || own.lots === 0) {
      await safeSend(ctx, `Kamu tidak punya saham ${symbol}.`);
      return true;
    }
    setPendingEntry(userId, { ...pending, symbol, step: 'OWN_SELL_LOTS' });
    await safeSend(ctx, `${symbol}: ${own.lots} lot, avg Rp ${fmt(own.avg_price)}\n\nBerapa lot yang mau dijual?`);
    return true;
  }

  // Step: lot yang dijual
  if (pending.step === 'OWN_SELL_LOTS') {
    const lots = parseInt(text);
    const own  = getOwnershipBySymbol(userId, pending.symbol);
    if (isNaN(lots) || lots <= 0) {
      await safeSend(ctx, 'Lot tidak valid.');
      return true;
    }
    if (lots > own.lots) {
      await safeSend(ctx, `Kamu hanya punya ${own.lots} lot. Tidak bisa jual ${lots} lot.`);
      return true;
    }
    setPendingEntry(userId, { ...pending, lots, step: 'OWN_SELL_PRICE' });
    const q = await fetchQuote(pending.symbol).catch(() => null);
    await safeSend(ctx,
      `Jual ${lots} lot ${pending.symbol}\n\n` +
      `Harga sekarang: Rp ${fmt(q?.price)}\n\n` +
      `Di harga berapa dijual? (ketik angka atau "sekarang")`
    );
    return true;
  }

  // Step: harga jual
  if (pending.step === 'OWN_SELL_PRICE') {
    let price = 0;
    if (text.toLowerCase() === 'sekarang') {
      const q = await fetchQuote(pending.symbol).catch(() => null);
      price   = q?.price || 0;
    } else {
      price = parseFloat(text.replace(/[.,\s]/g, ''));
    }

    if (isNaN(price) || price <= 0) {
      await safeSend(ctx, 'Harga tidak valid.');
      return true;
    }

    const own    = getOwnershipBySymbol(userId, pending.symbol);
    const pnlRp  = (price - own.avg_price) * (pending.lots * 100);
    const pnlPct = ((price - own.avg_price) / own.avg_price * 100);

    upsertOwnership(userId, pending.symbol, pending.lots, price, 'SELL');
    clearPendingEntry(userId);

    const sisa = (own.lots - pending.lots);
    await safeSend(ctx,
      `Penjualan dicatat!\n\n` +
      `${pending.symbol}: Jual ${pending.lots} lot @ Rp ${fmt(price)}\n` +
      `PnL    : Rp ${pnlRp.toLocaleString('id-ID')} (${fmtPct(pnlPct)})\n` +
      `Sisa   : ${sisa} lot\n\n` +
      (sisa > 0
        ? `Sisa avg price: Rp ${fmt(own.avg_price)} (tidak berubah saat jual sebagian).`
        : `Posisi ${pending.symbol} sudah kosong.`)
    );
    return true;
  }

  // Step: tambah lot ke saham yang sudah ada
  if (pending.step === 'OWN_ADD_LOTS') {
    const lots = parseInt(text);
    if (isNaN(lots) || lots <= 0) {
      await safeSend(ctx, 'Lot tidak valid.');
      return true;
    }
    const own = getOwnershipBySymbol(userId, pending.symbol);
    setPendingEntry(userId, { ...pending, lots, step: 'OWN_ADD_PRICE' });
    const q = await fetchQuote(pending.symbol).catch(() => null);
    await safeSend(ctx,
      `Tambah ${lots} lot ${pending.symbol}\n` +
      `Saat ini punya: ${own?.lots || 0} lot @ avg ${fmt(own?.avg_price)}\n` +
      `Harga sekarang: Rp ${fmt(q?.price)}\n\n` +
      `Di harga berapa belinya? (ketik angka atau "sekarang")`
    );
    return true;
  }

  // Step: harga tambah lot
  if (pending.step === 'OWN_ADD_PRICE') {
    let price = 0;
    if (text.toLowerCase() === 'sekarang') {
      const q = await fetchQuote(pending.symbol).catch(() => null);
      price   = q?.price || 0;
    } else {
      price = parseFloat(text.replace(/[.,\s]/g, ''));
    }

    if (isNaN(price) || price <= 0) {
      await safeSend(ctx, 'Harga tidak valid.');
      return true;
    }

    const oldOwn = getOwnershipBySymbol(userId, pending.symbol);
    const oldAvg = oldOwn?.avg_price || 0;
    const oldLot = oldOwn?.lots || 0;

    upsertOwnership(userId, pending.symbol, pending.lots, price, 'BUY');
    clearPendingEntry(userId);

    const newOwn  = getOwnershipBySymbol(userId, pending.symbol);
    const newAvg  = newOwn?.avg_price || price;
    const newLots = newOwn?.lots || pending.lots;

    await safeSend(ctx,
      `Lot bertambah!\n\n` +
      `${pending.symbol}:\n` +
      `Lot sebelum : ${oldLot} lot @ avg ${fmt(oldAvg)}\n` +
      `Tambah      : ${pending.lots} lot @ Rp ${fmt(price)}\n` +
      `Total lot   : ${newLots} lot\n` +
      `Avg baru    : Rp ${fmt(newAvg)}\n\n` +
      `Ketik /ownership ${pending.symbol} untuk detail lengkap.`
    );
    return true;
  }

  return false;
}
