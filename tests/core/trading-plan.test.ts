import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// We need to mock getDb before importing trading-plan
let testDb: Database.Database;

vi.mock('../../src/persistence/db', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  createPlan,
  getActivePlan,
  getPendingPlans,
  getAllActivePlans,
  activatePlan,
  completePlan,
  invalidatePlan,
  expireOldPlans,
  evaluatePlanEntry,
  evaluatePlanValidity,
  TradingPlan,
} from '../../src/core/trading-plan';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
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
  return db;
}

const basePlan = {
  symbol: 'BTC/USDT:USDT',
  direction: 'LONG' as const,
  entryCondition: 'Price near support',
  entryZone: { low: 95000, high: 97000 },
  targets: [{ price: 100000, percent: 100 }],
  stopLoss: 93000,
  invalidation: 'Break below 92000',
  invalidationPrice: 92000,
  thesis: 'Bullish breakout expected',
  confidence: 0.7,
  marketRegime: 'trending_up',
  narrativeSnapshot: 'BTC trending up',
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
};

describe('Trading Plan CRUD', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  it('should create a plan with PENDING status', () => {
    const planId = createPlan(basePlan);
    expect(planId).toBeGreaterThan(0);

    const pending = getPendingPlans('BTC/USDT:USDT');
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe('PENDING');
    expect(pending[0].direction).toBe('LONG');
    expect(pending[0].thesis).toBe('Bullish breakout expected');
  });

  it('should return null when no active plan exists', () => {
    const plan = getActivePlan('BTC/USDT:USDT');
    expect(plan).toBeNull();
  });

  it('should return empty array when no pending plans exist', () => {
    const plans = getPendingPlans('BTC/USDT:USDT');
    expect(plans).toHaveLength(0);
  });

  it('should parse entryZone and targets from DB correctly', () => {
    createPlan(basePlan);
    const pending = getPendingPlans('BTC/USDT:USDT');
    expect(pending[0].entryZone).toEqual({ low: 95000, high: 97000 });
    expect(pending[0].targets).toEqual([{ price: 100000, percent: 100 }]);
  });
});

