#!/bin/bash
# Setup Git & Push ke GitHub untuk SahamBot v3
# Jalankan di VPS: bash setup-git.sh

set -e

REPO_URL="https://github.com/ridwannurm/sahambot-v3.git"
USERNAME="ridwannurm"

echo "=== SahamBot v3 — Git Setup ==="
cd /root/sahambot-v2

# Init git jika belum ada
if [ ! -d ".git" ]; then
  echo "Inisialisasi git..."
  git init
  git branch -M main
fi

# Set remote
if git remote | grep -q origin; then
  git remote set-url origin "$REPO_URL"
  echo "Remote updated: $REPO_URL"
else
  git remote add origin "$REPO_URL"
  echo "Remote added: $REPO_URL"
fi

# Set identity
git config user.name "$USERNAME"
git config user.email "$USERNAME@users.noreply.github.com"

# Pastikan .gitignore ada
cat > .gitignore << 'GITIGNORE'
node_modules/
.env
logs/
data/sahambot.db
data/konglo_data.json
*.log
GITIGNORE

# Add & commit
git add -A
git status --short

echo ""
echo "Siap push. Masukkan GitHub Personal Access Token saat diminta password."
echo "(Token dibuat di: GitHub → Settings → Developer settings → Personal access tokens)"
echo ""

git commit -m "feat: v3.2.4 - master trading system, orderbook proxy, konglo analysis, ownership tracking" 2>/dev/null || \
git commit --allow-empty -m "feat: v3.2.4 update" 

git push -u origin main

echo ""
echo "SELESAI! Repo: $REPO_URL"
