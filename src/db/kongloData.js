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
    } catch (e) { /* fallback */ }
  }
  return null;
}

// Lazy-loaded cache
let _cached = null;

export function getKongloRaw() {
  if (_cached) return _cached;
  const fromJSON = loadFromJSON();
  if (fromJSON) { _cached = fromJSON; return _cached; }
  // Minimal fallback
  _cached = { konglos: {}, reverseIndex: {} };
  return _cached;
}

export function getAllKonglos() {
  return getKongloRaw().konglos || {};
}

export function getReverseIndex() {
  return getKongloRaw().reverseIndex || {};
}

export function buildReverseIndex(data) {
  return getKongloRaw().reverseIndex || {};
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

export const KONGLO_DEFAULT = getAllKonglos();