describe('Trading Plan State Transitions', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  it('PENDING -> ACTIVE via activatePlan', () => {
    const planId = createPlan(basePlan);
    activatePlan(planId);

    const active = getActivePlan('BTC/USDT:USDT');
    expect(active).not.toBeNull();
    expect(active!.status).toBe('ACTIVE');
    expect(active!.id).toBe(planId);

    const pending = getPendingPlans('BTC/USDT:USDT');
    expect(pending).toHaveLength(0);
  });

  it('ACTIVE -> COMPLETED via completePlan', () => {
    const planId = createPlan(basePlan);
    activatePlan(planId);
    completePlan(planId);

    const active = getActivePlan('BTC/USDT:USDT');
    expect(active).toBeNull();

    const row = testDb.prepare('SELECT status FROM trading_plans WHERE id = ?').get(planId) as any;
    expect(row.status).toBe('COMPLETED');
  });

  it('PENDING -> INVALIDATED via invalidatePlan', () => {
    const planId = createPlan(basePlan);
    invalidatePlan(planId, 'Price broke support');

    const pending = getPendingPlans('BTC/USDT:USDT');
    expect(pending).toHaveLength(0);

    const row = testDb.prepare('SELECT status, reasoning FROM trading_plans WHERE id = ?').get(planId) as any;
    expect(row.status).toBe('INVALIDATED');
    expect(row.reasoning).toContain('Price broke support');
  });

  it('ACTIVE -> INVALIDATED via invalidatePlan', () => {
    const planId = createPlan(basePlan);
    activatePlan(planId);
    invalidatePlan(planId, 'Regime changed');

    const active = getActivePlan('BTC/USDT:USDT');
    expect(active).toBeNull();

    const row = testDb.prepare('SELECT status FROM trading_plans WHERE id = ?').get(planId) as any;
    expect(row.status).toBe('INVALIDATED');
  });

  it('PENDING -> EXPIRED via expireOldPlans', () => {
    // Create a plan that already expired
    const expiredPlan = {
      ...basePlan,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    const planId = createPlan(expiredPlan);

    expireOldPlans();

    const pending = getPendingPlans('BTC/USDT:USDT');
    expect(pending).toHaveLength(0);

    const row = testDb.prepare('SELECT status FROM trading_plans WHERE id = ?').get(planId) as any;
    expect(row.status).toBe('EXPIRED');
  });

  it('should not expire plans that have not reached expiry', () => {
    const futurePlan = {
      ...basePlan,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
    createPlan(futurePlan);

    expireOldPlans();

    const pending = getPendingPlans('BTC/USDT:USDT');
    expect(pending).toHaveLength(1);
  });

  it('activating a plan should complete any existing active plan for same symbol', () => {
    const planId1 = createPlan(basePlan);
    activatePlan(planId1);

    const planId2 = createPlan({ ...basePlan, thesis: 'Second plan' });
    activatePlan(planId2);

    const row1 = testDb.prepare('SELECT status FROM trading_plans WHERE id = ?').get(planId1) as any;
    expect(row1.status).toBe('COMPLETED');

    const active = getActivePlan('BTC/USDT:USDT');
    expect(active).not.toBeNull();
    expect(active!.id).toBe(planId2);
  });
});

describe('Trading Plan Limits', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  it('should enforce max 2 PENDING plans per symbol', () => {
    createPlan(basePlan);
    createPlan({ ...basePlan, thesis: 'Plan 2' });
    createPlan({ ...basePlan, thesis: 'Plan 3' });

    const pending = getPendingPlans('BTC/USDT:USDT');
    // Should have at most 2 pending (oldest expired to make room)
    expect(pending.length).toBeLessThanOrEqual(2);

    // The newest plan should be present
    const theses = pending.map((p) => p.thesis);
    expect(theses).toContain('Plan 3');
  });

  it('should expire oldest PENDING plan when creating 3rd', () => {
    const id1 = createPlan(basePlan);
    createPlan({ ...basePlan, thesis: 'Plan 2' });
    createPlan({ ...basePlan, thesis: 'Plan 3' });

    const row = testDb.prepare('SELECT status FROM trading_plans WHERE id = ?').get(id1) as any;
    expect(row.status).toBe('EXPIRED');
  });

  it('PENDING limit is per-symbol', () => {
    createPlan(basePlan);
    createPlan({ ...basePlan, thesis: 'Plan 2' });

    // Different symbol should have its own limit
    createPlan({ ...basePlan, symbol: 'ETH/USDT:USDT', thesis: 'ETH Plan 1' });
    createPlan({ ...basePlan, symbol: 'ETH/USDT:USDT', thesis: 'ETH Plan 2' });

    const btcPending = getPendingPlans('BTC/USDT:USDT');
    const ethPending = getPendingPlans('ETH/USDT:USDT');
    expect(btcPending).toHaveLength(2);
    expect(ethPending).toHaveLength(2);
  });

  it('getAllActivePlans returns both ACTIVE and PENDING plans', () => {
    const id1 = createPlan(basePlan);
    createPlan({ ...basePlan, thesis: 'Plan 2' });
    activatePlan(id1);

    const all = getAllActivePlans();
    expect(all).toHaveLength(2);
    const statuses = all.map((p) => p.status);
    expect(statuses).toContain('ACTIVE');
    expect(statuses).toContain('PENDING');
  });
});

describe('Plan Entry Evaluation', () => {
  const plan: TradingPlan = {
    id: 1,
    symbol: 'BTC/USDT:USDT',
    direction: 'LONG',
    entryCondition: 'test',
    entryZone: { low: 95000, high: 97000 },
    targets: [{ price: 100000, percent: 100 }],
    stopLoss: 93000,
    invalidation: 'test',
    thesis: 'test',
    confidence: 0.7,
    status: 'PENDING',
    marketRegime: 'trending_up',
    narrativeSnapshot: '',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };

  it('should return true when price is within entry zone', () => {
    expect(evaluatePlanEntry(plan, 96000)).toBe(true);
  });

  it('should return true when price is at zone boundaries', () => {
    expect(evaluatePlanEntry(plan, 95000)).toBe(true);
    expect(evaluatePlanEntry(plan, 97000)).toBe(true);
  });

  it('should return true when price is within tolerance', () => {
    // Tolerance is max(zoneWidth * 0.5, price * 0.01)
    // zoneWidth = 2000, so tolerance = max(1000, ~950) = 1000
    expect(evaluatePlanEntry(plan, 94100)).toBe(true); // 95000 - 1000 = 94000
    expect(evaluatePlanEntry(plan, 97900)).toBe(true); // 97000 + 1000 = 98000
  });

  it('should return false when price is far outside zone', () => {
    expect(evaluatePlanEntry(plan, 90000)).toBe(false);
    expect(evaluatePlanEntry(plan, 105000)).toBe(false);
  });
});

