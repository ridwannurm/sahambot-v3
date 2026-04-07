// src/updater.js — Auto Update via GitHub
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { loadEnv } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── Cek versi Git ────────────────────────────────────────────
function runGit(cmd) {
  try {
    return execSync(`git -C "${ROOT}" ${cmd}`, { encoding: 'utf-8', stdio: ['pipe','pipe','pipe'] }).trim();
  } catch (e) {
    return null;
  }
}

function isGitRepo() {
  return fs.existsSync(path.join(ROOT, '.git'));
}

export function getCurrentCommit() {
  return runGit('rev-parse --short HEAD') || 'unknown';
}

export function getCurrentBranch() {
  return runGit('rev-parse --abbrev-ref HEAD') || 'main';
}

export function getRemoteCommit() {
  runGit('fetch origin --quiet');
  const branch = getCurrentBranch();
  return runGit(`rev-parse --short origin/${branch}`) || null;
}

export function hasUpdate() {
  if (!isGitRepo()) return false;
  const local  = getCurrentCommit();
  const remote = getRemoteCommit();
  if (!remote) return false;
  return local !== remote;
}

export function getChangelog() {
  try {
    runGit('fetch origin --quiet');
    const branch = getCurrentBranch();
    const log = runGit(`log HEAD..origin/${branch} --oneline --no-merges`);
    return log || 'Tidak ada info perubahan';
  } catch { return ''; }
}

// ── Jalankan Update ──────────────────────────────────────────
export async function doUpdate(options = { restart: true }) {
  if (!isGitRepo()) {
    return { success: false, message: 'Folder bukan git repo. Jalankan: git init && git remote add origin <url>' };
  }

  try {
    // Simpan status saat ini
    const beforeCommit = getCurrentCommit();
    const changelog    = getChangelog();

    // Stash perubahan lokal jika ada
    runGit('stash');

    // Pull latest
    const pullResult = runGit('pull origin ' + getCurrentBranch());
    if (!pullResult) throw new Error('git pull gagal');

    // Install/update dependencies jika package.json berubah
    const pkgChanged = runGit(`diff ${beforeCommit} HEAD -- package.json`);
    if (pkgChanged) {
      console.log(chalk.gray('  📦 package.json berubah, menjalankan npm install...'));
      execSync('npm install --silent', { cwd: ROOT, stdio: 'pipe' });
    }

    const afterCommit = getCurrentCommit();

    // Restart proses jika diminta (via PM2 atau spawn)
    if (options.restart) {
      scheduleRestart();
    }

    return {
      success: true,
      beforeCommit,
      afterCommit,
      changelog,
      depsUpdated: !!pkgChanged,
      message: `Update berhasil: ${beforeCommit} → ${afterCommit}`
    };
  } catch (e) {
    return { success: false, message: `Update gagal: ${e.message}` };
  }
}

function scheduleRestart() {
  console.log(chalk.yellow('\n  🔄 Bot akan restart dalam 3 detik...'));
  setTimeout(() => {
    // Coba restart via PM2 dulu
    try {
      execSync('pm2 restart sahambot --silent', { stdio: 'pipe' });
      console.log(chalk.green('  ✔ Restart via PM2 berhasil'));
    } catch {
      // Fallback: spawn proses baru dan exit
      const args = process.argv.slice(1);
      spawn(process.execPath, args, {
        detached: true, stdio: 'inherit', cwd: ROOT
      }).unref();
      process.exit(0);
    }
  }, 3000);
}

// ── Auto Update Checker (cron) ───────────────────────────────
export function startAutoUpdateChecker(intervalMinutes = 60, onUpdate = null) {
  if (!isGitRepo()) {
    console.log(chalk.yellow('  ⚠ Auto-update tidak aktif: bukan git repo'));
    return;
  }

  console.log(chalk.cyan(`  🔄 Auto-update checker aktif (cek setiap ${intervalMinutes} menit)`));

  const check = async () => {
    try {
      if (hasUpdate()) {
        console.log(chalk.green('\n  🆕 Update tersedia! Mengupdate...'));
        const result = await doUpdate({ restart: true });
        if (onUpdate) onUpdate(result);
      }
    } catch (e) { /* silent */ }
  };

  // Cek pertama setelah 1 menit, lalu sesuai interval
  setTimeout(check, 60 * 1000);
  setInterval(check, intervalMinutes * 60 * 1000);
}

// ── Info versi ───────────────────────────────────────────────
export function getVersionInfo() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  return {
    version: pkg.version,
    commit: getCurrentCommit(),
    branch: getCurrentBranch(),
    isGitRepo: isGitRepo(),
    nodeVersion: process.version,
  };
}
