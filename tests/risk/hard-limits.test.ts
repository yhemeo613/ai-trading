import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockBalance, createMockPosition, createMockDecision } from '../helpers/mocks';

// Controllable DB mock — lets each test configure what the DB returns
const mockDbGet = vi.fn().mockReturnValue(undefined);

vi.mock('../../src/persistence/db', () => ({
  getDb: () => ({
    prepare: () => ({ get: mockDbGet }),
  }),
}));

vi.mock('../../src/config', () => ({
  config: {
    testnetOnly: true,
    risk: {
      maxPositionPct: 10,
      maxTotalExposurePct: 30,
      maxLeverage: 10,
      maxDailyLossPct: 5,
      maxConcurrentPositions: 5,
    },
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { checkHardLimits } from '../../src/risk/hard-limits';

describe('checkHardLimits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbGet.mockReturnValue(undefined);
  });

  // ─── HOLD / CLOSE always pass ─────────────────────────────────
  describe('HOLD and CLOSE bypass all checks', () => {
    it('passes HOLD even with zero balance', () => {
      const result = checkHardLimits(
        createMockDecision({ action: 'HOLD' }),
        createMockBalance({ availableBalance: 0, totalBalance: 0 }),
        []
      );
      expect(result.passed).toBe(true);
    });

    it('passes CLOSE even with zero balance', () => {
      const result = checkHardLimits(
        createMockDecision({ action: 'CLOSE' }),
        createMockBalance({ availableBalance: 0, totalBalance: 0 }),
        []
      );
      expect(result.passed).toBe(true);
    });
  });

  // ─── LONG / SHORT require params ──────────────────────────────
  describe('LONG/SHORT require params', () => {
    it('rejects LONG without params', () => {
      const result = checkHardLimits(
        createMockDecision({ action: 'LONG', params: null }),
        createMockBalance(),
        []
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('参数');
    });

    it('rejects SHORT without params', () => {
      const result = checkHardLimits(
        createMockDecision({ action: 'SHORT', params: null }),
        createMockBalance(),
        []
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('参数');
    });
  });

  // ─── Leverage limits ──────────────────────────────────────────
  describe('leverage limits', () => {
    it('rejects leverage exceeding maxLeverage (10x)', () => {
      const result = checkHardLimits(
        createMockDecision({ action: 'LONG', params: { leverage: 20, positionSizePercent: 5 } }),
        createMockBalance(),
        []
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('杠杆');
      expect(result.reason).toContain('20x');
    });

    it('passes leverage at exactly maxLeverage (10x)', () => {
      const result = checkHardLimits(
        createMockDecision({ action: 'LONG', params: { leverage: 10, positionSizePercent: 2 } }),
        createMockBalance(),
        []
      );
      expect(result.passed).toBe(true);
    });

    it('passes leverage below maxLeverage', () => {
      const result = checkHardLimits(
        createMockDecision({ action: 'LONG', params: { leverage: 3, positionSizePercent: 2 } }),
        createMockBalance(),
        []
      );
      expect(result.passed).toBe(true);
    });

    it('rejects leverage of 11x (just over limit)', () => {
      const result = checkHardLimits(
        createMockDecision({ action: 'LONG', params: { leverage: 11, positionSizePercent: 5 } }),
        createMockBalance(),
        []
      );
      expect(result.passed).toBe(false);
    });
  });

  // ─── Position size limits ─────────────────────────────────────
  describe('position size limits', () => {
    it('rejects positionSizePercent exceeding maxPositionPct (10%)', () => {
      const result = checkHardLimits(
        createMockDecision({ action: 'LONG', params: { positionSizePercent: 15, leverage: 5 } }),
        createMockBalance(),
        []
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('仓位占比');
      expect(result.reason).toContain('15%');
    });

    it('passes positionSizePercent at exactly maxPositionPct (10%)', () => {
      const result = checkHardLimits(
        createMockDecision({ action: 'LONG', params: { positionSizePercent: 10, leverage: 1 } }),
        createMockBalance(),
        []
      );
      expect(result.passed).toBe(true);
    });

    it('passes positionSizePercent below maxPositionPct', () => {
      const result = checkHardLimits(
        createMockDecision({ action: 'LONG', params: { positionSizePercent: 5, leverage: 1 } }),
        createMockBalance(),
        []
      );
      expect(result.passed).toBe(true);
    });
  });

  // ─── ADD restrictions ─────────────────────────────────────────
  describe('ADD restrictions', () => {
    it('rejects ADD when no position exists for symbol', () => {
      const result = checkHardLimits(
        createMockDecision({ action: 'ADD' }),
        createMockBalance(),
        []
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('加仓');
      expect(result.reason).toContain('无持仓');
    });

    it('rejects ADD when add_count is exactly 2 (max)', () => {
      mockDbGet.mockReturnValue({ add_count: 2, amount: 0.01 });
      const result = checkHardLimits(
        createMockDecision({ action: 'ADD' }),
        createMockBalance(),
        [createMockPosition({ percentage: 5.0 })]
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('最大加仓次数');
    });

    it('rejects ADD when add_count exceeds 2', () => {
      mockDbGet.mockReturnValue({ add_count: 5, amount: 0.01 });
      const result = checkHardLimits(
        createMockDecision({ action: 'ADD' }),
        createMockBalance(),
        [createMockPosition({ percentage: 5.0 })]
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('最大加仓次数');
    });

    it('rejects ADD when profitability is below 1.5%', () => {
      mockDbGet.mockReturnValue({ add_count: 0, amount: 0.01 });
      const result = checkHardLimits(
        createMockDecision({ action: 'ADD' }),
        createMockBalance(),
        [createMockPosition({ percentage: 1.0 })]
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('不足1.5%');
    });

    it('rejects ADD when profitability is exactly 1.49%', () => {
      mockDbGet.mockReturnValue({ add_count: 0, amount: 0.01 });
      const result = checkHardLimits(
        createMockDecision({ action: 'ADD' }),
        createMockBalance(),
        [createMockPosition({ percentage: 1.49 })]
      );
      expect(result.passed).toBe(false);
    });

    it('rejects ADD when profitability is negative', () => {
      mockDbGet.mockReturnValue({ add_count: 0, amount: 0.01 });
      const result = checkHardLimits(
        createMockDecision({ action: 'ADD' }),
        createMockBalance(),
        [createMockPosition({ percentage: -3.0 })]
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('不足1.5%');
    });

    it('rejects ADD when profitability is exactly 0%', () => {
      mockDbGet.mockReturnValue({ add_count: 0, amount: 0.01 });
      const result = checkHardLimits(
        createMockDecision({ action: 'ADD' }),
        createMockBalance(),
        [createMockPosition({ percentage: 0 })]
      );
      expect(result.passed).toBe(false);
    });

    it('passes ADD when profitable >= 1.5% and add_count < 2', () => {
      mockDbGet.mockReturnValue({ add_count: 1, amount: 0.01 });
      const result = checkHardLimits(
        createMockDecision({ action: 'ADD' }),
        createMockBalance(),
        [createMockPosition({ percentage: 3.0 })]
      );
      expect(result.passed).toBe(true);
    });

    it('passes ADD at exactly 1.5% profitability', () => {
      mockDbGet.mockReturnValue({ add_count: 0, amount: 0.01 });
      const result = checkHardLimits(
        createMockDecision({ action: 'ADD' }),
        createMockBalance(),
        [createMockPosition({ percentage: 1.5 })]
      );
      // 1.5 < 1.5 is false, so this should pass
      expect(result.passed).toBe(true);
    });

    it('rejects ADD when total position would exceed 2.5x initial amount', () => {
      // initial amount = 1, contracts = 2, addPct = 100 => addAmount = 2, total = 4 > 2.5
      mockDbGet.mockReturnValue({ add_count: 0, amount: 1 });
      const result = checkHardLimits(
        createMockDecision({ action: 'ADD', params: { addPercent: 100 } }),
        createMockBalance(),
        [createMockPosition({ contracts: 2, percentage: 5.0 })]
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('超过初始2.5倍');
    });

    it('passes ADD when total position stays within 2.5x initial', () => {
      // initial amount = 2, contracts = 2, addPct = 50 => addAmount = 1, total = 3, max = 5
      mockDbGet.mockReturnValue({ add_count: 0, amount: 2 });
      const result = checkHardLimits(
        createMockDecision({ action: 'ADD', params: { addPercent: 50 } }),
        createMockBalance(),
        [createMockPosition({ contracts: 2, percentage: 5.0 })]
      );
      expect(result.passed).toBe(true);
    });

    it('uses default addPercent of 50 when params is null', () => {
      // initial = 1, contracts = 2, addPct = 50 => addAmount = 1, total = 3, max = 2.5 => fail
      mockDbGet.mockReturnValue({ add_count: 0, amount: 1 });
      const result = checkHardLimits(
        createMockDecision({ action: 'ADD', params: null }),
        createMockBalance(),
        [createMockPosition({ contracts: 2, percentage: 5.0 })]
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('超过初始2.5倍');
    });

    it('passes ADD when no DB record exists (first add)', () => {
      mockDbGet.mockReturnValue(undefined);
      const result = checkHardLimits(
        createMockDecision({ action: 'ADD' }),
        createMockBalance(),
        [createMockPosition({ percentage: 5.0 })]
      );
      // No dbPos => add_count check skipped, profitability passes, 2.5x check skipped
      expect(result.passed).toBe(true);
    });

    it('skips 2.5x check when dbPos.amount is 0', () => {
      mockDbGet.mockReturnValue({ add_count: 0, amount: 0 });
      const result = checkHardLimits(
        createMockDecision({ action: 'ADD' }),
        createMockBalance(),
        [createMockPosition({ percentage: 5.0 })]
      );
      // amount is 0, so the `dbPos.amount > 0` guard skips the 2.5x check
      expect(result.passed).toBe(true);
    });
  });

  // ─── REDUCE restrictions ──────────────────────────────────────
  describe('REDUCE restrictions', () => {
    it('rejects REDUCE when no position exists', () => {
      const result = checkHardLimits(
        createMockDecision({ action: 'REDUCE' }),
        createMockBalance(),
        []
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('减仓');
      expect(result.reason).toContain('无持仓');
    });

    it('rejects REDUCE when reduce_count is exactly 3 (max)', () => {
      mockDbGet.mockReturnValue({ reduce_count: 3 });
      const result = checkHardLimits(
        createMockDecision({ action: 'REDUCE' }),
        createMockBalance(),
        [createMockPosition()]
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('最大做T次数');
    });

    it('rejects REDUCE when reduce_count exceeds 3', () => {
      mockDbGet.mockReturnValue({ reduce_count: 10 });
      const result = checkHardLimits(
        createMockDecision({ action: 'REDUCE' }),
        createMockBalance(),
        [createMockPosition()]
      );
      expect(result.passed).toBe(false);
    });

    it('passes REDUCE when reduce_count is 2 (below max)', () => {
      mockDbGet.mockReturnValue({ reduce_count: 2 });
      const result = checkHardLimits(
        createMockDecision({ action: 'REDUCE' }),
        createMockBalance(),
        [createMockPosition()]
      );
      expect(result.passed).toBe(true);
    });

    it('passes REDUCE when reduce_count is 0', () => {
      mockDbGet.mockReturnValue({ reduce_count: 0 });
      const result = checkHardLimits(
        createMockDecision({ action: 'REDUCE' }),
        createMockBalance(),
        [createMockPosition()]
      );
      expect(result.passed).toBe(true);
    });

    it('passes REDUCE when no DB record exists', () => {
      mockDbGet.mockReturnValue(undefined);
      const result = checkHardLimits(
        createMockDecision({ action: 'REDUCE' }),
        createMockBalance(),
        [createMockPosition()]
      );
      expect(result.passed).toBe(true);
    });
  });

  // ─── Balance checks ───────────────────────────────────────────
  describe('balance checks', () => {
    it('rejects when available balance is zero', () => {
      const result = checkHardLimits(
        createMockDecision({ action: 'LONG', params: { leverage: 5, positionSizePercent: 5 } }),
        createMockBalance({ availableBalance: 0 }),
        []
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('余额');
    });

    it('rejects when available balance is negative', () => {
      const result = checkHardLimits(
        createMockDecision({ action: 'LONG', params: { leverage: 5, positionSizePercent: 5 } }),
        createMockBalance({ availableBalance: -500 }),
        []
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('余额');
    });

    it('passes when available balance is positive', () => {
      const result = checkHardLimits(
        createMockDecision({ action: 'LONG', params: { leverage: 5, positionSizePercent: 5 } }),
        createMockBalance({ availableBalance: 100 }),
        []
      );
      expect(result.passed).toBe(true);
    });
  });

  // ─── Concurrent positions limit ───────────────────────────────
  describe('concurrent positions limit', () => {
    it('rejects new LONG when at max concurrent positions (5)', () => {
      const positions = Array.from({ length: 5 }, (_, i) =>
        createMockPosition({ symbol: `TOKEN${i}/USDT:USDT`, notional: 100 })
      );
      const result = checkHardLimits(
        createMockDecision({
          action: 'LONG',
          symbol: 'NEW/USDT:USDT',
          params: { leverage: 2, positionSizePercent: 2 },
        }),
        createMockBalance(),
        positions
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('最大并发持仓数');
    });

    it('rejects new SHORT when at max concurrent positions', () => {
      const positions = Array.from({ length: 5 }, (_, i) =>
        createMockPosition({ symbol: `TOKEN${i}/USDT:USDT`, notional: 100 })
      );
      const result = checkHardLimits(
        createMockDecision({
          action: 'SHORT',
          symbol: 'NEW/USDT:USDT',
          params: { leverage: 2, positionSizePercent: 2 },
        }),
        createMockBalance(),
        positions
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('最大并发持仓数');
    });

    it('allows LONG on existing symbol even at max positions', () => {
      const positions = Array.from({ length: 5 }, (_, i) =>
        createMockPosition({ symbol: `TOKEN${i}/USDT:USDT`, notional: 100 })
      );
      const result = checkHardLimits(
        createMockDecision({
          action: 'LONG',
          symbol: 'TOKEN0/USDT:USDT',
          params: { leverage: 2, positionSizePercent: 2 },
        }),
        createMockBalance(),
        positions
      );
      expect(result.passed).toBe(true);
    });

    it('allows new position when below max', () => {
      const positions = [createMockPosition({ symbol: 'ETH/USDT:USDT', notional: 100 })];
      const result = checkHardLimits(
        createMockDecision({
          action: 'LONG',
          symbol: 'BTC/USDT:USDT',
          params: { leverage: 2, positionSizePercent: 2 },
        }),
        createMockBalance(),
        positions
      );
      expect(result.passed).toBe(true);
    });
  });

  // ─── Total exposure limits ────────────────────────────────────
  describe('total exposure limits', () => {
    it('rejects when total exposure exceeds maxTotalExposurePct (30%)', () => {
      // Existing: 2500 notional on 10000 balance = 25%
      // New: 5% of 10000 * 5x = 2500 notional
      // Total: (2500 + 2500) / 10000 * 100 = 50% > 30%
      const result = checkHardLimits(
        createMockDecision({
          action: 'LONG',
          params: { positionSizePercent: 5, leverage: 5 },
        }),
        createMockBalance({ totalBalance: 10000 }),
        [createMockPosition({ notional: 2500 })]
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('总敞口');
    });

    it('passes when total exposure is within limit', () => {
      // Existing: 1000 notional on 10000 = 10%
      // New: 2% of 10000 * 3x = 600
      // Total: (1000 + 600) / 10000 * 100 = 16% < 30%
      const result = checkHardLimits(
        createMockDecision({
          action: 'LONG',
          params: { positionSizePercent: 2, leverage: 3 },
        }),
        createMockBalance({ totalBalance: 10000 }),
        [createMockPosition({ notional: 1000 })]
      );
      expect(result.passed).toBe(true);
    });

    it('handles zero total balance (balance check triggers first)', () => {
      const result = checkHardLimits(
        createMockDecision({
          action: 'LONG',
          params: { positionSizePercent: 5, leverage: 5 },
        }),
        createMockBalance({ totalBalance: 0, availableBalance: 0 }),
        []
      );
      expect(result.passed).toBe(false);
    });

    it('passes with no existing positions and small new position', () => {
      // New: 1% of 10000 * 2x = 200 => 200/10000 = 2% < 30%
      const result = checkHardLimits(
        createMockDecision({
          action: 'LONG',
          params: { positionSizePercent: 1, leverage: 2 },
        }),
        createMockBalance({ totalBalance: 10000 }),
        []
      );
      expect(result.passed).toBe(true);
    });
  });

  // ─── Edge cases ───────────────────────────────────────────────
  describe('edge cases', () => {
    it('passes ADJUST without params', () => {
      const result = checkHardLimits(
        createMockDecision({ action: 'ADJUST', params: null }),
        createMockBalance(),
        []
      );
      expect(result.passed).toBe(true);
    });

    it('checks leverage for ADJUST with params', () => {
      const result = checkHardLimits(
        createMockDecision({ action: 'ADJUST', params: { leverage: 20 } }),
        createMockBalance(),
        []
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('杠杆');
    });

    it('passes a fully valid LONG decision', () => {
      const result = checkHardLimits(
        createMockDecision({
          action: 'LONG',
          params: { positionSizePercent: 5, leverage: 5 },
        }),
        createMockBalance({ totalBalance: 10000, availableBalance: 5000 }),
        []
      );
      expect(result.passed).toBe(true);
    });

    it('passes a fully valid SHORT decision', () => {
      const result = checkHardLimits(
        createMockDecision({
          action: 'SHORT',
          params: { positionSizePercent: 3, leverage: 3 },
        }),
        createMockBalance({ totalBalance: 10000, availableBalance: 5000 }),
        []
      );
      expect(result.passed).toBe(true);
    });

    it('multiple checks can fail — first failure wins (leverage before balance)', () => {
      const result = checkHardLimits(
        createMockDecision({
          action: 'LONG',
          params: { leverage: 50, positionSizePercent: 5 },
        }),
        createMockBalance({ availableBalance: 0 }),
        []
      );
      expect(result.passed).toBe(false);
      // Leverage check comes before balance check
      expect(result.reason).toContain('杠杆');
    });
  });
});
