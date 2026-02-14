import { config } from '../config';
import { logger } from '../utils/logger';
import type { AccountBalance } from '../exchange/account';

// ─── Types ───────────────────────────────────────────────────────

export type AccountTier = 'micro' | 'small' | 'medium' | 'large' | 'whale';

export interface DynamicRiskLimits {
  tier: AccountTier;
  tierLabel: string;
  maxPositionPct: number;
  maxLeverage: number;
  maxTotalExposurePct: number;
  maxConcurrentPositions: number;
  maxDailyLossPct: number;
}

// ─── Tier Definitions ────────────────────────────────────────────

interface TierDef {
  tier: AccountTier;
  label: string;
  maxBalance: number; // exclusive upper bound, Infinity for whale
  positionPct: number;
  leverage: number;
  exposurePct: number;
  concurrent: number;
  dailyLossPct: number;
}

const TIERS: TierDef[] = [
  { tier: 'micro',  label: '微型账户', maxBalance: 100,    positionPct: 30, leverage: 15, exposurePct: 200, concurrent: 2, dailyLossPct: 15 },
  { tier: 'small',  label: '小账户',   maxBalance: 500,    positionPct: 25, leverage: 15, exposurePct: 250, concurrent: 3, dailyLossPct: 12 },
  { tier: 'medium', label: '中账户',   maxBalance: 2000,   positionPct: 20, leverage: 10, exposurePct: 200, concurrent: 4, dailyLossPct: 10 },
  { tier: 'large',  label: '大账户',   maxBalance: 10000,  positionPct: 15, leverage: 8,  exposurePct: 150, concurrent: 5, dailyLossPct: 8 },
  { tier: 'whale',  label: '巨鲸账户', maxBalance: Infinity, positionPct: 10, leverage: 5, exposurePct: 100, concurrent: 6, dailyLossPct: 5 },
];

// ─── Core ────────────────────────────────────────────────────────

export function computeDynamicLimits(balance: AccountBalance): DynamicRiskLimits {
  const bal = balance.totalBalance;
  const def = TIERS.find((t) => bal < t.maxBalance) ?? TIERS[TIERS.length - 1];

  const limits: DynamicRiskLimits = {
    tier: def.tier,
    tierLabel: def.label,
    maxPositionPct:        Math.min(def.positionPct, config.risk.maxPositionPct),
    maxLeverage:           Math.min(def.leverage, config.risk.maxLeverage),
    maxTotalExposurePct:   Math.min(def.exposurePct, config.risk.maxTotalExposurePct),
    maxConcurrentPositions: Math.min(def.concurrent, config.risk.maxConcurrentPositions),
    maxDailyLossPct:       Math.min(def.dailyLossPct, config.risk.maxDailyLossPct),
  };

  logger.info(`动态风控: ${def.label} (余额 ${bal.toFixed(2)}U) → 仓位${limits.maxPositionPct}% 杠杆${limits.maxLeverage}x 敞口${limits.maxTotalExposurePct}% 并发${limits.maxConcurrentPositions} 日亏${limits.maxDailyLossPct}%`);

  return limits;
}

// ─── Prompt Formatter ────────────────────────────────────────────

export function formatLimitsForPrompt(limits?: DynamicRiskLimits): string {
  if (!limits) return '';
  return `【当前风控限制】(${limits.tierLabel})
  最大单仓位: ${limits.maxPositionPct}%
  最大杠杆: ${limits.maxLeverage}x
  最大总敞口: ${limits.maxTotalExposurePct}%
  最大并发持仓: ${limits.maxConcurrentPositions}
  最大日亏损: ${limits.maxDailyLossPct}%`;
}
