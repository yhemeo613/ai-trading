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
      logger.info('熔断器冷却期已过，正在重置');
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
      tripCircuit(`连续亏损 3 次`);
    }
  } else {
    state.consecutiveLosses = 0;
  }
}

export function updateDailyLoss(dailyLossPct: number) {
  state.dailyLossPct = dailyLossPct;
  if (dailyLossPct >= config.risk.maxDailyLossPct) {
    tripCircuit(`日亏损 ${dailyLossPct.toFixed(2)}% 超过限制 ${config.risk.maxDailyLossPct}%`);
  }
}

export function recordApiFailure() {
  state.consecutiveApiFailures++;
  if (state.consecutiveApiFailures >= 5) {
    tripCircuit('连续 5 次 API 调用失败');
  }
}

export function recordApiSuccess() {
  state.consecutiveApiFailures = 0;
}

export function tripCircuit(reason: string) {
  state.tripped = true;
  state.reason = reason;
  state.trippedAt = Date.now();
  logger.error(`熔断器已触发: ${reason}`);
}

export function resetCircuit() {
  state.tripped = false;
  state.reason = '';
  state.trippedAt = 0;
  state.consecutiveLosses = 0;
  state.consecutiveApiFailures = 0;
  state.manualStop = false;
  logger.info('熔断器已重置');
}

export function emergencyStop() {
  state.manualStop = true;
  state.tripped = true;
  state.reason = '手动紧急停止';
  state.trippedAt = Date.now();
  logger.error('紧急停止已激活');
}
