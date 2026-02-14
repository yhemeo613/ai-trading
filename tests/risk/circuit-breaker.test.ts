import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config before importing the module under test
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

import {
  isCircuitTripped,
  getCircuitState,
  recordTradeResult,
  getStreakInfo,
  updateDailyLoss,
  recordApiFailure,
  recordApiSuccess,
  tripCircuit,
  resetCircuit,
  emergencyStop,
} from '../../src/risk/circuit-breaker';

describe('circuit-breaker', () => {
  beforeEach(() => {
    resetCircuit();
    vi.clearAllMocks();
  });

  // ─── Initial state ────────────────────────────────────────────
  describe('initial state', () => {
    it('is not tripped after reset', () => {
      expect(isCircuitTripped()).toBe(false);
    });

    it('has zero streaks after reset', () => {
      const info = getStreakInfo();
      expect(info.winStreak).toBe(0);
      expect(info.lossStreak).toBe(0);
    });

    it('has clean state after reset', () => {
      const state = getCircuitState();
      expect(state.tripped).toBe(false);
      expect(state.consecutiveLosses).toBe(0);
      expect(state.consecutiveApiFailures).toBe(0);
      expect(state.manualStop).toBe(false);
    });
  });

  // ─── Consecutive loss trigger ─────────────────────────────────
  describe('consecutive loss trigger', () => {
    it('does not trip on 1 loss', () => {
      recordTradeResult(-1);
      expect(isCircuitTripped()).toBe(false);
      expect(getCircuitState().consecutiveLosses).toBe(1);
    });

    it('does not trip on 2 consecutive losses', () => {
      recordTradeResult(-1);
      recordTradeResult(-2);
      expect(isCircuitTripped()).toBe(false);
      expect(getCircuitState().consecutiveLosses).toBe(2);
    });

    it('trips on 3 consecutive losses', () => {
      recordTradeResult(-1);
      recordTradeResult(-2);
      recordTradeResult(-0.5);
      expect(isCircuitTripped()).toBe(true);
      expect(getCircuitState().reason).toContain('连续亏损');
    });

    it('trips on more than 3 consecutive losses', () => {
      recordTradeResult(-1);
      recordTradeResult(-2);
      recordTradeResult(-3);
      recordTradeResult(-4);
      expect(isCircuitTripped()).toBe(true);
    });

    it('resets consecutive losses on a win', () => {
      recordTradeResult(-1);
      recordTradeResult(-2);
      recordTradeResult(5); // win resets
      expect(getCircuitState().consecutiveLosses).toBe(0);
      expect(isCircuitTripped()).toBe(false);
    });

    it('does not trip if win interrupts loss streak', () => {
      recordTradeResult(-1);
      recordTradeResult(-2);
      recordTradeResult(1); // reset
      recordTradeResult(-1);
      recordTradeResult(-2);
      expect(isCircuitTripped()).toBe(false);
      expect(getCircuitState().consecutiveLosses).toBe(2);
    });

    it('treats exactly 0 PnL as a win (not a loss)', () => {
      recordTradeResult(-1);
      recordTradeResult(-2);
      recordTradeResult(0); // 0 is not < 0, so it resets
      expect(getCircuitState().consecutiveLosses).toBe(0);
    });
  });

  // ─── Win/loss streak tracking ─────────────────────────────────
  describe('streak tracking', () => {
    it('tracks win streak', () => {
      recordTradeResult(1);
      recordTradeResult(2);
      recordTradeResult(3);
      const info = getStreakInfo();
      expect(info.winStreak).toBe(3);
      expect(info.lossStreak).toBe(0);
    });

    it('tracks loss streak', () => {
      recordTradeResult(-1);
      recordTradeResult(-2);
      const info = getStreakInfo();
      expect(info.lossStreak).toBe(2);
      expect(info.winStreak).toBe(0);
    });

    it('resets win streak on loss', () => {
      recordTradeResult(1);
      recordTradeResult(2);
      recordTradeResult(-1);
      const info = getStreakInfo();
      expect(info.winStreak).toBe(0);
      expect(info.lossStreak).toBe(1);
    });

    it('resets loss streak on win', () => {
      recordTradeResult(-1);
      recordTradeResult(-2);
      recordTradeResult(1);
      const info = getStreakInfo();
      expect(info.lossStreak).toBe(0);
      expect(info.winStreak).toBe(1);
    });
  });

  // ─── API failure trigger ──────────────────────────────────────
  describe('API failure trigger', () => {
    it('does not trip on fewer than 5 API failures', () => {
      for (let i = 0; i < 4; i++) recordApiFailure();
      expect(isCircuitTripped()).toBe(false);
      expect(getCircuitState().consecutiveApiFailures).toBe(4);
    });

    it('trips on 5 consecutive API failures', () => {
      for (let i = 0; i < 5; i++) recordApiFailure();
      expect(isCircuitTripped()).toBe(true);
      expect(getCircuitState().reason).toContain('API');
    });

    it('resets API failure count on success', () => {
      recordApiFailure();
      recordApiFailure();
      recordApiFailure();
      recordApiSuccess();
      expect(getCircuitState().consecutiveApiFailures).toBe(0);
      expect(isCircuitTripped()).toBe(false);
    });

    it('does not trip if success interrupts failure streak', () => {
      for (let i = 0; i < 4; i++) recordApiFailure();
      recordApiSuccess(); // reset
      for (let i = 0; i < 4; i++) recordApiFailure();
      expect(isCircuitTripped()).toBe(false);
    });
  });

  // ─── Daily loss trigger ───────────────────────────────────────
  describe('daily loss trigger', () => {
    it('does not trip when daily loss is below limit', () => {
      updateDailyLoss(3);
      expect(isCircuitTripped()).toBe(false);
    });

    it('trips when daily loss reaches maxDailyLossPct (5%)', () => {
      updateDailyLoss(5);
      expect(isCircuitTripped()).toBe(true);
      expect(getCircuitState().reason).toContain('日亏损');
    });

    it('trips when daily loss exceeds maxDailyLossPct', () => {
      updateDailyLoss(7.5);
      expect(isCircuitTripped()).toBe(true);
    });

    it('does not trip at 4.99%', () => {
      updateDailyLoss(4.99);
      expect(isCircuitTripped()).toBe(false);
    });

    it('stores the daily loss percentage in state', () => {
      updateDailyLoss(3.5);
      expect(getCircuitState().dailyLossPct).toBe(3.5);
    });
  });

  // ─── Cooldown period ──────────────────────────────────────────
  describe('cooldown period', () => {
    it('remains tripped during cooldown', () => {
      tripCircuit('test reason');
      expect(isCircuitTripped()).toBe(true);
    });

    it('auto-resets after cooldown period expires', () => {
      tripCircuit('test reason');

      // Advance time past the 1-hour cooldown
      const state = getCircuitState();
      const originalDateNow = Date.now;
      Date.now = () => state.trippedAt + state.cooldownMs + 1;

      expect(isCircuitTripped()).toBe(false);

      Date.now = originalDateNow;
    });

    it('stays tripped just before cooldown expires', () => {
      tripCircuit('test reason');

      const state = getCircuitState();
      const originalDateNow = Date.now;
      Date.now = () => state.trippedAt + state.cooldownMs - 1;

      expect(isCircuitTripped()).toBe(true);

      Date.now = originalDateNow;
    });

    it('default cooldown is 1 hour (3600000ms)', () => {
      const state = getCircuitState();
      expect(state.cooldownMs).toBe(60 * 60 * 1000);
    });
  });

  // ─── Manual reset ─────────────────────────────────────────────
  describe('manual reset', () => {
    it('clears tripped state', () => {
      tripCircuit('test');
      expect(isCircuitTripped()).toBe(true);
      resetCircuit();
      expect(isCircuitTripped()).toBe(false);
    });

    it('clears all counters', () => {
      recordTradeResult(-1);
      recordTradeResult(-2);
      recordApiFailure();
      recordApiFailure();
      resetCircuit();
      const state = getCircuitState();
      expect(state.consecutiveLosses).toBe(0);
      expect(state.consecutiveApiFailures).toBe(0);
      expect(state.winStreak).toBe(0);
      expect(state.lossStreak).toBe(0);
    });

    it('clears manual stop flag', () => {
      emergencyStop();
      resetCircuit();
      expect(getCircuitState().manualStop).toBe(false);
      expect(isCircuitTripped()).toBe(false);
    });

    it('clears reason and trippedAt', () => {
      tripCircuit('some reason');
      resetCircuit();
      const state = getCircuitState();
      expect(state.reason).toBe('');
      expect(state.trippedAt).toBe(0);
    });
  });

  // ─── Emergency stop ───────────────────────────────────────────
  describe('emergency stop', () => {
    it('trips the circuit immediately', () => {
      emergencyStop();
      expect(isCircuitTripped()).toBe(true);
    });

    it('sets manualStop flag', () => {
      emergencyStop();
      expect(getCircuitState().manualStop).toBe(true);
    });

    it('cannot be auto-reset by cooldown expiry', () => {
      emergencyStop();

      const state = getCircuitState();
      const originalDateNow = Date.now;
      Date.now = () => state.trippedAt + state.cooldownMs + 100000;

      // manualStop takes priority — isCircuitTripped checks manualStop first
      expect(isCircuitTripped()).toBe(true);

      Date.now = originalDateNow;
    });

    it('sets reason to manual emergency stop', () => {
      emergencyStop();
      expect(getCircuitState().reason).toContain('紧急停止');
    });

    it('can only be cleared by explicit resetCircuit()', () => {
      emergencyStop();
      expect(isCircuitTripped()).toBe(true);
      resetCircuit();
      expect(isCircuitTripped()).toBe(false);
    });
  });

  // ─── tripCircuit directly ─────────────────────────────────────
  describe('tripCircuit', () => {
    it('sets tripped state with reason', () => {
      tripCircuit('custom reason');
      const state = getCircuitState();
      expect(state.tripped).toBe(true);
      expect(state.reason).toBe('custom reason');
      expect(state.trippedAt).toBeGreaterThan(0);
    });

    it('records trippedAt timestamp', () => {
      const before = Date.now();
      tripCircuit('test');
      const after = Date.now();
      const state = getCircuitState();
      expect(state.trippedAt).toBeGreaterThanOrEqual(before);
      expect(state.trippedAt).toBeLessThanOrEqual(after);
    });
  });

  // ─── getCircuitState returns a copy ───────────────────────────
  describe('getCircuitState immutability', () => {
    it('returns a copy, not a reference', () => {
      const state1 = getCircuitState();
      state1.tripped = true;
      state1.consecutiveLosses = 999;
      const state2 = getCircuitState();
      expect(state2.tripped).toBe(false);
      expect(state2.consecutiveLosses).toBe(0);
    });
  });
});
