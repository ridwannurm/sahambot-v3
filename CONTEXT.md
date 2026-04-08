# CONTEXT.md — SahamBot v3 Project Context
# Baca file ini jika membuka project di chat baru

## Identitas Project
- **Nama:** SahamBot v3 (folder: sahambot-v2, nama folder tidak diganti untuk kompatibilitas)
- **Owner:** Ridwan Noor Mulyantono
- **Tujuan:** Bot analisis saham IDX via Telegram + CLI, deployed di Ubuntu VPS via PM2
- **Repo GitHub:** https://github.com/ridwannurm/sahambot-v3.git
- **Version:** 3.2.4
- **Stack:** Node.js (ESM), grammY (Telegram), sql.js (SQLite), Yahoo Finance API

---

## Arsitektur File

```
sahambot-v2/
├── index.js                        # CLI entry (Commander.js)
├── src/
│   ├── agents/
│   │   ├── brain.js                # analyzeStock() — analisis AI + orderbook
│   │   ├── trading.js              # decisionEngine(), classifySetup(), risk mgmt
│   │   ├── konglo.js               # analyzeKonglo(), formatKongloTelegram()
│   │   └── fullscan.js             # runFullScan(), IDX universe
│   ├── db/
│   │   ├── database.js             # SQLite CRUD: trades, ownership, portfolio, dll
│   │   ├── kongloData.js           # getSahamByKonglo(), getReverseIndex()
│   │   └── excelLoader.js          # Auto-sync Excel → JSON
│   ├── indicators/
│   │   ├── market.js               # fetchQuote(), fetchOHLC(), calcAllIndicators()
│   │   ├── araArb.js               # ARA/ARB calculator
│   │   └── orderbookProxy.js       # analyzeOrderbookProxy() — buy/sell pressure
│   ├── llm/
│   │   └── router.js               # callLLM(), classifyIntent(), multi-AI
│   └── telegram/
│       ├── bot.js                  # grammY bot, semua commands
│       ├── tradeFlow.js            # /entry /exit /positions /report /history
│       ├── ownershipFlow.js        # /ownership — kepemilikan saham
│       └── utils.js                # safeSend(), fmt(), handleLLMError(), trunc()
├── data/
│   ├── konglo.xlsx                 # WAJIB ADA — List_Saham_Konglomerat_Indonesia.xlsx
│   ├── konglo_data.json            # Auto-generated dari Excel
│   └── sahambot.db                 # SQLite database
```

---

## Aturan Data (PENTING — jangan ubah)

| Data | Sumber | Catatan |
|------|--------|---------|
| Konglomerat | WAJIB dari `data/konglo.xlsx` | 46 konglo, 172 saham, 21 cross-ownership |
| Harga saham | Yahoo Finance API | Open, High, Low, Close, Volume |
| Orderbook | Proxy dari OHLCV | Tidak ada L2 data IDX gratis |
| ARA | Close + 15% | Fix BEI per 8 April 2025 |
| ARB | Close - 15% | Fix BEI per 8 April 2025 |

---

## Multi-AI Providers

```
claude  → ANTHROPIC_API_KEY   (claude-sonnet-4-20250514)
openai  → OPENAI_API_KEY      (gpt-4o-mini)
groq    → GROQ_API_KEY        (llama-3.3-70b) ← GRATIS, recommended
gemini  → GEMINI_API_KEY      (gemini-2.0-flash)
```

Ganti provider di Telegram: `/setai groq`

---

## Setup Standardization (jangan ubah nama)

**Setup (entry):**
- `KONGLO_MOMENTUM` — saham konglomerat bergerak
- `BREAKOUT_VALID` — breakout dari resistance
- `REVERSAL_AKUMULASI` — reversal dari support/oversold

**Exit type:**
- `TAKE_PROFIT` — TP tercapai
- `STOP_LOSS` — SL kena
- `EARLY_EXIT` — momentum hilang
- `RE_ENTRY_EXIT` — ambil profit, siap masuk lagi

**Confidence:** `High` / `Medium` / `Low`

---

## Database Tables (sqlite)

```
trades          — posisi trading (OPEN/RUNNING/CLOSED, WIN/LOSS)
trade_exits     — riwayat exit per trade
portfolio       — modal, risk setting per user
daily_trades    — counter trade harian
pending_entries — state multi-step Telegram flow
ownership       — kepemilikan saham aktual
ownership_history — riwayat beli/jual saham
analysis_history — riwayat analisis per saham
scan_results    — riwayat hasil scan
multiday_context — konteks multi-hari per saham
```

---

## Telegram Commands Lengkap

### Trading
| Command | Fungsi |
|---------|--------|
| `/entry BBCA` | Buka posisi (flow interaktif: harga → lot → setup → confidence → confirm) |
| `/exit BBCA` | Tutup posisi (harga → alasan → confirm) |
| `/partialexit BBCA 3 9500` | Exit sebagian lot |
| `/positions` | Lihat posisi terbuka + unrealized PnL |
| `/report` | Winrate, EV, PnL per setup |
| `/history` | Riwayat trade |
| `/stats BBCA` | Statistik per saham |
| `/setcapital 50000000` | Set modal portfolio |
| `/compound` | Compounding strategy + proyeksi |
| `/rebalance` | Cek & saran rebalancing |

