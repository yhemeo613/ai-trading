import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger';

const DB_PATH = path.resolve(__dirname, '..', '..', 'data', 'trading.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  initTables(db);
  logger.info('SQLite database initialized', { path: DB_PATH });
  return db;
}

function initTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      action TEXT NOT NULL,
      side TEXT,
      amount REAL,
      price REAL,
      leverage INTEGER,
      stop_loss REAL,
      take_profit REAL,
      order_id TEXT,
      confidence REAL,
      reasoning TEXT,
      ai_provider TEXT,
      status TEXT DEFAULT 'executed',
      pnl REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      action TEXT NOT NULL,
      confidence REAL,
      reasoning TEXT,
      raw_response TEXT,
      ai_provider TEXT,
      risk_passed INTEGER,
      risk_reason TEXT,
      executed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      total_balance REAL,
      available_balance REAL,
      unrealized_pnl REAL,
      position_count INTEGER,
      positions_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS daily_pnl (
      date TEXT PRIMARY KEY,
      starting_balance REAL,
      ending_balance REAL,
      realized_pnl REAL DEFAULT 0,
      trade_count INTEGER DEFAULT 0
    );
  `);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
