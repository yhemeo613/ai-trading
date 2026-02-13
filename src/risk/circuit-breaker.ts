import { logger } from '../utils/logger';
import { config } from '../config';

interface CircuitState {
  tripped: boolean;
  reason: string;
  trippedAt: number;
  cooldownMs: number;
  consecutiveLosses: number;
  consecutiveApiFailures: number;
  dailyLossPct: number;
  manualStop: boolean;
}

const state: CircuitState = {
  tripped: false,
  reason: '',
  trippedAt: 0,
  cooldownMs: 60 * 60 * 1000, // 1 hour
  consecutiveLosses: 0,
  consecutiveApiFailures: 0,
  dailyLossPct: 0,
  manualStop: false,
};

export function isCircuitTripped(): boolean {
  if (state.manualStop) return true;

  if (state.tripped) {
    const elapsed = Date.now() - state.trippedAt;
    if (elapsed >= state.cooldownMs) {
      logger.info('Circuit breaker cooldown expired, resetting');
      resetCircuit();
      return false;
    }
    return true;
  }
  return false;
}

export function getCircuitState() {
  return { ...state };
}

export function recordTradeResult(pnlPct: number) {
  if (pnlPct < 0) {
    state.consecutiveLosses++;
    if (state.consecutiveLosses >= 3) {
      tripCircuit(`3 consecutive losses`);
    }
  } else {
    state.consecutiveLosses = 0;
  }
}

export function updateDailyLoss(dailyLossPct: number) {
  state.dailyLossPct = dailyLossPct;
  if (dailyLossPct >= config.risk.maxDailyLossPct) {
    tripCircuit(`Daily loss ${dailyLossPct.toFixed(2)}% exceeds ${config.risk.maxDailyLossPct}%`);
  }
}

export function recordApiFailure() {
  state.consecutiveApiFailures++;
  if (state.consecutiveApiFailures >= 5) {
    tripCircuit('5 consecutive API failures');
  }
}

export function recordApiSuccess() {
  state.consecutiveApiFailures = 0;
}

export function tripCircuit(reason: string) {
  state.tripped = true;
  state.reason = reason;
  state.trippedAt = Date.now();
  logger.error(`CIRCUIT BREAKER TRIPPED: ${reason}`);
}

export function resetCircuit() {
  state.tripped = false;
  state.reason = '';
  state.trippedAt = 0;
  state.consecutiveLosses = 0;
  state.consecutiveApiFailures = 0;
  state.manualStop = false;
  logger.info('Circuit breaker reset');
}

export function emergencyStop() {
  state.manualStop = true;
  state.tripped = true;
  state.reason = 'Manual emergency stop';
  state.trippedAt = Date.now();
  logger.error('EMERGENCY STOP activated');
}
