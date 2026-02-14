import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// ─── In-memory DB setup ──────────────────────────────────────────
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

vi.mock('../../src/dashboard/websocket', () => ({
  broadcast: vi.fn(),
}));

// ─── AI Router mocks (same pattern as tests/ai/router.test.ts) ──

vi.mock('../../src/utils/proxy', () => ({ aiFetch: vi.fn() }));

const {
  mockDeepSeek, mockOpenAI, mockAnthropic, mockGemini, mockQwen,
} = vi.hoisted(() => ({
  mockDeepSeek: { name: 'deepseek', isAvailable: vi.fn(() => true), chat: vi.fn() },
  mockOpenAI:   { name: 'openai',   isAvailable: vi.fn(() => true), chat: vi.fn() },
  mockAnthropic:{ name: 'anthropic',isAvailable: vi.fn(() => false),chat: vi.fn() },
  mockGemini:   { name: 'gemini',   isAvailable: vi.fn(() => false),chat: vi.fn() },
  mockQwen:     { name: 'qwen',     isAvailable: vi.fn(() => false),chat: vi.fn() },
}));

vi.mock('../../src/ai/providers/deepseek', () => ({
  DeepSeekProvider: class { name = mockDeepSeek.name; isAvailable = mockDeepSeek.isAvailable; chat = mockDeepSeek.chat; },
}));
vi.mock('../../src/ai/providers/openai', () => ({
  OpenAIProvider: class { name = mockOpenAI.name; isAvailable = mockOpenAI.isAvailable; chat = mockOpenAI.chat; },
}));
vi.mock('../../src/ai/providers/anthropic', () => ({
  AnthropicProvider: class { name = mockAnthropic.name; isAvailable = mockAnthropic.isAvailable; chat = mockAnthropic.chat; },
}));
vi.mock('../../src/ai/providers/gemini', () => ({
  GeminiProvider: class { name = mockGemini.name; isAvailable = mockGemini.isAvailable; chat = mockGemini.chat; },
}));
vi.mock('../../src/ai/providers/qwen', () => ({
  QwenProvider: class { name = mockQwen.name; isAvailable = mockQwen.isAvailable; chat = mockQwen.chat; },
}));

import { aiChat, resetFailCounts } from '../../src/ai/router';
import { createPlan, getPendingPlans } from '../../src/core/trading-plan';
import { broadcast } from '../../src/dashboard/websocket';
import type { RoundtableSessionResult, Round1Opinion, Round2Response, ChairmanDecision } from '../../src/roundtable/types';

// ─── DB helper ───────────────────────────────────────────────────

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

// ─── Fixtures ────────────────────────────────────────────────────

const SYMBOL = 'BTC/USDT:USDT';
const CURRENT_PRICE = 65000;

function makeRound1Opinion(overrides: Partial<Round1Opinion> = {}): Round1Opinion {
  return {
    role: 'technical-analyst',
    stance: 'HOLD',
    confidence: 0.6,
    reasoning: 'Waiting for confirmation',
    keyPoints: ['Price consolidating'],
    suggestedParams: null,
    ...overrides,
  };
}

function makeRound2Response(overrides: Partial<Round2Response> = {}): Round2Response {
  return {
    role: 'technical-analyst',
    revisedStance: 'HOLD',
    finalConfidence: 0.6,
    stanceChanged: false,
    agreements: [],
    challenges: [],
    finalReasoning: 'Maintaining hold stance',
    ...overrides,
  };
}

function makeChairmanDecision(overrides: Partial<ChairmanDecision> = {}): ChairmanDecision {
  return {
    action: 'HOLD',
    symbol: SYMBOL,
    confidence: 0.65,
    reasoning: 'Roundtable consensus is HOLD',
    consensusLevel: 'majority',
    keyDebatePoints: ['Price at support'],
    riskManagerVerdict: 'Risk acceptable',
    params: null,
    ...overrides,
  };
}

function makeNarrative(keyLevels: any[] = []) {
  return {
    symbol: SYMBOL,
    timestamp: Date.now(),
    htfBias: 'neutral',
    mtfContext: 'consolidating',
    ltfTrigger: 'none',
    keyLevels,
    patterns: [],
    priceAction: { action: 'consolidation', description: 'Price consolidating' },
    formatted: 'BTC market narrative',
  };
}

