import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { vi } from 'vitest';

// We test the persistence layer by importing the real model functions
// but mocking getDb() to return an in-memory SQLite database.

let testDb: Database.Database;

// Schema creation extracted to mirror src/persistence/db.ts initTables + migrateSchema
function initTestDb(db: Database.Database) {
  db.pragma('foreign_keys = ON');
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
      closed_at TEXT,
      add_count INTEGER DEFAULT 0,
      reduce_count INTEGER DEFAULT 0,
      max_amount REAL,
      avg_entry_price REAL,
      t_trade_savings REAL DEFAULT 0,
      thesis TEXT,
      strategic_context TEXT
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

    CREATE INDEX IF NOT EXISTS idx_plans_symbol_status ON trading_plans(symbol, status);
    CREATE INDEX IF NOT EXISTS idx_positions_symbol_status ON positions(symbol, status);
    CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at);
    CREATE INDEX IF NOT EXISTS idx_strategy_memory_symbol ON strategy_memory(symbol, memory_type);
    CREATE INDEX IF NOT EXISTS idx_position_ops_position_id ON position_operations(position_id);
  `);
}

// Mock getDb to return our in-memory database
vi.mock('../../src/persistence/db', () => ({
  getDb: () => testDb,
  closeDb: () => {},
  resetDb: () => {},
}));

beforeEach(() => {
  testDb = new Database(':memory:');
  initTestDb(testDb);
});

afterEach(() => {
  testDb.close();
});

// ─── Schema Tests ────────────────────────────────────────────────

describe('Schema creation', () => {
  it('creates all expected tables', () => {
    const tables = testDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name).sort();
    expect(names).toEqual([
      'daily_pnl', 'decisions', 'position_operations', 'positions',
      'snapshots', 'strategy_memory', 'strategy_reviews', 'symbol_stats',
      'trades', 'trading_plans',
    ]);
  });

  it('creates expected indexes', () => {
    const indexes = testDb
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name")
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_positions_symbol_status');
    expect(names).toContain('idx_trades_created_at');
    expect(names).toContain('idx_strategy_memory_symbol');
    expect(names).toContain('idx_position_ops_position_id');
    expect(names).toContain('idx_plans_symbol_status');
  });

  it('positions table has all migration columns', () => {
    const cols = testDb.prepare('PRAGMA table_info(positions)').all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('add_count');
    expect(colNames).toContain('reduce_count');
    expect(colNames).toContain('max_amount');
    expect(colNames).toContain('avg_entry_price');
    expect(colNames).toContain('t_trade_savings');
    expect(colNames).toContain('thesis');
    expect(colNames).toContain('strategic_context');
  });
});

// ─── Trade Recording Tests ───────────────────────────────────────

describe('Trade recording', () => {
  // Import after mock is set up
  let insertTrade: typeof import('../../src/persistence/models/trade').insertTrade;
  let getRecentTrades: typeof import('../../src/persistence/models/trade').getRecentTrades;

  beforeEach(async () => {
    const mod = await import('../../src/persistence/models/trade');
    insertTrade = mod.insertTrade;
    getRecentTrades = mod.getRecentTrades;
  });

  it('inserts and retrieves a trade', () => {
    const result = insertTrade({
      symbol: 'BTC/USDT:USDT',
      action: 'LONG',
      side: 'buy',
      amount: 0.01,
      price: 50000,
      leverage: 5,
      stopLoss: 48000,
      takeProfit: 55000,
      orderId: 'order-1',
      confidence: 0.85,
      reasoning: 'Bullish breakout',
      aiProvider: 'deepseek',
      pnl: 100,
    });
    expect(result.changes).toBe(1);

    const trades = getRecentTrades(10) as any[];
    expect(trades).toHaveLength(1);
    expect(trades[0].symbol).toBe('BTC/USDT:USDT');
    expect(trades[0].action).toBe('LONG');
    expect(trades[0].price).toBe(50000);
    expect(trades[0].pnl).toBe(100);
  });

  it('inserts trade with minimal fields', () => {
    insertTrade({ symbol: 'ETH/USDT:USDT', action: 'HOLD' });
    const trades = getRecentTrades(10) as any[];
    expect(trades).toHaveLength(1);
    expect(trades[0].side).toBeNull();
    expect(trades[0].amount).toBeNull();
  });
});

// ─── Position Lifecycle Tests ────────────────────────────────────

describe('Position lifecycle (open -> add -> reduce -> close)', () => {
  let insertPosition: typeof import('../../src/persistence/models/position').insertPosition;
  let getOpenPositions: typeof import('../../src/persistence/models/position').getOpenPositions;
  let getOpenPositionBySymbol: typeof import('../../src/persistence/models/position').getOpenPositionBySymbol;
  let updatePositionAdd: typeof import('../../src/persistence/models/position').updatePositionAdd;
  let updatePositionReduce: typeof import('../../src/persistence/models/position').updatePositionReduce;
  let closePosition: typeof import('../../src/persistence/models/position').closePosition;
  let getPositionHistory: typeof import('../../src/persistence/models/position').getPositionHistory;
  let insertPositionOperation: typeof import('../../src/persistence/models/position-ops').insertPositionOperation;
  let getPositionOperations: typeof import('../../src/persistence/models/position-ops').getPositionOperations;
  let calcNewAvgEntry: typeof import('../../src/persistence/models/position-ops').calcNewAvgEntry;
  let calcReducePnl: typeof import('../../src/persistence/models/position-ops').calcReducePnl;

  beforeEach(async () => {
    const posMod = await import('../../src/persistence/models/position');
    insertPosition = posMod.insertPosition;
    getOpenPositions = posMod.getOpenPositions;
    getOpenPositionBySymbol = posMod.getOpenPositionBySymbol;
    updatePositionAdd = posMod.updatePositionAdd;
    updatePositionReduce = posMod.updatePositionReduce;
    closePosition = posMod.closePosition;
    getPositionHistory = posMod.getPositionHistory;

    const opsMod = await import('../../src/persistence/models/position-ops');
    insertPositionOperation = opsMod.insertPositionOperation;
    getPositionOperations = opsMod.getPositionOperations;
    calcNewAvgEntry = opsMod.calcNewAvgEntry;
    calcReducePnl = opsMod.calcReducePnl;
  });

  it('opens a position', () => {
    const result = insertPosition({
      symbol: 'BTC/USDT:USDT',
      side: 'long',
      amount: 0.1,
      entryPrice: 50000,
      leverage: 5,
      stopLoss: 48000,
      takeProfit: 55000,
    });
    expect(result.changes).toBe(1);

    const positions = getOpenPositions() as any[];
    expect(positions).toHaveLength(1);
    expect(positions[0].symbol).toBe('BTC/USDT:USDT');
    expect(positions[0].amount).toBe(0.1);
    expect(positions[0].avg_entry_price).toBe(50000);
    expect(positions[0].max_amount).toBe(0.1);
    expect(positions[0].status).toBe('open');
  });

  it('adds to a position and updates avg entry', () => {
    insertPosition({
      symbol: 'BTC/USDT:USDT', side: 'long', amount: 0.1, entryPrice: 50000,
    });

    // Add 0.1 BTC at 52000
    const newAvg = calcNewAvgEntry(50000, 0.1, 52000, 0.1);
    expect(newAvg).toBe(51000); // (50000*0.1 + 52000*0.1) / 0.2

    updatePositionAdd('BTC/USDT:USDT', newAvg, 0.2);

    const pos = getOpenPositionBySymbol('BTC/USDT:USDT');
    expect(pos.amount).toBe(0.2);
    expect(pos.avg_entry_price).toBe(51000);
    expect(pos.add_count).toBe(1);
    expect(pos.max_amount).toBe(0.2);
  });

  it('reduces a position and tracks realized PnL', () => {
    insertPosition({
      symbol: 'ETH/USDT:USDT', side: 'long', amount: 1.0, entryPrice: 3000,
    });

    // Reduce 0.5 ETH at 3200 (profit)
    const pnl = calcReducePnl('long', 3000, 3200, 0.5);
    expect(pnl).toBe(100); // (3200 - 3000) * 0.5

    updatePositionReduce('ETH/USDT:USDT', 0.5, pnl);

    const pos = getOpenPositionBySymbol('ETH/USDT:USDT');
    expect(pos.amount).toBe(0.5);
    expect(pos.reduce_count).toBe(1);
    expect(pos.t_trade_savings).toBe(100);
  });

  it('closes a position', () => {
    insertPosition({
      symbol: 'BTC/USDT:USDT', side: 'long', amount: 0.1, entryPrice: 50000,
    });

    closePosition({
      symbol: 'BTC/USDT:USDT', exitPrice: 55000, pnl: 500, exitOrderId: 'exit-1',
    });

    const open = getOpenPositions() as any[];
    expect(open).toHaveLength(0);

    const history = getPositionHistory(10) as any[];
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe('closed');
    expect(history[0].pnl).toBe(500);
    expect(history[0].exit_price).toBe(55000);
    expect(history[0].closed_at).toBeTruthy();
  });

  it('records position operations with FK to positions', () => {
    const result = insertPosition({
      symbol: 'BTC/USDT:USDT', side: 'long', amount: 0.1, entryPrice: 50000,
    });
    const posId = Number(result.lastInsertRowid);

    insertPositionOperation({
      positionId: posId, operation: 'OPEN', side: 'long',
      amount: 0.1, price: 50000, avgEntryAfter: 50000, totalAmountAfter: 0.1,
    });
    insertPositionOperation({
      positionId: posId, operation: 'ADD', side: 'long',
      amount: 0.05, price: 52000, avgEntryAfter: 50666.67, totalAmountAfter: 0.15,
    });

    const ops = getPositionOperations(posId);
    expect(ops).toHaveLength(2);
    expect(ops[0].operation).toBe('OPEN');
    expect(ops[1].operation).toBe('ADD');
  });

  it('FK constraint prevents orphan position_operations', () => {
    expect(() => {
      insertPositionOperation({
        positionId: 9999, operation: 'OPEN', side: 'long',
        amount: 0.1, price: 50000,
      });
    }).toThrow();
  });
});

// ─── PnL Calculation Tests ───────────────────────────────────────

describe('PnL calculations', () => {
  let calcNewAvgEntry: typeof import('../../src/persistence/models/position-ops').calcNewAvgEntry;
  let calcReducePnl: typeof import('../../src/persistence/models/position-ops').calcReducePnl;

  beforeEach(async () => {
    const mod = await import('../../src/persistence/models/position-ops');
    calcNewAvgEntry = mod.calcNewAvgEntry;
    calcReducePnl = mod.calcReducePnl;
  });

  it('calculates avg entry for single add', () => {
    // 0.1 BTC @ 50000, add 0.1 @ 52000
    expect(calcNewAvgEntry(50000, 0.1, 52000, 0.1)).toBe(51000);
  });

  it('calculates avg entry for unequal amounts', () => {
    // 0.3 BTC @ 50000, add 0.1 @ 54000
    const avg = calcNewAvgEntry(50000, 0.3, 54000, 0.1);
    expect(avg).toBe(51000); // (50000*0.3 + 54000*0.1) / 0.4 = 51000
  });

  it('returns newPrice when totalAmount is 0', () => {
    expect(calcNewAvgEntry(0, 0, 50000, 0)).toBe(50000);
  });

  it('calculates long reduce PnL (profit)', () => {
    expect(calcReducePnl('long', 50000, 55000, 0.1)).toBe(500);
  });

  it('calculates long reduce PnL (loss)', () => {
    expect(calcReducePnl('long', 50000, 48000, 0.1)).toBe(-200);
  });

  it('calculates short reduce PnL (profit)', () => {
    expect(calcReducePnl('short', 50000, 45000, 0.1)).toBe(500);
  });

  it('calculates short reduce PnL (loss)', () => {
    expect(calcReducePnl('short', 50000, 52000, 0.1)).toBe(-200);
  });

  it('handles buy side same as long', () => {
    expect(calcReducePnl('buy', 50000, 55000, 0.1)).toBe(500);
  });
});

// ─── Daily PnL Aggregation Tests ─────────────────────────────────

describe('Daily PnL aggregation', () => {
  let updateDailyPnl: typeof import('../../src/persistence/models/snapshot').updateDailyPnl;
  let getDailyPnlHistory: typeof import('../../src/persistence/models/snapshot').getDailyPnlHistory;

  beforeEach(async () => {
    const mod = await import('../../src/persistence/models/snapshot');
    updateDailyPnl = mod.updateDailyPnl;
    getDailyPnlHistory = mod.getDailyPnlHistory;
  });

  it('creates a new daily record', () => {
    updateDailyPnl('2025-01-15', 10000, 50, 1);
    const rows = getDailyPnlHistory(30) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe('2025-01-15');
    expect(rows[0].starting_balance).toBe(10000);
    expect(rows[0].ending_balance).toBe(10000);
    expect(rows[0].realized_pnl).toBe(50);
    expect(rows[0].trade_count).toBe(1);
  });

  it('accumulates PnL on same day', () => {
    updateDailyPnl('2025-01-15', 10000, 50, 1);
    updateDailyPnl('2025-01-15', 10100, 80, 2);

    const rows = getDailyPnlHistory(30) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].realized_pnl).toBe(130); // 50 + 80
    expect(rows[0].trade_count).toBe(3);    // 1 + 2
    expect(rows[0].ending_balance).toBe(10100);
    expect(rows[0].starting_balance).toBe(10000); // unchanged
  });

  it('handles multiple days', () => {
    updateDailyPnl('2025-01-15', 10000, 50, 1);
    updateDailyPnl('2025-01-16', 10050, -20, 1);

    const rows = getDailyPnlHistory(30) as any[];
    expect(rows).toHaveLength(2);
    // Ordered DESC
    expect(rows[0].date).toBe('2025-01-16');
    expect(rows[1].date).toBe('2025-01-15');
  });
});

// ─── Memory Storage and Decay Tests ──────────────────────────────

describe('Memory storage and decay', () => {
  let insertMemory: typeof import('../../src/memory/memory-store').insertMemory;
  let getRelevantMemories: typeof import('../../src/memory/memory-store').getRelevantMemories;
  let decayMemories: typeof import('../../src/memory/memory-store').decayMemories;
  let boostMemory: typeof import('../../src/memory/memory-store').boostMemory;

  beforeEach(async () => {
    const mod = await import('../../src/memory/memory-store');
    insertMemory = mod.insertMemory;
    getRelevantMemories = mod.getRelevantMemories;
    decayMemories = mod.decayMemories;
    boostMemory = mod.boostMemory;
  });

  it('inserts and retrieves memories', () => {
    insertMemory({
      symbol: 'BTC/USDT:USDT',
      memoryType: 'insight',
      content: 'BTC tends to bounce at 48000 support',
      marketCondition: 'ranging',
      outcome: 'win',
      pnlPercent: 2.5,
      relevanceScore: 1.0,
      tags: 'support,bounce',
    });

    const memories = getRelevantMemories('BTC/USDT:USDT');
    expect(memories).toHaveLength(1);
    expect(memories[0].content).toBe('BTC tends to bounce at 48000 support');
    expect(memories[0].pnl_percent).toBe(2.5);
  });

  it('retrieves wildcard (*) memories for any symbol', () => {
    insertMemory({
      symbol: '*',
      memoryType: 'recommendation',
      content: 'Avoid trading during low volume hours',
      relevanceScore: 1.2,
    });

    const memories = getRelevantMemories('ETH/USDT:USDT');
    expect(memories).toHaveLength(1);
    expect(memories[0].content).toContain('low volume');
  });

  it('filters by market condition', () => {
    insertMemory({
      symbol: 'BTC/USDT:USDT', memoryType: 'insight',
      content: 'Trending insight', marketCondition: 'trending_up',
    });
    insertMemory({
      symbol: 'BTC/USDT:USDT', memoryType: 'insight',
      content: 'Ranging insight', marketCondition: 'ranging',
    });

    const trending = getRelevantMemories('BTC/USDT:USDT', 'trending_up');
    // Should include trending_up and NULL condition memories
    const contents = trending.map((m: any) => m.content);
    expect(contents).toContain('Trending insight');
  });

  it('decays old memories', () => {
    // Insert a memory with old timestamp
    testDb.prepare(`
      INSERT INTO strategy_memory (symbol, memory_type, content, relevance_score, created_at)
      VALUES (?, ?, ?, ?, datetime('now', '-5 days'))
    `).run('BTC/USDT:USDT', 'insight', 'Old memory', 1.0);

    decayMemories();

    const memories = getRelevantMemories('BTC/USDT:USDT');
    expect(memories).toHaveLength(1);
    expect(memories[0].relevance_score).toBeCloseTo(0.95, 2);
  });

  it('boosts a memory relevance', () => {
    const result = insertMemory({
      symbol: 'BTC/USDT:USDT', memoryType: 'insight',
      content: 'Important pattern', relevanceScore: 1.0,
    });
    const id = Number(result.lastInsertRowid);

    boostMemory(id);

    const memories = getRelevantMemories('BTC/USDT:USDT');
    expect(memories[0].relevance_score).toBeCloseTo(1.2, 2);
  });

  it('decay does not go below 0.1', () => {
    testDb.prepare(`
      INSERT INTO strategy_memory (symbol, memory_type, content, relevance_score, created_at)
      VALUES (?, ?, ?, ?, datetime('now', '-5 days'))
    `).run('BTC/USDT:USDT', 'insight', 'Very old memory', 0.1);

    decayMemories();

    const memories = getRelevantMemories('BTC/USDT:USDT');
    // relevance_score <= 0.1 should not be decayed further
    expect(memories[0].relevance_score).toBe(0.1);
  });
});

// ─── Decision Recording Tests ────────────────────────────────────

describe('Decision recording', () => {
  let insertDecision: typeof import('../../src/persistence/models/decision').insertDecision;
  let getRecentDecisions: typeof import('../../src/persistence/models/decision').getRecentDecisions;
  let updateDecisionExecuted: typeof import('../../src/persistence/models/decision').updateDecisionExecuted;

  beforeEach(async () => {
    const mod = await import('../../src/persistence/models/decision');
    insertDecision = mod.insertDecision;
    getRecentDecisions = mod.getRecentDecisions;
    updateDecisionExecuted = mod.updateDecisionExecuted;
  });

  it('inserts and retrieves a decision', () => {
    insertDecision({
      symbol: 'BTC/USDT:USDT',
      action: 'LONG',
      confidence: 0.85,
      reasoning: 'Bullish breakout',
      aiProvider: 'deepseek',
      aiModel: 'deepseek-chat',
      riskPassed: true,
      executed: false,
    });

    const decisions = getRecentDecisions(10) as any[];
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('LONG');
    expect(decisions[0].risk_passed).toBe(1);
    expect(decisions[0].executed).toBe(0);
  });

  it('marks a decision as executed', () => {
    const result = insertDecision({
      symbol: 'BTC/USDT:USDT', action: 'LONG',
      riskPassed: true, executed: false,
    });
    const id = Number(result.lastInsertRowid);

    updateDecisionExecuted(id);

    const decisions = getRecentDecisions(10) as any[];
    expect(decisions[0].executed).toBe(1);
  });
});

// ─── Snapshot Tests ──────────────────────────────────────────────

describe('Snapshot recording', () => {
  let insertSnapshot: typeof import('../../src/persistence/models/snapshot').insertSnapshot;
  let getRecentSnapshots: typeof import('../../src/persistence/models/snapshot').getRecentSnapshots;

  beforeEach(async () => {
    const mod = await import('../../src/persistence/models/snapshot');
    insertSnapshot = mod.insertSnapshot;
    getRecentSnapshots = mod.getRecentSnapshots;
  });

  it('inserts and retrieves snapshots', () => {
    insertSnapshot({
      totalBalance: 10000,
      availableBalance: 8000,
      unrealizedPnl: 200,
      positionCount: 2,
      positionsJson: '[]',
    });

    const snaps = getRecentSnapshots(10) as any[];
    expect(snaps).toHaveLength(1);
    expect(snaps[0].total_balance).toBe(10000);
    expect(snaps[0].position_count).toBe(2);
  });
});
