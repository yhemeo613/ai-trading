import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger';
import { config } from '../config';

let db: Database.Database | null = null;

function getDbPath(): string {
  const suffix = config.testnetOnly ? 'testnet' : 'mainnet';
  return path.resolve(__dirname, '..', '..', 'data', `trading_${suffix}.db`);
}

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = getDbPath();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  initTables(db);
  migrateSchema(db);
  logger.info('SQLite 数据库已初始化', { path: dbPath });
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
      position_id INTEGER NOT NULL REFERENCES positions(id),
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
    CREATE TABLE IF NOT EXISTS roundtable_discussions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      symbol TEXT NOT NULL,
      depth TEXT NOT NULL,
      round1_json TEXT NOT NULL,
      round2_json TEXT,
      chairman_decision_json TEXT NOT NULL,
      consensus_level TEXT,
      duration_ms INTEGER,
      action_taken TEXT,
      timings_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_plans_symbol_status ON trading_plans(symbol, status);
    CREATE INDEX IF NOT EXISTS idx_positions_symbol_status ON positions(symbol, status);
    CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at);
    CREATE INDEX IF NOT EXISTS idx_strategy_memory_symbol ON strategy_memory(symbol, memory_type);
    CREATE INDEX IF NOT EXISTS idx_position_ops_position_id ON position_operations(position_id);
    CREATE INDEX IF NOT EXISTS idx_roundtable_symbol ON roundtable_discussions(symbol, created_at);
  `);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

export function resetDb() {
  closeDb();
  // Next call to getDb() will reinitialize with the current mode's database
}

function migrateSchema(db: Database.Database) {
  // Helper: check if a column exists in a table
  const hasColumn = (table: string, column: string): boolean => {
    // Validate table name to prevent SQL injection (only allow alphanumeric and underscores)
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      throw new Error(`Invalid table name: ${table}`);
    }
    const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as any[];
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