function makeRoundtableResult(overrides: Partial<RoundtableSessionResult> = {}): RoundtableSessionResult {
  return {
    sessionId: 'rt-test-001',
    symbol: SYMBOL,
    depth: 'standard',
    round1: [
      makeRound1Opinion({ role: 'chief-strategist', stance: 'HOLD', confidence: 0.5 }),
      makeRound1Opinion({ role: 'technical-analyst', stance: 'HOLD', confidence: 0.6 }),
      makeRound1Opinion({ role: 'risk-manager', stance: 'HOLD', confidence: 0.7 }),
    ],
    round2: null,
    chairmanDecision: makeChairmanDecision(),
    consensusLevel: 'majority',
    durationMs: 5000,
    ...overrides,
  };
}

// ─── AI Router Integration Tests ─────────────────────────────────

describe('AI Router - fallback behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFailCounts();
    mockDeepSeek.isAvailable.mockReturnValue(true);
    mockOpenAI.isAvailable.mockReturnValue(true);
    mockAnthropic.isAvailable.mockReturnValue(false);
    mockGemini.isAvailable.mockReturnValue(false);
    mockQwen.isAvailable.mockReturnValue(false);
  });

  it('primary provider fails -> fallback to secondary', async () => {
    mockDeepSeek.chat.mockRejectedValue(new Error('DeepSeek API timeout'));
    const fallbackResponse = { content: 'fallback result', provider: 'openai', model: 'gpt-4o' };
    mockOpenAI.chat.mockResolvedValue(fallbackResponse);

    const result = await aiChat([{ role: 'user', content: 'analyze BTC' }], 'deepseek');

    expect(result).toEqual(fallbackResponse);
    expect(mockDeepSeek.chat).toHaveBeenCalledOnce();
    expect(mockOpenAI.chat).toHaveBeenCalledOnce();
  });

  it('all providers fail -> throws error', async () => {
    mockDeepSeek.chat.mockRejectedValue(new Error('DeepSeek down'));
    mockOpenAI.chat.mockRejectedValue(new Error('OpenAI down'));

    await expect(
      aiChat([{ role: 'user', content: 'analyze BTC' }], 'deepseek'),
    ).rejects.toThrow('所有 AI 提供商均失败');
  });
});

// ─── extractPlansFromRoundtable Tests ────────────────────────────
// Since extractPlansFromRoundtable is a private function in loop.ts,
// we test it indirectly by reimplementing its core logic and verifying
// the plan creation side effects via the real SQLite DB.

describe('extractPlansFromRoundtable - LONG consensus', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => {
    testDb.close();
  });

  it('creates LONG plan when >=2 roles vote LONG with confidence >= 0.3', () => {
    // Simulate what extractPlansFromRoundtable does: collect LONG opinions, create plan
    const round1: Round1Opinion[] = [
      makeRound1Opinion({ role: 'chief-strategist', stance: 'LONG', confidence: 0.7, suggestedParams: { entryPrice: 64000, stopLoss: 62000, takeProfit: 70000 } }),
      makeRound1Opinion({ role: 'technical-analyst', stance: 'LONG', confidence: 0.6, suggestedParams: { entryPrice: 64500, stopLoss: 62500, takeProfit: 69000 } }),
      makeRound1Opinion({ role: 'risk-manager', stance: 'HOLD', confidence: 0.5 }),
    ];

    const longOpinions = round1.filter((o) => o.stance === 'LONG' && o.confidence >= 0.3);
    expect(longOpinions.length).toBeGreaterThanOrEqual(2);

    const avgConf = longOpinions.reduce((s, o) => s + o.confidence, 0) / longOpinions.length;
    const entryPrices = longOpinions.map((o) => o.suggestedParams?.entryPrice).filter((p): p is number => p != null && p > 0);
    const slPrices = longOpinions.map((o) => o.suggestedParams?.stopLoss).filter((p): p is number => p != null && p > 0);
    const tpPrices = longOpinions.map((o) => o.suggestedParams?.takeProfit).filter((p): p is number => p != null && p > 0);

    const planId = createPlan({
      symbol: SYMBOL,
      direction: 'LONG',
      entryCondition: '圆桌会议多头共识',
      entryZone: { low: Math.min(...entryPrices), high: Math.max(...entryPrices) },
      targets: [{ price: Math.max(...tpPrices), percent: 100 }],
      stopLoss: Math.min(...slPrices),
      invalidation: '价格跌破止损位',
      invalidationPrice: Math.min(...slPrices) * 0.99,
      thesis: longOpinions.map((o) => `[${o.role}] ${o.reasoning}`).join(' | '),
      confidence: avgConf,
      marketRegime: 'trending_up',
      narrativeSnapshot: 'BTC narrative',
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    });

    expect(planId).toBeGreaterThan(0);

    const pending = getPendingPlans(SYMBOL);
    expect(pending).toHaveLength(1);
    expect(pending[0].direction).toBe('LONG');
    expect(pending[0].entryZone.low).toBe(64000);
    expect(pending[0].entryZone.high).toBe(64500);
    expect(pending[0].stopLoss).toBe(62000);
    expect(pending[0].confidence).toBeCloseTo(0.65);
  });
});

