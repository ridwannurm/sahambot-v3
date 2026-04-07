import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

export function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const lines = fs.readFileSync(ENV_PATH, 'utf-8').split('\n');
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return env;
}

export function saveEnv(vars) {
  const existing = loadEnv();
  const merged = { ...existing, ...vars };
  const content = Object.entries(merged)
    .filter(([k]) => !k.startsWith('#'))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  fs.writeFileSync(ENV_PATH, content + '\n');
}
