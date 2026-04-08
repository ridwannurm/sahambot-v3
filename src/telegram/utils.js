// src/telegram/utils.js — Safe message sender & helpers

// Escape karakter special Markdown v1 yang sering bikin error
export function escapeMd(text) {
  if (!text) return '';
  // Escape: _ * ` [ ]
  return String(text).replace(/[_*`\[\]]/g, c => '\\' + c);
}

// Kirim pesan dengan fallback plain text jika Markdown gagal
export async function safeSend(ctx, text, opts = {}) {
  const maxLen = 4000;
  const truncated = text.length > maxLen ? text.slice(0, maxLen) + '\n...' : text;

  // Coba kirim dengan Markdown
  if (opts.parse_mode === 'Markdown') {
    try {
      return await ctx.reply(truncated, opts);
    } catch (e) {
      // Fallback: kirim plain text
      const plain = truncated
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/_([^_]+)_/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');
      return await ctx.reply(plain);
    }
  }

  return ctx.reply(truncated, opts);
}

// Format angka Rupiah
export const fmt = n => (n != null && !isNaN(n) && n !== '')
  ? Math.round(Number(n)).toLocaleString('id-ID')
  : 'N/A';

export const fmtPct = n => n != null
  ? (Number(n) >= 0 ? '+' : '') + parseFloat(n).toFixed(2) + '%'
  : 'N/A';

export const fmtVol = v => {
  if (!v || v <= 0) return 'N/A';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(v);
};

// Safe toFixed — tidak crash jika n bukan number/null/undefined
export const safeFixed = (n, d = 2) => {
  const num = parseFloat(n);
  return isNaN(num) ? 'N/A' : num.toFixed(d);
};

// LLM error handler — fallback pesan friendly
export function handleLLMError(e, fallback = '') {
  const msg = e.message || '';

  if (msg.includes('401') || msg.includes('authentication') || msg.includes('invalid x-api-key')) {
    return '⚠️ API key AI tidak valid atau belum diisi.\nGunakan /setai groq (gratis) atau cek .env kamu.';
  }
  if (msg.includes('tidak ditemukan di .env') || msg.includes('API key')) {
    return '⚠️ API key belum dikonfigurasi.\nJalankan /models untuk cek provider, atau /setai groq untuk beralih ke Groq (gratis).';
  }
  if (msg.includes('429') || msg.includes('rate limit')) {
    return '⚠️ Rate limit tercapai. Coba lagi dalam beberapa detik.';
  }
  if (msg.includes('timeout') || msg.includes('ECONNREFUSED')) {
    return '⚠️ Koneksi timeout. Cek koneksi internet VPS.';
  }

  return fallback || `⚠️ AI error: ${msg.slice(0, 100)}`;
}

// Truncate safe
export const trunc = (t, max = 4000) =>
  t && t.length > max ? t.slice(0, max) + '\n_(pesan dipotong)_' : (t || '');