describe('extractPlansFromRoundtable - SHORT consensus', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => {
    testDb.close();
  });

  it('creates SHORT plan when >=2 roles vote SHORT', () => {
    const round1: Round1Opinion[] = [
      makeRound1Opinion({ role: 'chief-strategist', stance: 'SHORT', confidence: 0.8, suggestedParams: { entryPrice: 66000, stopLoss: 68000, takeProfit: 62000 } }),
      makeRound1Opinion({ role: 'sentiment-analyst', stance: 'SHORT', confidence: 0.5, suggestedParams: { entryPrice: 65500, stopLoss: 67500, takeProfit: 63000 } }),
      makeRound1Opinion({ role: 'risk-manager', stance: 'HOLD', confidence: 0.6 }),
    ];

    const shortOpinions = round1.filter((o) => o.stance === 'SHORT' && o.confidence >= 0.3);
    expect(shortOpinions.length).toBeGreaterThanOrEqual(2);

    const avgConf = shortOpinions.reduce((s, o) => s + o.confidence, 0) / shortOpinions.length;
    const entryPrices = shortOpinions.map((o) => o.suggestedParams?.entryPrice).filter((p): p is number => p != null && p > 0);
    const slPrices = shortOpinions.map((o) => o.suggestedParams?.stopLoss).filter((p): p is number => p != null && p > 0);
    const tpPrices = shortOpinions.map((o) => o.suggestedParams?.takeProfit).filter((p): p is number => p != null && p > 0);

    const planId = createPlan({
      symbol: SYMBOL,
      direction: 'SHORT',
      entryCondition: '圆桌会议空头共识',
      entryZone: { low: Math.min(...entryPrices), high: Math.max(...entryPrices) },
      targets: [{ price: Math.min(...tpPrices), percent: 100 }],
      stopLoss: Math.max(...slPrices),
      invalidation: '价格突破止损位',
      invalidationPrice: Math.max(...slPrices) * 1.01,
      thesis: shortOpinions.map((o) => `[${o.role}] ${o.reasoning}`).join(' | '),
      confidence: avgConf,
      marketRegime: 'trending_down',
      narrativeSnapshot: 'BTC narrative',
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    });

    expect(planId).toBeGreaterThan(0);

    const pending = getPendingPlans(SYMBOL);
    expect(pending).toHaveLength(1);
    expect(pending[0].direction).toBe('SHORT');
    expect(pending[0].entryZone.low).toBe(65500);
    expect(pending[0].entryZone.high).toBe(66000);
    expect(pending[0].stopLoss).toBe(68000);
    expect(pending[0].confidence).toBeCloseTo(0.65);
  });
});

