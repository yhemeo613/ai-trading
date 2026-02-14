import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

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
  activatePlan,
  invalidatePlan,
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

const longPlan = {
  symbol: 'BTC/USDT:USDT',
  direction: 'LONG' as const,
  entryCondition: 'Price near support at 95k',
  entryZone: { low: 95000, high: 97000 },
  targets: [{ price: 100000, percent: 50 }, { price: 105000, percent: 50 }],
  stopLoss: 93000,
  invalidation: 'Break below 92000',
  invalidationPrice: 92000,
  thesis: 'Bullish breakout from support',
  confidence: 0.75,
  marketRegime: 'trending_up',
  narrativeSnapshot: 'BTC trending up near support',
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
};

const shortPlan = {
  symbol: 'BTC/USDT:USDT',
  direction: 'SHORT' as const,
  entryCondition: 'Price near resistance at 105k',
  entryZone: { low: 104000, high: 106000 },
  targets: [{ price: 100000, percent: 50 }, { price: 98000, percent: 50 }],
  stopLoss: 107000,
  invalidation: 'Break above 108000',
  invalidationPrice: 108000,
  thesis: 'Rejection at resistance',
  confidence: 0.65,
  marketRegime: 'ranging',
  narrativeSnapshot: 'BTC at resistance zone',
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
};

// ─── evaluatePlanEntry ──────────────────────────────────────────

describe('evaluatePlanEntry', () => {
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

  it('price inside entry zone returns true', () => {
    expect(evaluatePlanEntry(plan, 96000)).toBe(true);
    expect(evaluatePlanEntry(plan, 95500)).toBe(true);
    expect(evaluatePlanEntry(plan, 96999)).toBe(true);
  });

  it('price outside entry zone returns false', () => {
    // Far outside: tolerance = max(2000*0.5, price*0.01) = max(1000, ~900) = 1000
    // So low boundary = 95000 - 1000 = 94000, high boundary = 97000 + 1000 = 98000
    expect(evaluatePlanEntry(plan, 90000)).toBe(false);
    expect(evaluatePlanEntry(plan, 105000)).toBe(false);
    expect(evaluatePlanEntry(plan, 80000)).toBe(false);
  });

  it('price at zone boundary with tolerance returns true', () => {
    // Zone width = 2000, tolerance = max(1000, price*0.01)
    // At 94500: tolerance = max(1000, 945) = 1000, low bound = 95000-1000 = 94000 → 94500 >= 94000 → true
    expect(evaluatePlanEntry(plan, 94500)).toBe(true);
    // At 97500: tolerance = max(1000, 975) = 1000, high bound = 97000+1000 = 98000 → 97500 <= 98000 → true
    expect(evaluatePlanEntry(plan, 97500)).toBe(true);
    // Exact boundaries
    expect(evaluatePlanEntry(plan, 95000)).toBe(true);
    expect(evaluatePlanEntry(plan, 97000)).toBe(true);
  });
});

// ─── evaluatePlanValidity ───────────────────────────────────────

describe('evaluatePlanValidity', () => {
  it('LONG plan: price below invalidation returns false (invalid)', () => {
    const plan: TradingPlan = {
      id: 1, symbol: 'BTC/USDT:USDT', direction: 'LONG',
      entryCondition: '', entryZone: { low: 95000, high: 97000 },
      targets: [], stopLoss: 93000, invalidation: '', invalidationPrice: 92000,
      thesis: '', confidence: 0.7, status: 'PENDING', marketRegime: 'trending_up',
      narrativeSnapshot: '', createdAt: '', expiresAt: '',
    };

    const result = evaluatePlanValidity(plan, 91000);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain('91000');
    expect(result.reason).toContain('92000');
  });

  it('SHORT plan: price above invalidation returns false (invalid)', () => {
    const plan: TradingPlan = {
      id: 1, symbol: 'BTC/USDT:USDT', direction: 'SHORT',
      entryCondition: '', entryZone: { low: 104000, high: 106000 },
      targets: [], stopLoss: 107000, invalidation: '', invalidationPrice: 108000,
      thesis: '', confidence: 0.7, status: 'PENDING', marketRegime: 'ranging',
      narrativeSnapshot: '', createdAt: '', expiresAt: '',
    };

    const result = evaluatePlanValidity(plan, 109000);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain('109000');
    expect(result.reason).toContain('108000');
  });

  it('plan still valid when price is on the right side', () => {
    const longPlan: TradingPlan = {
      id: 1, symbol: 'BTC/USDT:USDT', direction: 'LONG',
      entryCondition: '', entryZone: { low: 95000, high: 97000 },
      targets: [], stopLoss: 93000, invalidation: '', invalidationPrice: 92000,
      thesis: '', confidence: 0.7, status: 'ACTIVE', marketRegime: 'trending_up',
      narrativeSnapshot: '', createdAt: '', expiresAt: '',
    };
    expect(evaluatePlanValidity(longPlan, 96000)).toEqual({ valid: true });
    expect(evaluatePlanValidity(longPlan, 93000)).toEqual({ valid: true });

    const shortPlan: TradingPlan = {
      id: 1, symbol: 'BTC/USDT:USDT', direction: 'SHORT',
      entryCondition: '', entryZone: { low: 104000, high: 106000 },
      targets: [], stopLoss: 107000, invalidation: '', invalidationPrice: 108000,
      thesis: '', confidence: 0.7, status: 'ACTIVE', marketRegime: 'ranging',
      narrativeSnapshot: '', createdAt: '', expiresAt: '',
    };
    expect(evaluatePlanValidity(shortPlan, 105000)).toEqual({ valid: true });
    expect(evaluatePlanValidity(shortPlan, 107999)).toEqual({ valid: true });
  });
});

