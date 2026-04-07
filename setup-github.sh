#!/bin/bash
# ─────────────────────────────────────────────────────────────
#  SahamBot v2 — Setup GitHub Auto-Update
#  Jalankan sekali setelah install: ./setup-github.sh
# ─────────────────────────────────────────────────────────────
set -e

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'
RED='\033[0;31m'; GRAY='\033[0;37m'; NC='\033[0m'

echo ""
echo -e "${CYAN}  ╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}  ║   SahamBot v2 — GitHub Auto-Update Setup ║${NC}"
echo -e "${CYAN}  ╚══════════════════════════════════════════╝${NC}"
echo ""

# Cek git
if ! command -v git &>/dev/null; then
  echo -e "${YELLOW}  → Menginstall git...${NC}"
  apt-get install -y git -q
fi

# Cek apakah sudah git repo
if [ -d ".git" ]; then
  echo -e "${GREEN}  ✔ Sudah git repo${NC}"
  REMOTE=$(git remote get-url origin 2>/dev/null || echo "")
  if [ -n "$REMOTE" ]; then
    echo -e "${GREEN}  ✔ Remote: ${REMOTE}${NC}"
    echo ""
    echo -e "${CYAN}  Apakah ingin ganti remote URL? (y/n)${NC}"
    read -p "  " -n 1 -r; echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      echo -e "${GREEN}  Setup selesai! Remote tetap: ${REMOTE}${NC}"
      exit 0
    fi
  fi
fi

# Input GitHub repo URL
echo ""
echo -e "${CYAN}  Masukkan URL GitHub repo kamu:${NC}"
echo -e "${GRAY}  Format: https://github.com/USERNAME/sahambot.git${NC}"
read -p "  URL: " REPO_URL

if [ -z "$REPO_URL" ]; then
  echo -e "${RED}  ✖ URL tidak boleh kosong${NC}"
  exit 1
fi

# Setup git config
echo ""
read -p "  Nama kamu (untuk git commit): " GIT_NAME
read -p "  Email kamu: " GIT_EMAIL

git config --global user.name "$GIT_NAME"
git config --global user.email "$GIT_EMAIL"

# Init atau update remote
if [ ! -d ".git" ]; then
  git init
  git add .
  git commit -m "initial commit: sahambot v2"
fi

# Set remote
if git remote get-url origin &>/dev/null; then
  git remote set-url origin "$REPO_URL"
else
  git remote add origin "$REPO_URL"
fi

echo ""
echo -e "${GRAY}  Menggunakan Personal Access Token (PAT) untuk private repo${NC}"
echo -e "${GRAY}  Buat PAT di: https://github.com/settings/tokens${NC}"
echo -e "${GRAY}  Centang: repo (full control)${NC}"
echo ""
read -p "  GitHub Personal Access Token: " -s PAT
echo ""

# Simpan credentials
git config --global credential.helper store
CRED_URL=$(echo "$REPO_URL" | sed "s|https://|https://${PAT}@|")

# Test push
echo ""
echo -e "${GRAY}  → Testing koneksi ke GitHub...${NC}"
git push -u origin main 2>/dev/null || git push -u origin master 2>/dev/null || {
  # Jika repo kosong / baru
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  git push -u origin "$BRANCH" && echo -e "${GREEN}  ✔ Push berhasil${NC}"
} || {
  echo -e "${YELLOW}  ⚠ Push gagal — cek URL dan token kamu${NC}"
}

echo ""
echo -e "${GREEN}  ✔ GitHub setup selesai!${NC}"
echo ""
echo -e "${CYAN}  Cara kerja auto-update:${NC}"
echo -e "  ${GRAY}1.${NC} Bot cek GitHub setiap 60 menit"
echo -e "  ${GRAY}2.${NC} Kalau ada commit baru → pull otomatis"
echo -e "  ${GRAY}3.${NC} Bot restart sendiri via PM2"
echo -e "  ${GRAY}4.${NC} Notifikasi masuk ke Telegram"
echo ""
echo -e "${CYAN}  Command manual:${NC}"
echo -e "  ${GRAY}Cek update :${NC} node index.js update --check"
echo -e "  ${GRAY}Update     :${NC} node index.js update"
echo -e "  ${GRAY}Info versi :${NC} node index.js version"
echo -e "  ${GRAY}Telegram   :${NC} /update | /version"
echo ""
echo -e "${CYAN}  Cara push update dari PC kamu:${NC}"
echo -e "  ${GRAY}1.${NC} Edit file di PC"
echo -e "  ${GRAY}2.${NC} git add . && git commit -m 'update'"
echo -e "  ${GRAY}3.${NC} git push"
echo -e "  ${GRAY}4.${NC} Bot VPS update otomatis dalam max 60 menit"
echo -e "  ${GRAY}   atau ketik /update di Telegram untuk langsung update${NC}"
echo ""