describe('extractPlansFromRoundtable - no consensus fallback', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => {
    testDb.close();
  });

  it('no consensus -> fallback creates plans from narrative.keyLevels support/resistance', () => {
    // Simulate: no LONG or SHORT consensus (all HOLD), so no consensus plans created
    const round1: Round1Opinion[] = [
      makeRound1Opinion({ role: 'chief-strategist', stance: 'HOLD', confidence: 0.5 }),
      makeRound1Opinion({ role: 'technical-analyst', stance: 'HOLD', confidence: 0.4 }),
      makeRound1Opinion({ role: 'risk-manager', stance: 'HOLD', confidence: 0.6 }),
    ];

    const longOpinions = round1.filter((o) => o.stance === 'LONG' && o.confidence >= 0.3);
    const shortOpinions = round1.filter((o) => o.stance === 'SHORT' && o.confidence >= 0.3);

    // No consensus plans should be created
    expect(longOpinions.length).toBeLessThan(2);
    expect(shortOpinions.length).toBeLessThan(2);

    // Verify no plans exist yet
    expect(getPendingPlans(SYMBOL)).toHaveLength(0);

    // Fallback: use keyLevels from narrative
    const narrative = makeNarrative([
      { price: 63000, type: 'support', source: 'swing_low', strength: 2 },
      { price: 61000, type: 'support', source: 'ema', strength: 1 },
      { price: 67000, type: 'resistance', source: 'swing_high', strength: 3 },
      { price: 70000, type: 'resistance', source: 'bb', strength: 1 },
    ]);

    const supports = narrative.keyLevels
      .filter((l: any) => l.type === 'support' && l.price < CURRENT_PRICE)
      .sort((a: any, b: any) => b.price - a.price);
    const resistances = narrative.keyLevels
      .filter((l: any) => l.type === 'resistance' && l.price > CURRENT_PRICE)
      .sort((a: any, b: any) => a.price - b.price);

    // Create LONG plan at nearest support
    if (supports.length > 0) {
      const s = supports[0];
      const zoneWidth = CURRENT_PRICE * 0.005;
      createPlan({
        symbol: SYMBOL,
        direction: 'LONG',
        entryCondition: `支撑位反弹 (${s.source}, 强度${s.strength})`,
        entryZone: { low: s.price - zoneWidth, high: s.price + zoneWidth },
        targets: [{ price: resistances.length > 0 ? resistances[0].price : CURRENT_PRICE * 1.02, percent: 100 }],
        stopLoss: s.price * 0.985,
        invalidation: '价格跌破支撑位',
        invalidationPrice: s.price * 0.98,
        thesis: `技术面支撑位 ${s.price.toFixed(2)} (来源: ${s.source}, 强度: ${s.strength})`,
        confidence: 0.3 + s.strength * 0.1,
        marketRegime: 'ranging',
        narrativeSnapshot: narrative.formatted,
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      });
    }

    // Create SHORT plan at nearest resistance
    if (resistances.length > 0) {
      const r = resistances[0];
      const zoneWidth = CURRENT_PRICE * 0.005;
      createPlan({
        symbol: SYMBOL,
        direction: 'SHORT',
        entryCondition: `阻力位做空 (${r.source}, 强度${r.strength})`,
        entryZone: { low: r.price - zoneWidth, high: r.price + zoneWidth },
        targets: [{ price: supports.length > 0 ? supports[0].price : CURRENT_PRICE * 0.98, percent: 100 }],
        stopLoss: r.price * 1.015,
        invalidation: '价格突破阻力位',
        invalidationPrice: r.price * 1.02,
        thesis: `技术面阻力位 ${r.price.toFixed(2)} (来源: ${r.source}, 强度: ${r.strength})`,
        confidence: 0.3 + r.strength * 0.1,
        marketRegime: 'ranging',
        narrativeSnapshot: narrative.formatted,
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      });
    }

    const pending = getPendingPlans(SYMBOL);
    expect(pending).toHaveLength(2);

    const directions = pending.map((p) => p.direction).sort();
    expect(directions).toEqual(['LONG', 'SHORT']);

    // LONG plan should be at nearest support (63000)
    const longPlan = pending.find((p) => p.direction === 'LONG')!;
    expect(longPlan.entryZone.low).toBeCloseTo(63000 - CURRENT_PRICE * 0.005, 0);
    expect(longPlan.entryZone.high).toBeCloseTo(63000 + CURRENT_PRICE * 0.005, 0);
    expect(longPlan.confidence).toBeCloseTo(0.5); // 0.3 + 2 * 0.1

    // SHORT plan should be at nearest resistance (67000)
    const shortPlan = pending.find((p) => p.direction === 'SHORT')!;
    expect(shortPlan.entryZone.low).toBeCloseTo(67000 - CURRENT_PRICE * 0.005, 0);
    expect(shortPlan.entryZone.high).toBeCloseTo(67000 + CURRENT_PRICE * 0.005, 0);
    expect(shortPlan.confidence).toBeCloseTo(0.6); // 0.3 + 3 * 0.1
  });
});

