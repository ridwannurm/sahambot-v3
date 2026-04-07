# 🤖 SahamBot v2 — Multi-AI IDX Stock Analyzer

Bot terminal + Telegram untuk memantau dan menganalisis saham IDX Indonesia menggunakan **Yahoo Finance** sebagai sumber data dan berbagai **AI** (Claude, ChatGPT, Groq, Gemini, Ollama) sebagai otak analisis.

```
  ___       _               ___      _         ___ 
 / __| __ _| |_  __ _ _ __ | _ ) ___| |_  __ _|_  )
 \__ \/ _` | ' \/ _` | '  \| _ \/ _ \  _| \ V // / 
 |___/\__,_|_||_\__,_|_|_|_|___/\___/\__|  \_//___|
```

---

## ✨ Fitur Lengkap

| Fitur | Deskripsi |
|-------|-----------|
| 📊 **Yahoo Finance** | Data saham real-time dari IDX |
| 🤖 **Multi-AI** | Claude, ChatGPT, Groq, Gemini, Ollama |
| 🧠 **AI Intent Classifier** | Mengerti perintah bebas Bahasa Indonesia |
| 💾 **Persistent Memory** | SQLite — ingat preferensi & riwayat user |
| 📈 **Indikator Lengkap** | RSI, MACD, EMA 9/20/50, Bollinger, ATR, VWAP |
| 🎯 **Entry/SL/TP Otomatis** | Berdasarkan ATR & risk profile |
| 📐 **Support & Resistance** | Deteksi otomatis dari data historis |
| ⚡ **Scalping T+2** | Analisis khusus scalping intraday |
| 🔄 **Compare AI Paralel** | Bandingkan Claude vs GPT vs Groq sekaligus |
| 🔔 **Auto Scan 5 Menit** | Alert otomatis saat pasar buka (09:00–16:00) |
| 💰 **Position Sizing** | Kalkulasi lot berdasarkan modal & risk |
| 📱 **Telegram Bot** | Full-featured dengan NLP command bebas |
| 🏆 **Self-Learning** | Catat riwayat sinyal & hitung win rate |

---

## 🚀 Instalasi di VPS Ubuntu

```bash
# 1. Extract & masuk folder
unzip sahambot-v2.zip && cd sahambot-v2

# 2. Jalankan installer
chmod +x install.sh && ./install.sh

# 3. Isi API keys
nano .env
# atau gunakan wizard:
node index.js setup

# 4. Jalankan
node index.js telegram        # Start Telegram bot
node index.js scan            # Scan saham sekali
node index.js analyze BBCA    # Analisis saham
```

### Jalankan di Background (PM2)
```bash
npm install -g pm2

# Start bot
pm2 start index.js --name sahambot -- telegram

# Auto-start saat VPS reboot
pm2 startup && pm2 save

# Monitor
pm2 logs sahambot
pm2 status
```

---

## ⚙️ Konfigurasi .env

```env
# AI — isi minimal SATU
ANTHROPIC_API_KEY=sk-ant-xxxxx      # Claude (console.anthropic.com)
OPENAI_API_KEY=sk-xxxxx             # ChatGPT (platform.openai.com)
GROQ_API_KEY=gsk_xxxxx              # Groq GRATIS (console.groq.com)
GEMINI_API_KEY=AIzaSyxxxxx          # Gemini (aistudio.google.com)

# Telegram
TELEGRAM_BOT_TOKEN=123456:ABCxxxxx  # Dari @BotFather
TELEGRAM_CHAT_ID=123456789          # Dari @userinfobot
```

### Cara Buat Telegram Bot
1. Buka [@BotFather](https://t.me/BotFather) di Telegram
2. Ketik `/newbot` → ikuti instruksi
3. Copy token ke `TELEGRAM_BOT_TOKEN`
4. Buka [@userinfobot](https://t.me/userinfobot) → copy ID ke `TELEGRAM_CHAT_ID`

---

## 📖 Perintah CLI Terminal

```bash
node index.js setup                        # Wizard konfigurasi
node index.js telegram                     # Start Telegram bot

