#!/bin/bash
# ─────────────────────────────────────────────────────────────
#  SahamBot v2 — Security Check
#  Jalankan sebelum git push: ./security-check.sh
# ─────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; GRAY='\033[0;37m'; NC='\033[0m'
ISSUES=0

echo ""
echo -e "${CYAN}  🔒 SahamBot Security Check${NC}"
echo -e "${GRAY}  ─────────────────────────────────────────${NC}"
echo ""

# ── 1. Cek .env tidak masuk git ──────────────────
echo -e "  Cek 1: File .env di gitignore..."
if grep -q "^\.env$\|^\.env\b" .gitignore 2>/dev/null; then
  echo -e "  ${GREEN}✔ .env ada di .gitignore${NC}"
else
  echo -e "  ${RED}✖ .env TIDAK ada di .gitignore! Tambahkan sekarang!${NC}"
  ISSUES=$((ISSUES+1))
fi

# ── 2. Cek .env tidak ter-track git ──────────────
echo -e "  Cek 2: .env tidak ter-track git..."
if git ls-files --error-unmatch .env &>/dev/null 2>&1; then
  echo -e "  ${RED}✖ .env sudah ter-track git! Jalankan: git rm --cached .env${NC}"
  ISSUES=$((ISSUES+1))
else
  echo -e "  ${GREEN}✔ .env tidak ter-track git${NC}"
fi

# ── 3. Cek tidak ada API key asli di source code ─
echo -e "  Cek 3: API key hardcoded di source code..."
FOUND=$(grep -rn \
  --include="*.js" \
  --include="*.ts" \
  --include="*.json" \
  --exclude-dir=node_modules \
  -E "sk-ant-api[0-9]{2}-[a-zA-Z0-9_-]{90,}|sk-[a-zA-Z0-9]{48,}|gsk_[a-zA-Z0-9]{50,}|AIzaSy[a-zA-Z0-9]{33}|[0-9]{8,10}:[A-Za-z0-9_-]{35,}" \
  . 2>/dev/null)

if [ -n "$FOUND" ]; then
  echo -e "  ${RED}✖ DITEMUKAN API KEY di source code:${NC}"
  echo "$FOUND" | while read line; do echo -e "    ${RED}$line${NC}"; done
  ISSUES=$((ISSUES+1))
else
  echo -e "  ${GREEN}✔ Tidak ada API key hardcoded${NC}"
fi

# ── 4. Cek .env.example hanya placeholder ────────
echo -e "  Cek 4: .env.example hanya berisi placeholder..."
REAL_KEY=$(grep -E \
  "sk-ant-api[0-9]{2}-[a-zA-Z0-9_-]{20,}|sk-[a-zA-Z0-9]{40,}|gsk_[a-zA-Z0-9]{40,}|AIzaSy[a-zA-Z0-9]{33}" \
  .env.example 2>/dev/null)

if [ -n "$REAL_KEY" ]; then
  echo -e "  ${RED}✖ .env.example mengandung API key asli!${NC}"
  ISSUES=$((ISSUES+1))
else
  echo -e "  ${GREEN}✔ .env.example aman (hanya placeholder)${NC}"
fi

# ── 5. Cek database tidak ter-track ──────────────
echo -e "  Cek 5: File database tidak ter-track git..."
DB_TRACKED=$(git ls-files "*.db" "*.sqlite" "*.sqlite3" data/ 2>/dev/null)
if [ -n "$DB_TRACKED" ]; then
  echo -e "  ${RED}✖ File database ter-track: $DB_TRACKED${NC}"
  echo -e "  ${YELLOW}  Jalankan: git rm --cached $DB_TRACKED${NC}"
  ISSUES=$((ISSUES+1))
else
  echo -e "  ${GREEN}✔ Database tidak ter-track git${NC}"
fi

# ── 6. Cek file sensitif lain ────────────────────
echo -e "  Cek 6: File sensitif lain..."
SENSITIVE=$(git ls-files 2>/dev/null | grep -E \
  "\.pem$|\.key$|\.cert$|\.p12$|id_rsa|id_ed25519|credentials\.json|service.account" \
  2>/dev/null)
if [ -n "$SENSITIVE" ]; then
  echo -e "  ${RED}✖ File sensitif ditemukan: $SENSITIVE${NC}"
  ISSUES=$((ISSUES+1))
else
  echo -e "  ${GREEN}✔ Tidak ada file sensitif lain${NC}"
fi

# ── 7. Tampilkan daftar file yang akan di-push ───
echo ""
echo -e "  ${CYAN}📋 File yang akan masuk ke GitHub:${NC}"
git ls-files --others --exclude-standard 2>/dev/null | grep -v node_modules | while read f; do
  echo -e "  ${GRAY}  + $f (baru)${NC}"
done
git diff --cached --name-only 2>/dev/null | while read f; do
  echo -e "  ${GRAY}  ~ $f (modified)${NC}"
done
git ls-files 2>/dev/null | grep -v node_modules | while read f; do
  echo -e "  ${GRAY}  ✓ $f${NC}"
done

# ── Hasil akhir ───────────────────────────────────
echo ""
echo -e "  ${GRAY}─────────────────────────────────────────${NC}"
if [ $ISSUES -eq 0 ]; then
  echo -e "  ${GREEN}✔ AMAN! Tidak ada masalah keamanan.${NC}"
  echo -e "  ${GREEN}  Silakan git push dengan aman.${NC}"
else
  echo -e "  ${RED}✖ DITEMUKAN $ISSUES MASALAH KEAMANAN!${NC}"
  echo -e "  ${RED}  JANGAN git push sebelum masalah diperbaiki!${NC}"
fi
echo ""
exit $ISSUES