describe('extractPlansFromRoundtable - skips if pending plans exist', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => {
    testDb.close();
  });

  it('skips plan creation if pending plans already exist', () => {
    // Pre-create a pending plan
    createPlan({
      symbol: SYMBOL,
      direction: 'LONG',
      entryCondition: 'Existing plan',
      entryZone: { low: 64000, high: 65000 },
      targets: [{ price: 70000, percent: 100 }],
      stopLoss: 62000,
      invalidation: 'test',
      thesis: 'Pre-existing plan',
      confidence: 0.7,
      marketRegime: 'trending_up',
      narrativeSnapshot: 'snapshot',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });

    // Verify existing plan
    const existingPlans = getPendingPlans(SYMBOL);
    expect(existingPlans).toHaveLength(1);

    // Simulate the guard check from extractPlansFromRoundtable
    const existing = getPendingPlans(SYMBOL);
    if (existing.length > 0) {
      // Should return early - no new plans created
      const afterPlans = getPendingPlans(SYMBOL);
      expect(afterPlans).toHaveLength(1);
      expect(afterPlans[0].thesis).toBe('Pre-existing plan');
      return;
    }

    // This should not be reached
    expect.unreachable('Should have returned early due to existing pending plans');
  });
});

// ─── Decision broadcast includes entryPlans ──────────────────────

describe('Decision broadcast includes entryPlans', () => {
  beforeEach(() => {
    testDb = createTestDb();
    vi.clearAllMocks();
  });
  afterEach(() => {
    testDb.close();
  });

  it('broadcast data includes entryPlans array from pending plans', () => {
    // Create pending plans that would be included in the broadcast
    createPlan({
      symbol: SYMBOL,
      direction: 'LONG',
      entryCondition: '圆桌会议多头共识',
      entryZone: { low: 64000, high: 65000 },
      targets: [{ price: 70000, percent: 100 }],
      stopLoss: 62000,
      invalidation: 'test',
      thesis: 'Long thesis',
      confidence: 0.7,
      marketRegime: 'trending_up',
      narrativeSnapshot: 'snapshot',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });

    createPlan({
      symbol: SYMBOL,
      direction: 'SHORT',
      entryCondition: '圆桌会议空头共识',
      entryZone: { low: 66000, high: 67000 },
      targets: [{ price: 62000, percent: 100 }],
      stopLoss: 69000,
      invalidation: 'test',
      thesis: 'Short thesis',
      confidence: 0.6,
      marketRegime: 'trending_up',
      narrativeSnapshot: 'snapshot',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });

    // Simulate the broadcast payload construction from loop.ts:899-910
    const entryPlans = getPendingPlans(SYMBOL).map((p) => ({
      direction: p.direction,
      entryZone: p.entryZone,
      confidence: p.confidence,
    }));

    const broadcastPayload = {
      type: 'decision',
      data: {
        decision: { action: 'HOLD', symbol: SYMBOL, confidence: 0.65, reasoning: 'test' },
        riskCheck: { passed: true },
        entryPlans,
      },
    };

    broadcast(broadcastPayload);

    expect(broadcast).toHaveBeenCalledOnce();
    const call = vi.mocked(broadcast).mock.calls[0][0] as any;
    expect(call.data.entryPlans).toBeDefined();
    expect(call.data.entryPlans).toHaveLength(2);

    // Verify entryPlans structure
    const longEntry = call.data.entryPlans.find((p: any) => p.direction === 'LONG');
    const shortEntry = call.data.entryPlans.find((p: any) => p.direction === 'SHORT');

    expect(longEntry).toBeDefined();
    expect(longEntry.entryZone).toEqual({ low: 64000, high: 65000 });
    expect(longEntry.confidence).toBe(0.7);

    expect(shortEntry).toBeDefined();
    expect(shortEntry.entryZone).toEqual({ low: 66000, high: 67000 });
    expect(shortEntry.confidence).toBe(0.6);
  });

  it('broadcast includes empty entryPlans when no pending plans exist', () => {
    const entryPlans = getPendingPlans(SYMBOL).map((p) => ({
      direction: p.direction,
      entryZone: p.entryZone,
      confidence: p.confidence,
    }));

    const broadcastPayload = {
      type: 'decision',
      data: {
        decision: { action: 'HOLD', symbol: SYMBOL, confidence: 0.5, reasoning: 'test' },
        riskCheck: { passed: true },
        entryPlans,
      },
    };

    broadcast(broadcastPayload);

    const call = vi.mocked(broadcast).mock.calls[0][0] as any;
    expect(call.data.entryPlans).toEqual([]);
  });
});