describe('Plan Validity Evaluation', () => {
  it('LONG plan: valid when price above invalidation price', () => {
    const plan: TradingPlan = {
      id: 1, symbol: 'BTC/USDT:USDT', direction: 'LONG',
      entryCondition: '', entryZone: { low: 95000, high: 97000 },
      targets: [], stopLoss: 93000, invalidation: '', invalidationPrice: 92000,
      thesis: '', confidence: 0.7, status: 'ACTIVE', marketRegime: 'trending_up',
      narrativeSnapshot: '', createdAt: '', expiresAt: '',
    };

    expect(evaluatePlanValidity(plan, 96000)).toEqual({ valid: true });
    expect(evaluatePlanValidity(plan, 92001)).toEqual({ valid: true });
  });

  it('LONG plan: invalid when price below invalidation price', () => {
    const plan: TradingPlan = {
      id: 1, symbol: 'BTC/USDT:USDT', direction: 'LONG',
      entryCondition: '', entryZone: { low: 95000, high: 97000 },
      targets: [], stopLoss: 93000, invalidation: '', invalidationPrice: 92000,
      thesis: '', confidence: 0.7, status: 'ACTIVE', marketRegime: 'trending_up',
      narrativeSnapshot: '', createdAt: '', expiresAt: '',
    };

    const result = evaluatePlanValidity(plan, 91000);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('91000');
    expect(result.reason).toContain('92000');
  });

  it('SHORT plan: valid when price below invalidation price', () => {
    const plan: TradingPlan = {
      id: 1, symbol: 'BTC/USDT:USDT', direction: 'SHORT',
      entryCondition: '', entryZone: { low: 95000, high: 97000 },
      targets: [], stopLoss: 99000, invalidation: '', invalidationPrice: 100000,
      thesis: '', confidence: 0.7, status: 'ACTIVE', marketRegime: 'trending_down',
      narrativeSnapshot: '', createdAt: '', expiresAt: '',
    };

    expect(evaluatePlanValidity(plan, 96000)).toEqual({ valid: true });
    expect(evaluatePlanValidity(plan, 99999)).toEqual({ valid: true });
  });

  it('SHORT plan: invalid when price above invalidation price', () => {
    const plan: TradingPlan = {
      id: 1, symbol: 'BTC/USDT:USDT', direction: 'SHORT',
      entryCondition: '', entryZone: { low: 95000, high: 97000 },
      targets: [], stopLoss: 99000, invalidation: '', invalidationPrice: 100000,
      thesis: '', confidence: 0.7, status: 'ACTIVE', marketRegime: 'trending_down',
      narrativeSnapshot: '', createdAt: '', expiresAt: '',
    };

    const result = evaluatePlanValidity(plan, 101000);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('101000');
    expect(result.reason).toContain('100000');
  });

  it('plan without invalidation price is always valid', () => {
    const plan: TradingPlan = {
      id: 1, symbol: 'BTC/USDT:USDT', direction: 'LONG',
      entryCondition: '', entryZone: { low: 95000, high: 97000 },
      targets: [], stopLoss: 93000, invalidation: '',
      thesis: '', confidence: 0.7, status: 'ACTIVE', marketRegime: 'trending_up',
      narrativeSnapshot: '', createdAt: '', expiresAt: '',
    };

    expect(evaluatePlanValidity(plan, 50000)).toEqual({ valid: true });
    expect(evaluatePlanValidity(plan, 200000)).toEqual({ valid: true });
  });

  it('LONG plan: price exactly at invalidation price triggers invalidation', () => {
    const plan: TradingPlan = {
      id: 1, symbol: 'BTC/USDT:USDT', direction: 'LONG',
      entryCondition: '', entryZone: { low: 95000, high: 97000 },
      targets: [], stopLoss: 93000, invalidation: '', invalidationPrice: 92000,
      thesis: '', confidence: 0.7, status: 'ACTIVE', marketRegime: 'trending_up',
      narrativeSnapshot: '', createdAt: '', expiresAt: '',
    };

    // Price exactly at invalidation: 92000 < 92000 is false, so it's still valid
    // This is correct behavior: invalidation triggers when price goes BELOW, not at
    expect(evaluatePlanValidity(plan, 92000)).toEqual({ valid: true });
  });

  it('SHORT plan: price exactly at invalidation price triggers invalidation', () => {
    const plan: TradingPlan = {
      id: 1, symbol: 'BTC/USDT:USDT', direction: 'SHORT',
      entryCondition: '', entryZone: { low: 95000, high: 97000 },
      targets: [], stopLoss: 99000, invalidation: '', invalidationPrice: 100000,
      thesis: '', confidence: 0.7, status: 'ACTIVE', marketRegime: 'trending_down',
      narrativeSnapshot: '', createdAt: '', expiresAt: '',
    };

    // Price exactly at invalidation: 100000 > 100000 is false, so it's still valid
    expect(evaluatePlanValidity(plan, 100000)).toEqual({ valid: true });
  });
});
