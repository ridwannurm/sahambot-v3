// src/indicators/araArb.js — Kalkulasi ARA & ARB IDX (Aturan BEI)
//
// Referensi: Peraturan BEI No. II-A tentang Perdagangan Efek
// Auto Reject berlaku terhadap harga PREVIOUS CLOSE (prev)
// Update terakhir: Aturan BEI 2023

// ── Tabel ARA/ARB BEI ────────────────────────────────────────
// Persentase batas berdasarkan rentang harga saham
function getAraArbPct(prevClose) {
  // Saham IPO / hari pertama listing: ARA 35%, ARB 0% (tidak ada batas bawah)
  // Saham reguler:
  if (prevClose < 200)         return { ara: 0.35, arb: 0.35 }; // fraksi Rp 1
  if (prevClose < 500)         return { ara: 0.35, arb: 0.35 }; // fraksi Rp 1
  if (prevClose < 5000)        return { ara: 0.25, arb: 0.25 }; // fraksi Rp 5 (< 200) atau Rp 5 (200-5000)
  if (prevClose >= 5000)       return { ara: 0.20, arb: 0.20 }; // fraksi Rp 25
}

// Fraksi harga (satuan tick) berdasarkan harga
function getFraksi(price) {
  if (price < 200)   return 1;
  if (price < 500)   return 2;
  if (price < 2000)  return 5;
  if (price < 5000)  return 10;
  return 25;
}

// Bulatkan ke fraksi terdekat (ke bawah)
function roundToFraksi(price, fraksi) {
  return Math.floor(price / fraksi) * fraksi;
}

// ── Main Calculator ──────────────────────────────────────────
export function calcAraArb(prevClose, isIPO = false, isAcceleration = false) {
  if (!prevClose || prevClose <= 0) return null;

  let araPct, arbPct;

  if (isIPO) {
    // Hari pertama listing: ARA 35%, tidak ada ARB
    araPct = 0.35;
    arbPct = null;
  } else if (isAcceleration) {
    // Saham dalam pemantauan khusus / market acceleration
    araPct = 0.10;
    arbPct = 0.10;
  } else {
    // Saham reguler — berdasarkan tabel BEI
    const pct = getAraArbPct(prevClose);
    araPct = pct.ara;
    arbPct = pct.arb;
  }

  const araRaw = prevClose * (1 + araPct);
  const arbRaw = arbPct !== null ? prevClose * (1 - arbPct) : null;

  const fraksi = getFraksi(prevClose);

  const ara = roundToFraksi(araRaw, fraksi);
  const arb = arbRaw !== null ? roundToFraksi(arbRaw, fraksi) : null;

  const araRupiah = ara - prevClose;
  const arbRupiah = arb !== null ? arb - prevClose : null;

  return {
    prevClose,
    ara,
    arb,
    araPct: araPct * 100,
    arbPct: arbPct !== null ? arbPct * 100 : null,
    araRupiah,
    arbRupiah,
    fraksi,
    isIPO,
    isAcceleration,
    // Jarak dari harga sekarang (diisi saat ada quote)
    distToAra: null,
    distToArb: null,
    distToAraPct: null,
    distToArbPct: null,
  };
}

// ── Hitung jarak harga saat ini ke ARA/ARB ───────────────────
export function calcDistanceToLimits(araArb, currentPrice) {
  if (!araArb) return araArb;
  return {
    ...araArb,
    currentPrice,
    distToAra: araArb.ara - currentPrice,
    distToArb: araArb.arb !== null ? currentPrice - araArb.arb : null,
    distToAraPct: ((araArb.ara - currentPrice) / currentPrice * 100).toFixed(2),
    distToArbPct: araArb.arb !== null ? ((currentPrice - araArb.arb) / currentPrice * 100).toFixed(2) : null,
    // Status: apakah sudah mendekati ARA/ARB?
    nearAra: araArb.ara > 0 ? ((araArb.ara - currentPrice) / araArb.ara) < 0.03 : false, // dalam 3%
    nearArb: araArb.arb !== null ? ((currentPrice - araArb.arb) / currentPrice) < 0.03 : false,
    hitAra: currentPrice >= araArb.ara,
    hitArb: araArb.arb !== null ? currentPrice <= araArb.arb : false,
  };
}

// ── Format output ringkas ────────────────────────────────────
export function formatAraArb(result, symbol = '') {
  if (!result) return 'Data tidak tersedia';
  const fmt = n => n !== null ? Math.round(n).toLocaleString('id-ID') : 'N/A';
  const fmtPct = n => n !== null ? n.toFixed(2) + '%' : 'N/A';

  const lines = [];
  lines.push(`📌 ${symbol} — ARA & ARB (Prev Close: Rp ${fmt(result.prevClose)})`);
  lines.push(`Fraksi harga: Rp ${result.fraksi}`);
  lines.push('');
  lines.push(`🟢 ARA (Auto Reject Atas)`);
  lines.push(`   Batas  : Rp ${fmt(result.ara)} (+${fmtPct(result.araPct)})`);
  lines.push(`   Naik   : +Rp ${fmt(result.araRupiah)}`);
  if (result.distToAra !== null) {
    lines.push(`   Jarak  : +Rp ${fmt(result.distToAra)} lagi (+${result.distToAraPct}%) dari harga saat ini`);
    if (result.hitAra) lines.push(`   ⚠️ SUDAH KENA ARA!`);
    else if (result.nearAra) lines.push(`   ⚠️ Mendekati ARA (dalam 3%)`);
  }
  lines.push('');
  lines.push(`🔴 ARB (Auto Reject Bawah)`);
  if (result.arb !== null) {
    lines.push(`   Batas  : Rp ${fmt(result.arb)} (-${fmtPct(result.arbPct)})`);
    lines.push(`   Turun  : -Rp ${fmt(Math.abs(result.arbRupiah))}`);
    if (result.distToArb !== null) {
      lines.push(`   Jarak  : -Rp ${fmt(result.distToArb)} lagi (-${result.distToArbPct}%) dari harga saat ini`);
      if (result.hitArb) lines.push(`   ⚠️ SUDAH KENA ARB!`);
      else if (result.nearArb) lines.push(`   ⚠️ Mendekati ARB (dalam 3%)`);
    }
  } else {
    lines.push(`   Tidak ada ARB (saham IPO hari pertama)`);
  }

  if (result.isIPO) lines.push('\n📋 Mode: IPO / Hari Pertama Listing');
  if (result.isAcceleration) lines.push('\n📋 Mode: Saham Pemantauan Khusus (±10%)');

  return lines.join('\n');
}

// ── Tabel ARA/ARB referensi lengkap ─────────────────────────
export const ARA_ARB_TABLE = [
  { range: 'Rp 1 – Rp 199',      araPct: 35, arbPct: 35, fraksi: 1,  contoh: 'Rp 100 → ARA: Rp 135, ARB: Rp 65' },
  { range: 'Rp 200 – Rp 499',    araPct: 35, arbPct: 35, fraksi: 2,  contoh: 'Rp 300 → ARA: Rp 405, ARB: Rp 195' },
  { range: 'Rp 500 – Rp 4.999',  araPct: 25, arbPct: 25, fraksi: 5,  contoh: 'Rp 1.000 → ARA: Rp 1.250, ARB: Rp 750' },
  { range: 'Rp 5.000 ke atas',   araPct: 20, arbPct: 20, fraksi: 25, contoh: 'Rp 10.000 → ARA: Rp 12.000, ARB: Rp 8.000' },
];
