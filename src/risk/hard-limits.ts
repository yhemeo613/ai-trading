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
    logger.info('Hard limit check: TESTNET mode active');
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
    return { passed: false, reason: 'LONG/SHORT requires params' };
  }

  if (!params) {
    return { passed: true };
  }

  // Max leverage check
  if (params.leverage > config.risk.maxLeverage) {
    return { passed: false, reason: `Leverage ${params.leverage}x exceeds max ${config.risk.maxLeverage}x` };
  }

  // Single position size check (max 10% of balance)
  if (params.positionSizePercent > config.risk.maxPositionPct) {
    return { passed: false, reason: `Position size ${params.positionSizePercent}% exceeds max ${config.risk.maxPositionPct}%` };
  }

  // Stop loss must be set
  if (!params.stopLossPrice || params.stopLossPrice <= 0) {
    return { passed: false, reason: 'Stop loss price must be set' };
  }

  // Max concurrent positions
  if (decision.action === 'LONG' || decision.action === 'SHORT') {
    if (positions.length >= config.risk.maxConcurrentPositions) {
      const alreadyHas = positions.some((p) => p.symbol === decision.symbol);
      if (!alreadyHas) {
        return { passed: false, reason: `Max ${config.risk.maxConcurrentPositions} concurrent positions reached` };
      }
    }
  }

  // Total exposure check (max 30% of total balance)
  const currentExposure = positions.reduce((sum, p) => sum + p.notional, 0);
  const newPositionNotional = (balance.totalBalance * params.positionSizePercent / 100) * params.leverage;
  const totalExposure = currentExposure + newPositionNotional;
  const exposurePct = (totalExposure / balance.totalBalance) * 100;

  if (exposurePct > config.risk.maxTotalExposurePct) {
    return { passed: false, reason: `Total exposure ${exposurePct.toFixed(1)}% exceeds max ${config.risk.maxTotalExposurePct}%` };
  }

  return { passed: true };
}
