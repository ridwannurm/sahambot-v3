// src/db/excelLoader.js — Excel + JSON loader untuk data konglomerat
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAllKonglos, getReverseIndex, getStats } from './kongloData.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.join(__dirname, '../..');
const EXCEL_PATH = path.join(ROOT, 'data', 'konglo.xlsx');
const JSON_PATH  = path.join(ROOT, 'data', 'konglo_data.json');

// ── Re-parse Excel ke JSON jika Excel lebih baru ─────────────
export async function syncExcelToJSON() {
  if (!fs.existsSync(EXCEL_PATH)) return false;

  const excelMtime = fs.statSync(EXCEL_PATH).mtime;
  const jsonMtime  = fs.existsSync(JSON_PATH) ? fs.statSync(JSON_PATH).mtime : new Date(0);

  if (excelMtime <= jsonMtime) return false; // JSON sudah up-to-date

  try {
    const XLSXmod = await import('xlsx');
    const XLSX = XLSXmod.default || XLSXmod;
    const wb   = XLSX.readFile(EXCEL_PATH);
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    const konglos = {}, reverse = {};

    for (const row of rows) {
      const kode_saham  = (row['KODE SAHAM'] || row['kode saham'] || row['KODE'] || '').toString().trim().toUpperCase();
      const kode_konglo = (row['KODE KONGLOMERAT'] || row['kode konglomerat'] || row['KONGLO'] || '').toString().trim().toUpperCase();
      const nama_konglo = (row['KONGLOMERAT'] || row['konglomerat'] || row['NAMA KONGLO'] || '').toString().trim();
      const nama_emiten = (row['NAMA PERUSAHAAN'] || row['nama perusahaan'] || row['NAMA'] || '').toString().trim();
      const sektor      = (row['SEKTOR'] || row['sektor'] || '').toString().trim();

      if (!kode_saham || !kode_konglo) continue;

      if (!konglos[kode_konglo]) {
        konglos[kode_konglo] = { nama: nama_konglo, pemilik: nama_konglo, saham: [] };
      }
      if (!konglos[kode_konglo].saham.find(s => s.kode === kode_saham)) {
        konglos[kode_konglo].saham.push({ kode: kode_saham, nama: nama_emiten, sektor, pct: 0 });
      }

      if (!reverse[kode_saham]) reverse[kode_saham] = [];
      if (!reverse[kode_saham].find(r => r.kongloKey === kode_konglo)) {
        reverse[kode_saham].push({ kongloKey: kode_konglo, kongloNama: nama_konglo, pemilik: nama_konglo, namaEmiten: nama_emiten, sektor, pct: 0 });
      }
    }

    fs.mkdirSync(path.dirname(JSON_PATH), { recursive: true });
    fs.writeFileSync(JSON_PATH, JSON.stringify({ konglos, reverseIndex: reverse }, null, 2));
    console.log(`  ✅ Excel → JSON sync: ${Object.keys(konglos).length} konglo, ${Object.keys(reverse).length} saham`);
    return true;
  } catch (e) {
    console.log(`  ⚠️ Sync Excel gagal: ${e.message}`);
    return false;
  }
}

// ── Get data (auto-sync jika perlu) ─────────────────────────
let _cache = null, _cacheTime = 0;
const TTL = 5 * 60 * 1000;

export async function getKongloData() {
  const now = Date.now();
  if (_cache && (now - _cacheTime) < TTL) return _cache;

  await syncExcelToJSON();

  const data    = getAllKonglos();
  const reverse = getReverseIndex();
  const stats   = getStats();

  const excelExists = fs.existsSync(EXCEL_PATH);
  const source = excelExists ? 'excel' : (fs.existsSync(JSON_PATH) ? 'json' : 'default');

  _cache = { data, reverseIndex: reverse, source, stats };
  _cacheTime = now;
  return _cache;
}

export function clearKongloCache() {
  _cache = null; _cacheTime = 0;
}