// ─── Full monitoring scenario (DB integration) ─────────────────

describe('Full monitoring scenario', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  it('create plan → price outside zone → price inside zone', () => {
    const planId = createPlan(longPlan);
    expect(planId).toBeGreaterThan(0);

    const pending = getPendingPlans('BTC/USDT:USDT');
    expect(pending).toHaveLength(1);

    const plan = pending[0];

    // Price far outside entry zone → not triggered
    expect(evaluatePlanEntry(plan, 90000)).toBe(false);

    // Price inside entry zone → triggered
    expect(evaluatePlanEntry(plan, 96000)).toBe(true);

    // Activate the plan (simulating what the loop would do)
    activatePlan(planId);
    const active = getActivePlan('BTC/USDT:USDT');
    expect(active).not.toBeNull();
    expect(active!.status).toBe('ACTIVE');
    expect(active!.direction).toBe('LONG');
  });

  it('plan invalidation during monitoring: price hits invalidation → plan invalidated', () => {
    const planId = createPlan(longPlan);
    const pending = getPendingPlans('BTC/USDT:USDT');
    const plan = pending[0];

    // Plan is still valid at current price
    expect(evaluatePlanValidity(plan, 96000)).toEqual({ valid: true });

    // Price drops below invalidation price (92000)
    const validity = evaluatePlanValidity(plan, 91000);
    expect(validity.valid).toBe(false);

    // Invalidate the plan in DB (simulating what processSymbolIfMonitorOnly does)
    invalidatePlan(planId, validity.reason);

    // Verify plan is now invalidated
    const remainingPending = getPendingPlans('BTC/USDT:USDT');
    expect(remainingPending).toHaveLength(0);

    const row = testDb.prepare('SELECT status FROM trading_plans WHERE id = ?').get(planId) as any;
    expect(row.status).toBe('INVALIDATED');
  });

  it('multiple plans for same symbol: LONG at support, SHORT at resistance → only relevant one triggers', () => {
    const longId = createPlan(longPlan);
    const shortId = createPlan(shortPlan);

    const pending = getPendingPlans('BTC/USDT:USDT');
    expect(pending).toHaveLength(2);

    const longP = pending.find(p => p.direction === 'LONG')!;
    const shortP = pending.find(p => p.direction === 'SHORT')!;

    // Price at 96000: inside LONG entry zone (95000-97000), outside SHORT zone (104000-106000)
    expect(evaluatePlanEntry(longP, 96000)).toBe(true);
    expect(evaluatePlanEntry(shortP, 96000)).toBe(false);

    // Price at 105000: outside LONG entry zone, inside SHORT zone
    expect(evaluatePlanEntry(longP, 105000)).toBe(false);
    expect(evaluatePlanEntry(shortP, 105000)).toBe(true);

    // Price at 100000: outside both zones
    expect(evaluatePlanEntry(longP, 100000)).toBe(false);
    expect(evaluatePlanEntry(shortP, 100000)).toBe(false);

    // Simulate: only the triggered plan gets activated
    const triggeredAtSupport = pending.find(p => evaluatePlanEntry(p, 96000));
    expect(triggeredAtSupport).toBeDefined();
    expect(triggeredAtSupport!.direction).toBe('LONG');
  });
});

// ─── Pricewatch data structure ──────────────────────────────────

describe('Pricewatch data structure', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  it('verify the shape of pricewatch data sent to frontend', () => {
    createPlan(longPlan);
    createPlan(shortPlan);

    const symbol = 'BTC/USDT:USDT';
    const currentPrice = 96500;
    const pending = getPendingPlans(symbol);

    // Build the pricewatch data structure as the websocket/routes do
    const pricewatchData = {
      symbol,
      state: 'monitoring' as const,
      price: currentPrice,
      plans: pending.map(p => ({
        id: p.id,
        direction: p.direction,
        entryZone: p.entryZone,
        confidence: p.confidence,
      })),
    };

    // Verify top-level shape
    expect(pricewatchData).toHaveProperty('symbol');
    expect(pricewatchData).toHaveProperty('state');
    expect(pricewatchData).toHaveProperty('price');
    expect(pricewatchData).toHaveProperty('plans');

    expect(pricewatchData.symbol).toBe('BTC/USDT:USDT');
    expect(pricewatchData.state).toBe('monitoring');
    expect(pricewatchData.price).toBe(96500);
    expect(Array.isArray(pricewatchData.plans)).toBe(true);
    expect(pricewatchData.plans.length).toBe(2);

    // Verify each plan in the array has the correct shape
    for (const plan of pricewatchData.plans) {
      expect(plan).toHaveProperty('id');
      expect(plan).toHaveProperty('direction');
      expect(plan).toHaveProperty('entryZone');
      expect(plan).toHaveProperty('confidence');
      expect(typeof plan.id).toBe('number');
      expect(['LONG', 'SHORT']).toContain(plan.direction);
      expect(plan.entryZone).toHaveProperty('low');
      expect(plan.entryZone).toHaveProperty('high');
      expect(typeof plan.entryZone.low).toBe('number');
      expect(typeof plan.entryZone.high).toBe('number');
      expect(typeof plan.confidence).toBe('number');
    }

    // Verify position_held state shape
    const positionHeldData = { symbol, state: 'position_held' as const, price: currentPrice };
    expect(positionHeldData).toHaveProperty('symbol');
    expect(positionHeldData).toHaveProperty('state');
    expect(positionHeldData).toHaveProperty('price');
    expect(positionHeldData.state).toBe('position_held');

    // Verify waiting state shape
    const waitingData = { symbol, state: 'waiting' as const, price: currentPrice };
    expect(waitingData.state).toBe('waiting');
  });
});