node index.js analyze BBCA                 # Analisis (AI default)
node index.js analyze BBCA --ai groq       # Pakai Groq
node index.js analyze BBCA --ai openai --model gpt-4o
node index.js analyze BBCA --mode swing    # Mode swing trading

node index.js scan                         # Scan semua watchlist
node index.js scan --ai groq               # Scan pakai Groq

node index.js watchlist                    # Lihat watchlist
node index.js watchlist --add GOTO         # Tambah saham
node index.js watchlist --remove GOTO      # Hapus saham

node index.js models                       # Lihat semua AI provider
```

---

## 📱 Perintah Telegram

### Command Eksplisit
```
/start              — Mulai & lihat panduan
/analyze BBCA       — Analisis teknikal + AI
/scalp TLKM         — Analisis scalping T+2
/scan               — Scan seluruh watchlist
/watchlist          — Lihat daftar pantauan
/add GOTO           — Tambah ke watchlist
/remove GOTO        — Hapus dari watchlist
/setai claude       — Ganti ke Claude
/setai openai gpt-4o — Ganti ke ChatGPT gpt-4o
/setai groq         — Ganti ke Groq (gratis)
/setai gemini       — Ganti ke Gemini
/models             — Lihat semua AI & model
/compare BBCA       — Bandingkan semua AI paralel
/sizing 10000000 BBCA — Hitung position size
/setrisiko moderate — Set risk profile
/performance        — Lihat statistik win rate
/help               — Bantuan lengkap
```

### Perintah Natural (NLP) — Ketik Bebas!
```
"analisis BBCA untuk scalping"
"gimana TLKM hari ini?"
"cari peluang scalping sekarang"
"tambah ANTM ke watchlist"
"ganti AI ke GPT"
"bandingkan Claude vs Groq untuk BMRI"
"berapa lot kalau modal 5 juta beli BBRI?"
"performa bot gimana?"
"RSI BBCA berapa?"
```

---

## 📊 Indikator Teknikal

| Indikator | Parameter | Kegunaan |
|-----------|-----------|----------|
| RSI | 14 hari | Oversold (<30) / Overbought (>70) |
| MACD | 12,26,9 | Momentum & crossover |
| EMA | 9, 20, 50 | Trend jangka pendek/menengah |
| Bollinger Band | 20, 2σ | Volatilitas & breakout |
| ATR | 14 | Ukur volatilitas untuk SL/TP |
| Stochastic | 14,3 | Konfirmasi overbought/oversold |
| VWAP | Harian | Benchmark harga wajar intraday |
| Support/Resistance | 30 hari | Level kunci otomatis |

---

## 🏗️ Arsitektur

```
sahambot-v2/
├── index.js                    # CLI entry point
├── src/
│   ├── config.js               # .env loader
│   ├── agents/
│   │   └── brain.js            # AI Trading Brain (ReAct agent)
│   ├── db/
│   │   └── database.js         # SQLite persistent memory
│   ├── indicators/
│   │   └── market.js           # Yahoo Finance + technicalindicators
│   ├── llm/
│   │   └── router.js           # Multi-LLM router + intent classifier
│   └── telegram/
│       └── bot.js              # Telegram bot (grammY)
├── data/
│   └── sahambot.db             # SQLite database (auto-generated)
├── .env                        # API keys (gitignored)
├── .env.example                # Template
├── install.sh                  # Installer VPS
└── README.md
```

---

## ⚠️ Disclaimer

Tool ini **hanya untuk edukasi dan riset**. Bukan rekomendasi investasi. Selalu lakukan riset mandiri. Performa historis tidak menjamin hasil masa depan.

Data dari Yahoo Finance — bisa ada delay 15 menit untuk IDX.

---

## 📄 Lisensi

MIT License — bebas untuk keperluan personal & edukasi.
