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
    // Must be profitable > 1.5% — use exchange-reported percentage to avoid division issues
    const pnlPct = pos.percentage;
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

  // 杠杆上限检查
  if (params.leverage && params.leverage > config.risk.maxLeverage) {
    return { passed: false, reason: `杠杆 ${params.leverage}x 超过上限 ${config.risk.maxLeverage}x` };
  }

  // 唯一的硬性检查：余额必须大于 0
  if (balance.availableBalance <= 0) {
    return { passed: false, reason: '可用余额不足' };
  }

  // 单仓位占比检查
  if (params.positionSizePercent && params.positionSizePercent > config.risk.maxPositionPct) {
    return {
      passed: false,
      reason: `仓位占比 ${params.positionSizePercent}% 超过上限 ${config.risk.maxPositionPct}%`,
    };
  }

  // 最大并发持仓检查 (仅新开仓)
  if (decision.action === 'LONG' || decision.action === 'SHORT') {
    const existingPos = positions.find((p) => p.symbol === decision.symbol);
    if (!existingPos && positions.length >= config.risk.maxConcurrentPositions) {
      return {
        passed: false,
        reason: `已达最大并发持仓数 ${config.risk.maxConcurrentPositions}`,
      };
    }
  }

  // 总敞口检查
  const currentExposure = positions.reduce((sum, p) => sum + p.notional, 0);
  const newNotional = balance.totalBalance > 0
    ? (balance.totalBalance * (params.positionSizePercent ?? 0) / 100) * (params.leverage ?? 1)
    : 0;
  const totalExposurePct = balance.totalBalance > 0
    ? ((currentExposure + newNotional) / balance.totalBalance) * 100
    : 0;
  if (totalExposurePct > config.risk.maxTotalExposurePct) {
    return {
      passed: false,
      reason: `总敞口 ${totalExposurePct.toFixed(1)}% 超过上限 ${config.risk.maxTotalExposurePct}%`,
    };
  }

  return { passed: true };
}
