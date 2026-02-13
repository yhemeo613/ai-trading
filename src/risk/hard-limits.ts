import { AIDecision } from '../core/decision';
import { AccountBalance, PositionInfo } from '../exchange/account';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface RiskCheckResult {
  passed: boolean;
  reason?: string;
}

export function checkHardLimits(
  decision: AIDecision,
  balance: AccountBalance,
  positions: PositionInfo[]
): RiskCheckResult {
  // TESTNET_ONLY check
  if (config.testnetOnly) {
    logger.info('风控检查: 测试网模式');
  }

  // HOLD needs no checks
  if (decision.action === 'HOLD') {
    return { passed: true };
  }

  // CLOSE needs no position size checks
  if (decision.action === 'CLOSE') {
    return { passed: true };
  }

  const params = decision.params;
  if (!params && (decision.action === 'LONG' || decision.action === 'SHORT')) {
    return { passed: false, reason: '做多/做空操作需要参数' };
  }

  if (!params) {
    return { passed: true };
  }

  // Max leverage check
  if (params.leverage > config.risk.maxLeverage) {
    return { passed: false, reason: `杠杆 ${params.leverage}x 超过最大限制 ${config.risk.maxLeverage}x` };
  }

  // Single position size check (max 10% of balance)
  if (params.positionSizePercent > config.risk.maxPositionPct) {
    return { passed: false, reason: `仓位大小 ${params.positionSizePercent}% 超过最大限制 ${config.risk.maxPositionPct}%` };
  }

  // Stop loss must be set
  if (!params.stopLossPrice || params.stopLossPrice <= 0) {
    return { passed: false, reason: '必须设置止损价格' };
  }

  // Max concurrent positions
  if (decision.action === 'LONG' || decision.action === 'SHORT') {
    if (positions.length >= config.risk.maxConcurrentPositions) {
      const alreadyHas = positions.some((p) => p.symbol === decision.symbol);
      if (!alreadyHas) {
        return { passed: false, reason: `已达最大并发持仓数 ${config.risk.maxConcurrentPositions}` };
      }
    }
  }

  // Total exposure check (max 30% of total balance)
  const currentExposure = positions.reduce((sum, p) => sum + p.notional, 0);
  const newPositionNotional = (balance.availableBalance * params.positionSizePercent / 100) * params.leverage;
  const totalExposure = currentExposure + newPositionNotional;
  const exposurePct = (totalExposure / balance.totalBalance) * 100;

  if (exposurePct > config.risk.maxTotalExposurePct) {
    return { passed: false, reason: `总敞口 ${exposurePct.toFixed(1)}% 超过最大限制 ${config.risk.maxTotalExposurePct}%` };
  }

  return { passed: true };
}
