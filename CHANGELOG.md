# CHANGELOG — SahamBot Master Trading System

## v3.1.0 (Latest)

### Trading System Baru
- 🆕 `/entry <kode>` — Buka posisi dengan interactive Telegram buttons
- 🆕 `/exit <kode>` — Tutup posisi dengan pilihan alasan exit
- 🆕 `/positions` — Lihat semua posisi terbuka + unrealized PnL
- 🆕 `/report` — Laporan performa lengkap (winrate, EV, PnL per setup)
- 🆕 `/history` — Riwayat trade dengan detail entry/exit
- 🆕 `/stats <kode>` — Statistik per saham
- 🆕 `/setcapital` — Set modal portfolio

### Interactive Flow
- 🆕 Tombol [🟢 BUY] [🔴 SELL] untuk pilih arah
- 🆕 Input harga & lot via chat
- 🆕 Pilih setup: [🏦 Konglo] [🚀 Breakout] [🔄 Reversal]
- 🆕 Pilih confidence: [🔥 High] [⚡ Medium] [💤 Low]
- 🆕 Exit type: [💰 TP] [🛑 SL] [⚠️ Early] [🔄 Re-entry]
- 🆕 Auto-tagging: WIN/LOSS, timestamp, setup, market condition

### Decision Engine & Scoring
- 🆕 Setup classification: KONGLO_MOMENTUM, BREAKOUT_VALID, REVERSAL_AKUMULASI
- 🆕 Confidence scoring: High/Medium/Low per setup
- 🆕 Failed breakout detection + Trap detection
- 🆕 Score ≥ 70 → BUY / < 70 → WAIT/SKIP
- 🆕 Expected Value (EV) calculation
- 🆕 Asymmetric trade filter
- 🆕 Multi-setup detection (primary + secondary)

### Risk & Portfolio
- 🆕 Risk per trade: 1% modal
- 🆕 Max exposure: 50%, max posisi: 5
- 🆕 Daily trade limit: 3/hari
- 🆕 Auto position sizing berdasarkan risk
- 🆕 Drawdown tracking

### Performance Tracking
- 🆕 Trade lifecycle: OPEN → RUNNING → CLOSED (WIN/LOSS)
- 🆕 Winrate & EV per setup
- 🆕 PnL tracking (Rp & %)
- 🆕 Trade linking: exit terhubung ke entry

### Git Instructions
```bash
git add .
git commit -m "feat: v3.1 master trading system - entry/exit flow, scoring, risk management"
git push
```

---

## v3.0.0

### Fitur Baru
- 🆕 `/konglo <kode>` — Analisis konglomerat dari Excel + Yahoo Finance
- 🆕 `/topgainers` & `/toplosers` dengan penanda 🏦 konglo
- 🆕 Smart money detection (akumulasi, distribusi, pergerakan serentak)
- 🆕 Orderbook proxy (volume spike, momentum, candle strength)
- 🆕 ARB fix −15% untuk semua saham (BEI per 8 April 2025)
- 🆕 Cross ownership detection (21 saham multi-konglo)
- 🆕 46 konglomerat, 172 saham dari Excel
- 🆕 ARA = Close + 15% | ARB = Close − 15%

### Git Instructions
```bash
git add .
git commit -m "upgrade: v3 konglo analysis + yahoo finance integration"
git push
```

---

## v2.0.0

- Multi-AI (Claude, GPT, Groq, Gemini, Ollama)
- Yahoo Finance data fetcher
- RSI, MACD, EMA 9/20/50, Bollinger, ATR, VWAP
- Full Market Scan 200+ saham IDX
- ARA & ARB calculator, Auto-update GitHub
- Telegram bot 23+ commands, SQLite memory
- Position sizing, PM2 integration

### Git Instructions
```bash
git add .
git commit -m "release: v2 multi-ai sahambot"
git push
```
