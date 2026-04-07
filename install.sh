#!/bin/bash
# ─────────────────────────────────────────────────
#  SahamBot v2 — Install Script (Ubuntu VPS)
# ─────────────────────────────────────────────────
set -e

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; GRAY='\033[0;37m'; NC='\033[0m'

echo ""
echo -e "${CYAN}  ╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}  ║      SahamBot v2 — Installer VPS        ║${NC}"
echo -e "${CYAN}  ║   Multi-AI IDX Analyzer + Telegram Bot  ║${NC}"
echo -e "${CYAN}  ╚══════════════════════════════════════════╝${NC}"
echo ""

# ── Cek Node.js ──────────────────────────────────
if ! command -v node &> /dev/null; then
  echo -e "${YELLOW}  → Node.js tidak ditemukan. Menginstall...${NC}"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo -e "${GREEN}  ✔ Node.js $(node -v) siap${NC}"

# ── Install dependencies ─────────────────────────
echo -e "${GRAY}  → Menginstall dependencies...${NC}"
npm install --silent
echo -e "${GREEN}  ✔ Dependencies terinstall${NC}"

# ── Buat folder data ─────────────────────────────
mkdir -p data logs
echo -e "${GREEN}  ✔ Folder data & logs dibuat${NC}"

# ── Buat .env dari example ────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  echo -e "${YELLOW}  ⚠ File .env dibuat dari template — edit dulu sebelum jalankan!${NC}"
fi

# ── Make executable ──────────────────────────────
chmod +x index.js

# ── Install PM2 (process manager) ────────────────
echo ""
echo -e "${CYAN}  Install PM2 untuk jalan otomatis di background?${NC}"
read -p "  (y/n): " -n 1 -r; echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
  npm install -g pm2 2>/dev/null || true
  echo -e "${GREEN}  ✔ PM2 terinstall${NC}"
  echo -e "${GRAY}  Jalankan bot dengan: pm2 start index.js -- telegram${NC}"
  echo -e "${GRAY}  Auto start saat reboot: pm2 startup && pm2 save${NC}"
fi

echo ""
echo -e "${GREEN}  ✔ Instalasi selesai!${NC}"
echo ""
echo -e "${CYAN}  Langkah selanjutnya:${NC}"
echo -e "  ${GRAY}1.${NC} Edit file .env:          ${CYAN}nano .env${NC}"
echo -e "  ${GRAY}2.${NC} Atau jalankan wizard:    ${CYAN}node index.js setup${NC}"
echo -e "  ${GRAY}3.${NC} Start Telegram bot:      ${CYAN}node index.js telegram${NC}"
echo -e "  ${GRAY}4.${NC} Scan saham:              ${CYAN}node index.js scan${NC}"
echo -e "  ${GRAY}5.${NC} Analisis saham:          ${CYAN}node index.js analyze BBCA --ai claude${NC}"
echo ""
echo -e "${GRAY}  Dokumentasi lengkap: README.md${NC}"
echo ""