### Analisis
| Command | Fungsi |
|---------|--------|
| `/analyze BBCA` | Analisis teknikal + AI + orderbook proxy |
| `/scalp BBCA` | Scalping T+2 analyzer |
| `/konglo` | Daftar 46 konglomerat |
| `/konglo SALIM` | Analisis semua saham konglo (split per pesan jika panjang) |
| `/topgainers` | Top saham naik + tandai 🏦 konglo |
| `/toplosers` | Top saham turun + tandai 🏦 konglo |
| `/topvolume` | Top volume IDX + volSignal |
| `/volumespike 2.0` | Saham dengan volume spike ≥ Nx |
| `/ara BBCA,BBRI` | ARA/ARB per saham |
| `/multiday BBCA` | Konteks trend 5D & 10D |
| `/fullscan` | Scan 200+ saham IDX |
| `/scan` | Scan watchlist |

### Ownership
| Command | Fungsi |
|---------|--------|
| `/ownership` | Lihat semua kepemilikan + unrealized PnL |
| `/ownership BBCA` | Detail satu saham |

### AI & Settings
| Command | Fungsi |
|---------|--------|
| `/setai groq` | Ganti AI provider |
| `/models` | Lihat semua provider |
| `/setrisiko moderate` | Risk profile |
| `/sizing 50000000 BBCA` | Position sizing calculator |
| `/update` | Auto-update dari GitHub |
| `/version` | Cek versi |

---

## Orderbook Proxy — Cara Kerja

Karena IDX tidak punya data L2 gratis, bot pakai estimasi dari OHLCV:

| Metode | Field | Keterangan |
|--------|-------|------------|
| Volume Pressure | `vp.buyPct / vp.sellPct` | % beli vs jual dari posisi close dalam candle |
| Price Flow (OBV+CMF) | `pf.obvTrend / pf.cmf` | Aliran uang masuk/keluar |
| Large Order Detection | `hasLargeOrder / largeOrderDir` | Volume >2.5x rata-rata |
| Candle Pressure | `cp` | Tekanan beli/jual 3 candle terakhir |
| **Verdict** | `verdict / strength` | Hasil akhir: "Banyak DIBELI" / "Banyak DIJUAL" / "Netral" |

**PENTING:** Nama field yang benar di return object `analyzeOrderbookProxy()`:
- `verdict` (bukan `overallBias`)
- `strength` (bukan `biasStrength`)
- `vp.buyPct` / `vp.sellPct` (bukan `volumeDelta`)
- `pf.obvTrend` / `pf.cmf` (bukan `cvd`)
- `hasLargeOrder` / `largeOrderDir` (bukan `largeTrades.count`)

---

## Bug History (sudah diperbaiki)

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| `/entry` Bad Request parse entities | Markdown special chars di pesan Telegram | Ganti semua output ke plain text, gunakan `safeSend()` |
| `/konglo` output "0" | `trunc(4000)` memotong output, sisa dikirim sebagai "..." | Split per saham via separator `---`, tanpa trunc di formatter |
| `/scalp` error 401 | API key tidak ada di .env | `handleLLMError()` di `utils.js` dengan fallback message |
| `/fullscan` parse error | Markdown di output panjang | Strip semua Markdown, kirim plain text |
| `buildOrderbookInsight is not defined` | Import tidak ada di `brain.js`, nama fungsi beda | Tambah import, gunakan alias `buildOrderbookInsight = analyzeOrderbookProxy` |
| `result.(orderbookInsight...)` syntax error | Auto-replace yang salah di `tradeFlow.js` baris 52 | Fix manual ke `result.orderbookInsight.hasLargeOrder` |

---

## Deployment VPS

```bash
# Start
pm2 start index.js --name sahambot -- telegram

# Restart setelah update
pm2 restart sahambot

# Log
pm2 logs sahambot

# Auto-start setelah reboot
pm2 startup && pm2 save
```

### .env yang dibutuhkan
```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
ANTHROPIC_API_KEY=...   # optional, bisa pakai groq
GROQ_API_KEY=...        # gratis, recommended
OPENAI_API_KEY=...      # optional
GEMINI_API_KEY=...      # optional
```

---

## Cara Baca Project di Chat Baru

Jika membuka chat baru dengan file zip ini:

1. Lampirkan `sahambot-v3.zip`
2. Katakan: *"Ini adalah SahamBot v3.2.4 milik Ridwan. Baca CONTEXT.md untuk konteks lengkap, lalu bantu saya dengan [masalah/fitur]"*
3. Claude akan membaca semua file dan langsung paham konteksnya

---

## Kontak & Repository

- **GitHub:** https://github.com/ridwannurm/sahambot-v3
- **VPS:** Ubuntu, PM2, Node.js ESM
- **Bahasa output bot:** Bahasa Indonesia
- **Timezone:** WIB (Asia/Jakarta)
