import { AIDecision } from '../core/decision';
import { AccountBalance, PositionInfo } from '../exchange/account';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getDb } from '../persistence/db';

export interface RiskCheckResult {
  passed: boolean;
  reason?: string;
}

export function checkHardLimits(
  decision: AIDecision,
  balance: AccountBalance,
  positions: PositionInfo[]
): RiskCheckResult {
  if (config.testnetOnly) {
    logger.info('风控检查: 测试网模式，AI 自主决策');
  }

  // HOLD / CLOSE 无需检查
  if (decision.action === 'HOLD' || decision.action === 'CLOSE') {
    return { passed: true };
  }

  // 开仓必须有参数
  const params = decision.params;
  if (!params && (decision.action === 'LONG' || decision.action === 'SHORT')) {
    return { passed: false, reason: '做多/做空操作需要参数' };
  }

  // ADD 风控
  if (decision.action === 'ADD') {
    const pos = positions.find((p) => p.symbol === decision.symbol);
    if (!pos) {
      return { passed: false, reason: '加仓失败: 无持仓' };
    }
    // Check add count from DB
    const dbPos = getDb().prepare(
      "SELECT add_count, amount FROM positions WHERE symbol = ? AND status = 'open' ORDER BY id DESC LIMIT 1"
    ).get(decision.symbol) as any;
    if (dbPos && dbPos.add_count >= 2) {
      return { passed: false, reason: '加仓失败: 已达最大加仓次数(2次)' };
    }
    // Must be profitable > 1.5%
    const pnlPct = pos.notional > 0 ? (pos.unrealizedPnl / (pos.notional / pos.leverage)) * 100 : 0;
    if (pnlPct < 1.5) {
      return { passed: false, reason: `加仓失败: 当前盈利 ${pnlPct.toFixed(2)}% 不足1.5%` };
    }
    // Total position after add must not exceed 2.5x initial
    if (dbPos && dbPos.amount > 0) {
      const addPct = params?.addPercent ?? 50;
      const addAmount = pos.contracts * (addPct / 100);
      const maxAmount = dbPos.amount * 2.5;
      if (pos.contracts + addAmount > maxAmount) {
        return { passed: false, reason: '加仓失败: 加仓后总仓位超过初始2.5倍' };
      }
    }
    return { passed: true };
  }

  // REDUCE 风控
  if (decision.action === 'REDUCE') {
    const pos = positions.find((p) => p.symbol === decision.symbol);
    if (!pos) {
      return { passed: false, reason: '减仓失败: 无持仓' };
    }
    const dbPos = getDb().prepare(
      "SELECT reduce_count FROM positions WHERE symbol = ? AND status = 'open' ORDER BY id DESC LIMIT 1"
    ).get(decision.symbol) as any;
    if (dbPos && dbPos.reduce_count >= 3) {
      return { passed: false, reason: '减仓失败: 已达最大做T次数(3次)' };
    }
    return { passed: true };
  }

  if (!params) {
    return { passed: true };
  }

  // 唯一的硬性检查：余额必须大于 0
  if (balance.availableBalance <= 0) {
    return { passed: false, reason: '可用余额不足' };
  }

  return { passed: true };
}
