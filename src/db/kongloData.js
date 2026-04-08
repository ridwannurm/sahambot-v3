// src/db/kongloData.js — Data Konglomerat IDX
// Sumber: List_Saham_Konglomerat_Indonesia.xlsx
// 46 konglomerat | 172 saham unik | 21 cross-ownership

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '../..');
const JSON_PATH = path.join(ROOT, 'data', 'konglo_data.json');

// Load dari JSON (hasil parse Excel)
function loadFromJSON() {
  if (fs.existsSync(JSON_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));
      return raw;
    } catch (e) { console.error("Gagal memuat data konglomerat:", e.message); }
  }
  return null;
}

// Lazy-loaded cache
let _cached = null;

export function clearCache() {
  _cached = null;
}

export function getKongloRaw() {
  // 1. Jika sudah ada di cache, langsung kembalikan (Efisiensi memori)
  if (_cached) return _cached;

  const fromJSON = loadFromJSON();

  if (fromJSON) {
    // 2. LOGIKA PERBAIKAN:
    // Pastikan reverseIndex ada. Jika tidak ada di JSON, bangun secara otomatis
    // menggunakan fungsi buildReverseIndex(fromJSON.konglos) yang sudah kamu buat.
    if (!fromJSON.reverseIndex || Object.keys(fromJSON.reverseIndex).length === 0) {
      fromJSON.reverseIndex = buildReverseIndex(fromJSON.konglos || {});
    }

    _cached = fromJSON;
    return _cached;
  }

  // 3. Minimal fallback jika file JSON tidak ditemukan atau error
  _cached = { 
    konglos: {}, 
    reverseIndex: {} 
  };
  
  return _cached;
}

export function getAllKonglos() {
  return getKongloRaw().konglos || {};
}

export function getReverseIndex() {
  return getKongloRaw().reverseIndex || {};
}

export function buildReverseIndex(konglos) {
  const reverse = {};
  for (const [kongloKey, data] of Object.entries(konglos)) {
    if (!data.saham) continue;
    data.saham.forEach(s => {
      if (!reverse[s.kode]) reverse[s.kode] = [];
      reverse[s.kode].push({
        kongloKey: kongloKey,
        kongloNama: data.nama,
        pemilik: data.pemilik,
        namaEmiten: s.nama,
        sektor: s.sektor
      });
    });
  }
  return reverse;
}

export function getSahamByKonglo(query) {
  const konglos = getAllKonglos();
  const q = query.toUpperCase().trim();
  // Exact match by key
  if (konglos[q]) return { key: q, ...konglos[q] };
  // Fuzzy match by nama
  for (const [k, v] of Object.entries(konglos)) {
    if (v.nama.toLowerCase().includes(query.toLowerCase()) ||
        k.toLowerCase().includes(query.toLowerCase())) {
      return { key: k, ...v };
    }
  }
  return null;
}

export function getKongloByKode(kode) {
  return getReverseIndex()[kode.toUpperCase()] || [];
}

export function listAllKonglo() {
  return Object.entries(getAllKonglos()).map(([key, v]) => ({
    key, nama: v.nama, pemilik: v.pemilik,
    jumlahSaham: v.saham?.length || 0
  })).sort((a, b) => b.jumlahSaham - a.jumlahSaham);
}

export function getCrossOwnership() {
  const rev = getReverseIndex();
  return Object.entries(rev)
    .filter(([, owners]) => owners.length > 1)
    .map(([kode, owners]) => ({ kode, owners: owners.map(o => o.kongloKey) }));
}

// Total stats
export function getStats() {
  const konglos = getAllKonglos();
  const rev     = getReverseIndex();
  return {
    totalKonglo: Object.keys(konglos).length,
    totalSaham:  Object.keys(rev).length,
    crossOwnership: Object.values(rev).filter(v => v.length > 1).length
  };
}

