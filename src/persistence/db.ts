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
  migrateSchema(db);
  logger.info('SQLite 数据库已初始化', { path: DB_PATH });
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
      ai_model TEXT,
      risk_passed INTEGER,
      risk_reason TEXT,
      executed INTEGER DEFAULT 0,
      indicators_json TEXT,
      orderbook_json TEXT,
      sentiment_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      amount REAL NOT NULL,
      entry_price REAL,
      exit_price REAL,
      leverage INTEGER,
      stop_loss REAL,
      take_profit REAL,
      entry_order_id TEXT,
      exit_order_id TEXT,
      pnl REAL,
      status TEXT DEFAULT 'open',
      opened_at TEXT DEFAULT (datetime('now')),
      closed_at TEXT
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

    CREATE TABLE IF NOT EXISTS strategy_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      content TEXT NOT NULL,
      market_condition TEXT,
      outcome TEXT,
      pnl_percent REAL,
      relevance_score REAL DEFAULT 1.0,
      tags TEXT,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS symbol_stats (
      symbol TEXT PRIMARY KEY,
      total_trades INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      total_pnl REAL DEFAULT 0,
      avg_win_pnl REAL DEFAULT 0,
      avg_loss_pnl REAL DEFAULT 0,
      best_trade_pnl REAL DEFAULT 0,
      worst_trade_pnl REAL DEFAULT 0,
      win_rate REAL DEFAULT 0,
      profit_factor REAL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS position_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL,
      operation TEXT NOT NULL,
      side TEXT NOT NULL,
      amount REAL NOT NULL,
      price REAL NOT NULL,
      pnl_realized REAL DEFAULT 0,
      avg_entry_after REAL,
      total_amount_after REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS strategy_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_type TEXT NOT NULL,
      trade_count_analyzed INTEGER DEFAULT 0,
      win_rate REAL,
      insights_json TEXT,
      recommendations_json TEXT,
      market_regime TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS trading_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      entry_condition TEXT,
      entry_zone_low REAL,
      entry_zone_high REAL,
      targets_json TEXT,
      stop_loss REAL,
      invalidation TEXT,
      invalidation_price REAL,
      timeframe TEXT,
      confidence REAL,
      reasoning TEXT,
      thesis TEXT,
      status TEXT DEFAULT 'PENDING',
      market_regime TEXT,
      narrative_snapshot TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT,
      activated_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_plans_symbol_status ON trading_plans(symbol, status);
  `);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

function migrateSchema(db: Database.Database) {
  // Helper: check if a column exists in a table
  const hasColumn = (table: string, column: string): boolean => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    return cols.some((c) => c.name === column);
  };

  // decisions: add new columns
  if (!hasColumn('decisions', 'ai_model')) {
    db.exec('ALTER TABLE decisions ADD COLUMN ai_model TEXT');
  }
  if (!hasColumn('decisions', 'indicators_json')) {
    db.exec('ALTER TABLE decisions ADD COLUMN indicators_json TEXT');
  }
  if (!hasColumn('decisions', 'orderbook_json')) {
    db.exec('ALTER TABLE decisions ADD COLUMN orderbook_json TEXT');
  }
  if (!hasColumn('decisions', 'sentiment_json')) {
    db.exec('ALTER TABLE decisions ADD COLUMN sentiment_json TEXT');
  }

  // positions: add advanced position management columns
  if (!hasColumn('positions', 'add_count')) {
    db.exec('ALTER TABLE positions ADD COLUMN add_count INTEGER DEFAULT 0');
  }
  if (!hasColumn('positions', 'reduce_count')) {
    db.exec('ALTER TABLE positions ADD COLUMN reduce_count INTEGER DEFAULT 0');
  }
  if (!hasColumn('positions', 'max_amount')) {
    db.exec('ALTER TABLE positions ADD COLUMN max_amount REAL');
  }
  if (!hasColumn('positions', 'avg_entry_price')) {
    db.exec('ALTER TABLE positions ADD COLUMN avg_entry_price REAL');
  }
  if (!hasColumn('positions', 't_trade_savings')) {
    db.exec('ALTER TABLE positions ADD COLUMN t_trade_savings REAL DEFAULT 0');
  }
  if (!hasColumn('positions', 'thesis')) {
    db.exec('ALTER TABLE positions ADD COLUMN thesis TEXT');
  }
  if (!hasColumn('positions', 'strategic_context')) {
    db.exec('ALTER TABLE positions ADD COLUMN strategic_context TEXT');
  }
}
