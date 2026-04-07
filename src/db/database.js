// src/db/database.js — Persistent SQLite via sql.js
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../../data/sahambot.db');

let db = null;
let SQL = null;

export async function initDB() {
  SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new SQL.Database();
  }
  createTables();
  saveDB();
  return db;
}

function createTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS watchlist (
      symbol TEXT PRIMARY KEY,
      name TEXT,
      added_at TEXT DEFAULT (datetime('now')),
      active INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS user_context (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS user_memory (
      user_id TEXT PRIMARY KEY,
      preferred_llm TEXT DEFAULT 'claude',
      preferred_model TEXT DEFAULT 'claude-sonnet-4-20250514',
      risk_profile TEXT DEFAULT 'moderate',
      watchlist TEXT DEFAULT '["BBCA","BBRI","TLKM","ASII","BMRI"]',
      strategy TEXT DEFAULT 'scalping',
      last_seen TEXT,
      custom_data TEXT DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS analysis_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      user_id TEXT,
      llm TEXT,
      analysis TEXT,
      signal TEXT,
      entry_price REAL,
      stop_loss REAL,
      take_profit REAL,
      score INTEGER,
      timestamp TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS strategy_performance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT,
      signal TEXT,
      entry_price REAL,
      exit_price REAL,
      pnl_pct REAL,
      strategy TEXT,
      timestamp TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS scan_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT,
      score INTEGER,
      signal TEXT,
      price REAL,
      timestamp TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT,
      user_id TEXT,
      type TEXT,
      value REAL,
      triggered INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

export function saveDB() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// ── Watchlist ────────────────────────────────────────────────
export function getWatchlist() {
  const rows = db.exec("SELECT symbol, name FROM watchlist WHERE active=1");
  if (!rows.length) return ['BBCA','BBRI','TLKM','ASII','BMRI'];
  return rows[0].values.map(r => r[0]);
}

export function addToWatchlist(symbol, name = '') {
  db.run("INSERT OR REPLACE INTO watchlist(symbol,name,active) VALUES(?,?,1)", [symbol, name]);
  saveDB();
}

export function removeFromWatchlist(symbol) {
  db.run("UPDATE watchlist SET active=0 WHERE symbol=?", [symbol]);
  saveDB();
}

// ── User Memory ──────────────────────────────────────────────
export function getUserMemory(userId) {
  const rows = db.exec("SELECT * FROM user_memory WHERE user_id=?", [userId]);
  if (!rows.length || !rows[0].values.length) {
    // Default
    db.run(`INSERT OR IGNORE INTO user_memory(user_id) VALUES(?)`, [userId]);
    saveDB();
    return { user_id: userId, preferred_llm: 'claude', preferred_model: 'claude-sonnet-4-20250514', risk_profile: 'moderate', watchlist: '["BBCA","BBRI","TLKM","ASII","BMRI"]', strategy: 'scalping', custom_data: '{}' };
  }
  const cols = rows[0].columns;
  const vals = rows[0].values[0];
  const obj = {};
  cols.forEach((c, i) => obj[c] = vals[i]);
  return obj;
}

export function updateUserMemory(userId, updates) {
  const fields = Object.keys(updates).map(k => `${k}=?`).join(',');
  const vals = [...Object.values(updates), userId];
  db.run(`UPDATE user_memory SET ${fields}, last_seen=datetime('now') WHERE user_id=?`, vals);
  saveDB();
}

// ── Conversation Context (last N messages) ───────────────────
export function addContext(userId, role, content) {
  db.run("INSERT INTO user_context(user_id,role,content) VALUES(?,?,?)", [userId, role, content]);
  // Keep only last 20 messages per user
  db.run(`DELETE FROM user_context WHERE user_id=? AND id NOT IN (SELECT id FROM user_context WHERE user_id=? ORDER BY id DESC LIMIT 20)`, [userId, userId]);
  saveDB();
}

export function getContext(userId, limit = 10) {
  const rows = db.exec(`SELECT role, content FROM user_context WHERE user_id=? ORDER BY id DESC LIMIT ?`, [userId, limit]);
  if (!rows.length) return [];
  return rows[0].values.reverse().map(r => ({ role: r[0], content: r[1] }));
}

// ── Analysis History ─────────────────────────────────────────
export function saveAnalysis(data) {
  db.run(`INSERT INTO analysis_history(symbol,user_id,llm,analysis,signal,entry_price,stop_loss,take_profit,score) VALUES(?,?,?,?,?,?,?,?,?)`,
    [data.symbol, data.userId, data.llm, data.analysis, data.signal, data.entryPrice, data.stopLoss, data.takeProfit, data.score]);
  saveDB();
}

export function getAnalysisHistory(symbol, limit = 5) {
  const rows = db.exec(`SELECT llm,analysis,signal,entry_price,stop_loss,take_profit,score,timestamp FROM analysis_history WHERE symbol=? ORDER BY id DESC LIMIT ?`, [symbol, limit]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(r => { const o = {}; cols.forEach((c,i) => o[c]=r[i]); return o; });
}

// ── Strategy Performance (self-learning) ─────────────────────
export function savePerformance(data) {
  db.run(`INSERT INTO strategy_performance(symbol,signal,entry_price,exit_price,pnl_pct,strategy) VALUES(?,?,?,?,?,?)`,
    [data.symbol, data.signal, data.entryPrice, data.exitPrice, data.pnlPct, data.strategy]);
  saveDB();
}

export function getWinRate(strategy = null) {
  const where = strategy ? `WHERE strategy='${strategy}'` : '';
  const rows = db.exec(`SELECT COUNT(*) total, SUM(CASE WHEN pnl_pct>0 THEN 1 ELSE 0 END) wins, AVG(pnl_pct) avg_pnl FROM strategy_performance ${where}`);
  if (!rows.length || !rows[0].values[0][0]) return { total: 0, winRate: 0, avgPnl: 0 };
  const [total, wins, avgPnl] = rows[0].values[0];
  return { total, wins, winRate: total ? ((wins/total)*100).toFixed(1) : 0, avgPnl: avgPnl?.toFixed(2) || 0 };
}

// ── Scan Results ─────────────────────────────────────────────
export function saveScanResult(symbol, score, signal, price) {
  db.run(`INSERT INTO scan_results(symbol,score,signal,price) VALUES(?,?,?,?)`, [symbol, score, signal, price]);
  saveDB();
}

export function getRecentScans(limit = 20) {
  const rows = db.exec(`SELECT symbol,score,signal,price,timestamp FROM scan_results ORDER BY id DESC LIMIT ?`, [limit]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(r => { const o = {}; cols.forEach((c,i) => o[c]=r[i]); return o; });
}

// ═══════════════════════════════════════════════════════
// V3.1 TRADING SYSTEM TABLES
// ═══════════════════════════════════════════════════════
export function initTradingTables() {
  db.run(`
    -- Trade entries
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
      entry_price REAL NOT NULL,
      lots INTEGER NOT NULL,
      shares INTEGER NOT NULL,
      setup TEXT NOT NULL CHECK(setup IN ('KONGLO_MOMENTUM','BREAKOUT_VALID','REVERSAL_AKUMULASI')),
      confidence TEXT NOT NULL CHECK(confidence IN ('High','Medium','Low')),
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RUNNING','CLOSED')),
      result TEXT CHECK(result IN ('WIN','LOSS',NULL)),
      entry_time TEXT DEFAULT (datetime('now','localtime')),
      market_cond TEXT,
      score INTEGER,
      notes TEXT
    );

    -- Trade exits
    CREATE TABLE IF NOT EXISTS trade_exits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id INTEGER NOT NULL REFERENCES trades(id),
      user_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      exit_price REAL NOT NULL,
      lots_closed INTEGER NOT NULL,
      exit_type TEXT NOT NULL CHECK(exit_type IN ('TAKE_PROFIT','STOP_LOSS','EARLY_EXIT','RE_ENTRY_EXIT')),
      exit_reason TEXT,
      pnl_rp REAL,
      pnl_pct REAL,
      exit_time TEXT DEFAULT (datetime('now','localtime')),
      is_partial INTEGER DEFAULT 0
    );

    -- Portfolio per user
    CREATE TABLE IF NOT EXISTS portfolio (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      capital REAL NOT NULL DEFAULT 10000000,
      max_exposure_pct REAL DEFAULT 50,
      max_positions INTEGER DEFAULT 5,
      risk_per_trade_pct REAL DEFAULT 1,
      daily_trade_limit INTEGER DEFAULT 3,
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(user_id)
    );

    -- Daily trade counter
    CREATE TABLE IF NOT EXISTS daily_trades (
      user_id TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      PRIMARY KEY(user_id, trade_date)
    );

    -- Pending entry state (untuk multi-step Telegram flow)
    CREATE TABLE IF NOT EXISTS pending_entries (
      user_id TEXT PRIMARY KEY,
      symbol TEXT,
      side TEXT,
      price REAL,
      lots INTEGER,
      setup TEXT,
      confidence TEXT,
      step TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);
  saveDB();
}

// ── Trade CRUD ────────────────────────────────────────────────
export function createTrade(data) {
  const shares = data.lots * 100;
  db.run(`INSERT INTO trades(user_id,symbol,side,entry_price,lots,shares,setup,confidence,status,market_cond,score,notes)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [data.userId, data.symbol.toUpperCase(), data.side, data.entryPrice,
     data.lots, shares, data.setup, data.confidence,
     'OPEN', data.marketCond||null, data.score||null, data.notes||null]);
  saveDB();
  const rows = db.exec("SELECT last_insert_rowid() as id");
  return rows[0]?.values[0][0];
}

export function getOpenTrades(userId) {
  const rows = db.exec(
    `SELECT * FROM trades WHERE user_id=? AND status IN ('OPEN','RUNNING') ORDER BY entry_time DESC`,
    [userId]
  );
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(r => { const o={}; cols.forEach((c,i)=>o[c]=r[i]); return o; });
}

export function getTradeById(tradeId) {
  const rows = db.exec(`SELECT * FROM trades WHERE id=?`, [tradeId]);
  if (!rows.length || !rows[0].values.length) return null;
  const cols = rows[0].columns;
  const o = {}; cols.forEach((c,i)=>o[c]=rows[0].values[0][i]); return o;
}

export function getOpenTradeBySymbol(userId, symbol) {
  const rows = db.exec(
    `SELECT * FROM trades WHERE user_id=? AND symbol=? AND status IN ('OPEN','RUNNING') ORDER BY entry_time DESC LIMIT 1`,
    [userId, symbol.toUpperCase()]
  );
  if (!rows.length || !rows[0].values.length) return null;
  const cols = rows[0].columns;
  const o={}; cols.forEach((c,i)=>o[c]=rows[0].values[0][i]); return o;
}

export function updateTradeStatus(tradeId, status, result=null) {
  db.run(`UPDATE trades SET status=?, result=? WHERE id=?`, [status, result, tradeId]);
  saveDB();
}

// ── Exit CRUD ────────────────────────────────────────────────
export function createExit(data) {
  db.run(`INSERT INTO trade_exits(trade_id,user_id,symbol,exit_price,lots_closed,exit_type,exit_reason,pnl_rp,pnl_pct,is_partial)
          VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [data.tradeId, data.userId, data.symbol, data.exitPrice, data.lotsClosed,
     data.exitType, data.exitReason||null, data.pnlRp||null, data.pnlPct||null, data.isPartial?1:0]);
  saveDB();
}

// ── Portfolio ────────────────────────────────────────────────
export function getPortfolio(userId) {
  const rows = db.exec(`SELECT * FROM portfolio WHERE user_id=?`, [userId]);
  if (!rows.length || !rows[0].values.length) {
    db.run(`INSERT OR IGNORE INTO portfolio(user_id) VALUES(?)`, [userId]);
    saveDB();
    return { user_id:userId, capital:10000000, max_exposure_pct:50, max_positions:5, risk_per_trade_pct:1, daily_trade_limit:3 };
  }
  const cols = rows[0].columns;
  const o={}; cols.forEach((c,i)=>o[c]=rows[0].values[0][i]); return o;
}

export function updatePortfolio(userId, updates) {
  const fields = Object.keys(updates).map(k=>`${k}=?`).join(',');
  db.run(`UPDATE portfolio SET ${fields}, updated_at=datetime('now','localtime') WHERE user_id=?`,
    [...Object.values(updates), userId]);
  saveDB();
}

// ── Daily limit ──────────────────────────────────────────────
export function getDailyTradeCount(userId) {
  const today = new Date().toISOString().split('T')[0];
  const rows = db.exec(`SELECT count FROM daily_trades WHERE user_id=? AND trade_date=?`, [userId, today]);
  return rows.length && rows[0].values.length ? rows[0].values[0][0] : 0;
}

export function incrementDailyTrade(userId) {
  const today = new Date().toISOString().split('T')[0];
  db.run(`INSERT INTO daily_trades(user_id,trade_date,count) VALUES(?,?,1)
          ON CONFLICT(user_id,trade_date) DO UPDATE SET count=count+1`, [userId, today]);
  saveDB();
}

// ── Pending entry state ───────────────────────────────────────
export function setPendingEntry(userId, data) {
  db.run(`INSERT OR REPLACE INTO pending_entries(user_id,symbol,side,price,lots,setup,confidence,step)
          VALUES(?,?,?,?,?,?,?,?)`,
    [userId, data.symbol||null, data.side||null, data.price||null,
     data.lots||null, data.setup||null, data.confidence||null, data.step||'START']);
  saveDB();
}

export function getPendingEntry(userId) {
  const rows = db.exec(`SELECT * FROM pending_entries WHERE user_id=?`, [userId]);
  if (!rows.length || !rows[0].values.length) return null;
  const cols = rows[0].columns;
  const o={}; cols.forEach((c,i)=>o[c]=rows[0].values[0][i]); return o;
}

export function clearPendingEntry(userId) {
  db.run(`DELETE FROM pending_entries WHERE user_id=?`, [userId]);
  saveDB();
}

// ── Stats & reporting ────────────────────────────────────────
export function getTradeStats(userId, symbol=null) {
  const where = symbol ? `AND t.symbol='${symbol.toUpperCase()}'` : '';
  const rows = db.exec(`
    SELECT
      COUNT(*) total,
      SUM(CASE WHEN t.result='WIN' THEN 1 ELSE 0 END) wins,
      SUM(CASE WHEN t.result='LOSS' THEN 1 ELSE 0 END) losses,
      ROUND(AVG(CASE WHEN e.pnl_pct IS NOT NULL THEN e.pnl_pct END),2) avg_pnl_pct,
      ROUND(SUM(CASE WHEN e.pnl_rp IS NOT NULL THEN e.pnl_rp ELSE 0 END),0) total_pnl_rp,
      t.setup,
      COUNT(DISTINCT t.symbol) uniq_symbols
    FROM trades t
    LEFT JOIN trade_exits e ON e.trade_id=t.id
    WHERE t.user_id=? AND t.status='CLOSED' ${where}
    GROUP BY t.user_id
  `, [userId]);
  if (!rows.length || !rows[0].values.length) return null;
  const cols = rows[0].columns;
  const o={}; cols.forEach((c,i)=>o[c]=rows[0].values[0][i]); return o;
}

export function getTradeHistory(userId, limit=10) {
  const rows = db.exec(`
    SELECT t.id, t.symbol, t.side, t.entry_price, t.lots, t.setup, t.status, t.result,
           t.entry_time, e.exit_price, e.exit_type, e.pnl_rp, e.pnl_pct, e.exit_time
    FROM trades t
    LEFT JOIN trade_exits e ON e.trade_id=t.id
    WHERE t.user_id=?
    ORDER BY t.entry_time DESC LIMIT ?
  `, [userId, limit]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(r => { const o={}; cols.forEach((c,i)=>o[c]=r[i]); return o; });
}

export function getStatsBySetup(userId) {
  const rows = db.exec(`
    SELECT t.setup,
      COUNT(*) total,
      SUM(CASE WHEN t.result='WIN' THEN 1 ELSE 0 END) wins,
      ROUND(AVG(e.pnl_pct),2) avg_pnl,
      ROUND(SUM(CASE WHEN e.pnl_rp IS NOT NULL THEN e.pnl_rp ELSE 0 END),0) total_pnl
    FROM trades t
    LEFT JOIN trade_exits e ON e.trade_id=t.id
    WHERE t.user_id=? AND t.status='CLOSED'
    GROUP BY t.setup
  `, [userId]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(r => { const o={}; cols.forEach((c,i)=>o[c]=r[i]); return o; });
}

// EV = winrate * avg_win - lossrate * avg_loss
export function calcEV(userId) {
  const rows = db.exec(`
    SELECT
      ROUND(AVG(CASE WHEN t.result='WIN'  THEN e.pnl_pct END),2) avg_win,
      ROUND(AVG(CASE WHEN t.result='LOSS' THEN ABS(e.pnl_pct) END),2) avg_loss,
      ROUND(1.0*SUM(CASE WHEN t.result='WIN' THEN 1 ELSE 0 END)/COUNT(*),3) winrate
    FROM trades t
    LEFT JOIN trade_exits e ON e.trade_id=t.id
    WHERE t.user_id=? AND t.status='CLOSED'
  `, [userId]);
  if (!rows.length || !rows[0].values.length) return null;
  const [avgWin, avgLoss, wr] = rows[0].values[0];
  if (!avgWin || !avgLoss || !wr) return null;
  const ev = (wr * avgWin) - ((1-wr) * avgLoss);
  return { winrate: (wr*100).toFixed(1), avgWin, avgLoss, ev: ev.toFixed(2) };
}

// ── Compounding & Rebalancing ────────────────────────────────
export function applyCompounding(userId) {
  // Hitung total PnL closed trades, tambahkan ke capital
  const rows = db.exec(`
    SELECT SUM(e.pnl_rp) total_pnl
    FROM trade_exits e
    JOIN trades t ON t.id = e.trade_id
    WHERE t.user_id=? AND t.status='CLOSED'
  `, [userId]);
  if (!rows.length || !rows[0].values[0][0]) return null;
  const totalPnl = rows[0].values[0][0];
  const port = getPortfolio(userId);
  const newCapital = port.capital + totalPnl;
  db.run(`UPDATE portfolio SET capital=?, updated_at=datetime('now','localtime') WHERE user_id=?`,
    [newCapital, userId]);
  saveDB();
  return { oldCapital: port.capital, newCapital, totalPnl };
}

export function autoRebalance(userId) {
  // Hitung exposure saat ini vs max
  const port  = getPortfolio(userId);
  const open  = getOpenTrades(userId);
  if (open.length === 0) return { status: 'no_positions' };

  const maxExp  = port.capital * (port.max_exposure_pct / 100);
  const riskPer = port.capital * (port.risk_per_trade_pct / 100);

  const suggestions = [];
  for (const t of open) {
    const posValue = t.entry_price * t.shares;
    const pct = (posValue / port.capital * 100).toFixed(1);
    if (posValue > riskPer * 3) {
      suggestions.push({
        symbol: t.symbol,
        action: 'REDUCE',
        reason: `Posisi Rp ${posValue.toLocaleString('id-ID')} (${pct}% modal) — terlalu besar`,
        suggestion: `Kurangi ke max ${Math.floor(riskPer * 3 / t.entry_price / 100)} lot`
      });
    }
  }
  if (open.length >= port.max_positions) {
    suggestions.push({ action: 'MAX_REACHED', reason: `Max ${port.max_positions} posisi tercapai — tunggu exit dulu` });
  }

  return { status: 'ok', suggestions, openPositions: open.length, maxPositions: port.max_positions };
}

// ── Multi-day context ────────────────────────────────────────
export function saveMultiDayContext(symbol, data) {
  db.run(`
    CREATE TABLE IF NOT EXISTS multiday_context (
      symbol TEXT PRIMARY KEY,
      trend_5d TEXT, trend_10d TEXT,
      avg_vol_5d REAL, avg_vol_10d REAL,
      support_5d REAL, resistance_5d REAL,
      last_setup TEXT, setup_count INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  db.run(`INSERT OR REPLACE INTO multiday_context(symbol,trend_5d,trend_10d,avg_vol_5d,avg_vol_10d,support_5d,resistance_5d,last_setup,updated_at)
          VALUES(?,?,?,?,?,?,?,?,datetime('now','localtime'))`,
    [symbol, data.trend5d, data.trend10d, data.avgVol5d, data.avgVol10d,
     data.support5d, data.resistance5d, data.lastSetup]);
  saveDB();
}

export function getMultiDayContext(symbol) {
  try {
    const rows = db.exec(`SELECT * FROM multiday_context WHERE symbol=?`, [symbol]);
    if (!rows.length || !rows[0].values.length) return null;
    const cols = rows[0].columns;
    const o={}; cols.forEach((c,i)=>o[c]=rows[0].values[0][i]); return o;
  } catch { return null; }
}

// ── Partial exit tracking ─────────────────────────────────────
export function createPartialExit(data) {
  // Kurangi lots dari trade tanpa close penuh
  const trade = getTradeById(data.tradeId);
  if (!trade) return null;

  createExit({ ...data, isPartial: true });

  const remaining = trade.lots - data.lotsClosed;
  if (remaining <= 0) {
    updateTradeStatus(data.tradeId, 'CLOSED', data.pnlRp >= 0 ? 'WIN' : 'LOSS');
  } else {
    // Update lots sisa
    db.run(`UPDATE trades SET lots=?, shares=?, status='RUNNING' WHERE id=?`,
      [remaining, remaining*100, data.tradeId]);
    saveDB();
  }
  return { remaining, fullyExited: remaining <= 0 };
}

export function getPartialExits(tradeId) {
  const rows = db.exec(`SELECT * FROM trade_exits WHERE trade_id=? ORDER BY exit_time ASC`, [tradeId]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(r => { const o={}; cols.forEach((c,i)=>o[c]=r[i]); return o; });
}

// ═══════════════════════════════════════════════════════
// OWNERSHIP / KEPEMILIKAN SAHAM
// ═══════════════════════════════════════════════════════
export function initOwnershipTable() {
  db.run(`
    CREATE TABLE IF NOT EXISTS ownership (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      lots INTEGER NOT NULL DEFAULT 0,
      avg_price REAL NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      first_buy TEXT DEFAULT (datetime('now','localtime')),
      last_update TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(user_id, symbol)
    );
    CREATE TABLE IF NOT EXISTS ownership_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('BUY','SELL','ADJUST')),
      lots INTEGER NOT NULL,
      price REAL NOT NULL,
      avg_before REAL,
      avg_after REAL,
      lots_before INTEGER,
      lots_after INTEGER,
      timestamp TEXT DEFAULT (datetime('now','localtime'))
    );
  `);
  saveDB();
}

export function getOwnership(userId) {
  const rows = db.exec(
    `SELECT symbol, lots, avg_price, total_cost, last_update
     FROM ownership WHERE user_id=? AND lots > 0 ORDER BY symbol`,
    [userId]
  );
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(r => { const o={}; cols.forEach((c,i)=>o[c]=r[i]); return o; });
}

export function getOwnershipBySymbol(userId, symbol) {
  const rows = db.exec(
    `SELECT * FROM ownership WHERE user_id=? AND symbol=?`,
    [userId, symbol.toUpperCase()]
  );
  if (!rows.length || !rows[0].values.length) return null;
  const cols = rows[0].columns;
  const o={}; cols.forEach((c,i)=>o[c]=rows[0].values[0][i]); return o;
}

export function upsertOwnership(userId, symbol, lots, price, action = 'BUY') {
  const sym      = symbol.toUpperCase();
  const existing = getOwnershipBySymbol(userId, sym);

  if (action === 'BUY' || action === 'ADD') {
    if (!existing || existing.lots === 0) {
      // Posisi baru
      db.run(
        `INSERT OR REPLACE INTO ownership(user_id,symbol,lots,avg_price,total_cost,last_update)
         VALUES(?,?,?,?,?,datetime('now','localtime'))`,
        [userId, sym, lots, price, lots * 100 * price]
      );
      _logOwnershipHistory(userId, sym, 'BUY', lots, price, 0, price, 0, lots);
    } else {
      // Tambah lot — hitung avg baru
      const oldLots    = existing.lots;
      const oldAvg     = existing.avg_price;
      const newLots    = oldLots + lots;
      // Avg = (old_lots*100*old_avg + new_lots*100*new_price) / (total_shares)
      const newAvg = ((oldLots * 100 * oldAvg) + (lots * 100 * price)) / (newLots * 100);
      const newCost    = newLots * 100 * newAvg;
      db.run(
        `UPDATE ownership SET lots=?, avg_price=?, total_cost=?, last_update=datetime('now','localtime')
         WHERE user_id=? AND symbol=?`,
        [newLots, newAvg, newCost, userId, sym]
      );
      _logOwnershipHistory(userId, sym, 'BUY', lots, price, oldAvg, newAvg, oldLots, newLots);
    }
  } else if (action === 'REMOVE' || action === 'SELL') {
    if (!existing) return;
    const remainLots = Math.max(0, existing.lots - lots);
    if (remainLots === 0) {
      db.run(
        `UPDATE ownership SET lots=0, avg_price=0, total_cost=0, last_update=datetime('now','localtime')
         WHERE user_id=? AND symbol=?`,
        [userId, sym]
      );
    } else {
      // Avg tidak berubah saat jual, hanya lot berkurang
      db.run(
        `UPDATE ownership SET lots=?, total_cost=?, last_update=datetime('now','localtime')
         WHERE user_id=? AND symbol=?`,
        [remainLots, remainLots * 100 * existing.avg_price, userId, sym]
      );
    }
    _logOwnershipHistory(userId, sym, 'SELL', lots, price, existing.avg_price, existing.avg_price, existing.lots, remainLots);
  }
  saveDB();
}

export function addManualOwnership(userId, symbol, lots, avgPrice) {
  const sym = symbol.toUpperCase();
  const existing = getOwnershipBySymbol(userId, sym);

  if (!existing) {
    db.run(
      `INSERT INTO ownership(user_id,symbol,lots,avg_price,total_cost,last_update)
       VALUES(?,?,?,?,?,datetime('now','localtime'))`,
      [userId, sym, lots, avgPrice, lots * 100 * avgPrice]
    );
  } else {
    const newLots = existing.lots + lots;
    const newAvg  = ((existing.lots * 100 * existing.avg_price) + (lots * 100 * avgPrice)) / (newLots * 100);
    db.run(
      `UPDATE ownership SET lots=?, avg_price=?, total_cost=?, last_update=datetime('now','localtime')
       WHERE user_id=? AND symbol=?`,
      [newLots, newAvg, newLots * 100 * newAvg, userId, sym]
    );
  }
  saveDB();
}

export function getOwnershipHistory(userId, symbol, limit = 10) {
  const rows = db.exec(
    `SELECT * FROM ownership_history WHERE user_id=? AND symbol=? ORDER BY id DESC LIMIT ?`,
    [userId, symbol.toUpperCase(), limit]
  );
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(r => { const o={}; cols.forEach((c,i)=>o[c]=r[i]); return o; });
}

function _logOwnershipHistory(userId, symbol, action, lots, price, avgBefore, avgAfter, lotsBefore, lotsAfter) {
  db.run(
    `INSERT INTO ownership_history(user_id,symbol,action,lots,price,avg_before,avg_after,lots_before,lots_after)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    [userId, symbol, action, lots, price, avgBefore, avgAfter, lotsBefore, lotsAfter]
  );
}
