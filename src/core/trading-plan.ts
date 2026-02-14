import { getDb } from '../persistence/db';
import { logger } from '../utils/logger';

// ─── Types ───────────────────────────────────────────────────────

export interface TradingPlan {
  id?: number;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryCondition: string;
  entryZone: { low: number; high: number };
  targets: { price: number; percent: number }[];
  stopLoss: number;
  invalidation: string;
  invalidationPrice?: number;
  thesis: string;
  confidence: number;
  status: 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'INVALIDATED' | 'EXPIRED';
  marketRegime: string;
  narrativeSnapshot: string;
  createdAt: string;
  expiresAt: string;
  activatedAt?: string;
  completedAt?: string;
}

// ─── CRUD ────────────────────────────────────────────────────────

export function createPlan(plan: Omit<TradingPlan, 'id' | 'status' | 'createdAt' | 'activatedAt' | 'completedAt'>): number {
  const db = getDb();

  // Enforce max 2 PENDING plans per symbol
  const pendingCount = db.prepare(
    "SELECT COUNT(*) as cnt FROM trading_plans WHERE symbol = ? AND status = 'PENDING'"
  ).get(plan.symbol) as { cnt: number };

  if (pendingCount.cnt >= 2) {
    // Expire oldest pending plan
    db.prepare(
      "UPDATE trading_plans SET status = 'EXPIRED', completed_at = datetime('now') WHERE symbol = ? AND status = 'PENDING' ORDER BY created_at ASC LIMIT 1"
    ).run(plan.symbol);
  }

  const result = db.prepare(`
    INSERT INTO trading_plans (symbol, direction, entry_condition, entry_zone_low, entry_zone_high,
      targets_json, stop_loss, invalidation, invalidation_price, confidence, reasoning, thesis,
      status, market_regime, narrative_snapshot, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)
  `).run(
    plan.symbol, plan.direction, plan.entryCondition,
    plan.entryZone.low, plan.entryZone.high,
    JSON.stringify(plan.targets), plan.stopLoss,
    plan.invalidation, plan.invalidationPrice ?? null,
    plan.confidence, plan.thesis, plan.thesis,
    plan.marketRegime, plan.narrativeSnapshot,
    plan.expiresAt,
  );

  logger.info(`创建交易计划: ${plan.symbol} ${plan.direction}`, { thesis: plan.thesis });
  return Number(result.lastInsertRowid);
}

export function getActivePlan(symbol: string): TradingPlan | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM trading_plans WHERE symbol = ? AND status = 'ACTIVE' ORDER BY id DESC LIMIT 1"
  ).get(symbol) as any;
  return row ? rowToPlan(row) : null;
}

export function getPendingPlans(symbol: string): TradingPlan[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM trading_plans WHERE symbol = ? AND status = 'PENDING' ORDER BY confidence DESC"
  ).all(symbol) as any[];
  return rows.map(rowToPlan);
}

export function getAllActivePlans(): TradingPlan[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM trading_plans WHERE status IN ('ACTIVE', 'PENDING') ORDER BY created_at DESC"
  ).all() as any[];
  return rows.map(rowToPlan);
}

export function activatePlan(planId: number) {
  const db = getDb();
  // First, check if there's already an active plan for this symbol
  const plan = db.prepare("SELECT symbol FROM trading_plans WHERE id = ?").get(planId) as any;
  if (plan) {
    // Complete any existing active plan for this symbol
    db.prepare(
      "UPDATE trading_plans SET status = 'COMPLETED', completed_at = datetime('now') WHERE symbol = ? AND status = 'ACTIVE'"
    ).run(plan.symbol);
  }
  db.prepare(
    "UPDATE trading_plans SET status = 'ACTIVE', activated_at = datetime('now') WHERE id = ?"
  ).run(planId);
  logger.info(`激活交易计划 #${planId}`);
}

export function completePlan(planId: number) {
  const db = getDb();
  db.prepare(
    "UPDATE trading_plans SET status = 'COMPLETED', completed_at = datetime('now') WHERE id = ?"
  ).run(planId);
}

export function invalidatePlan(planId: number, reason?: string) {
  const db = getDb();
  db.prepare(
    "UPDATE trading_plans SET status = 'INVALIDATED', completed_at = datetime('now'), reasoning = COALESCE(reasoning, '') || ? WHERE id = ?"
  ).run(reason ? ` [失效: ${reason}]` : '', planId);
  logger.info(`交易计划 #${planId} 已失效`, { reason });
}

export function expireOldPlans() {
  const db = getDb();
  const result = db.prepare(
    "UPDATE trading_plans SET status = 'EXPIRED', completed_at = datetime('now') WHERE status = 'PENDING' AND datetime(expires_at) < datetime('now')"
  ).run();
  if (result.changes > 0) {
    logger.info(`${result.changes} 个过期计划已清理`);
  }
}

// ─── Plan Evaluation ─────────────────────────────────────────────

export function evaluatePlanEntry(plan: TradingPlan, currentPrice: number): boolean {
  // Check if price is within entry zone, with 1% tolerance on each side
  const zoneWidth = plan.entryZone.high - plan.entryZone.low;
  const tolerance = Math.max(zoneWidth * 0.5, currentPrice * 0.01); // 1% of price or 50% of zone width
  return currentPrice >= plan.entryZone.low - tolerance && currentPrice <= plan.entryZone.high + tolerance;
}

export function evaluatePlanValidity(plan: TradingPlan, currentPrice: number): { valid: boolean; reason?: string } {
  // Hard invalidation: price hit invalidation level
  if (plan.invalidationPrice) {
    if (plan.direction === 'LONG' && currentPrice < plan.invalidationPrice) {
      return { valid: false, reason: `价格 ${currentPrice} 跌破失效价 ${plan.invalidationPrice}` };
    }
    if (plan.direction === 'SHORT' && currentPrice > plan.invalidationPrice) {
      return { valid: false, reason: `价格 ${currentPrice} 突破失效价 ${plan.invalidationPrice}` };
    }
  }
  return { valid: true };
}

// ─── Format for Prompt ───────────────────────────────────────────

export function formatPlansForPrompt(symbol: string, currentPrice?: number): string {
  const active = getActivePlan(symbol);
  const pending = getPendingPlans(symbol);

  if (!active && pending.length === 0) return '';

  const lines: string[] = ['【交易计划】'];

  if (active) {
    lines.push(`\n[活跃计划] ${active.direction} ${active.symbol}`);
    lines.push(`  论点: ${active.thesis}`);
    lines.push(`  入场区间: ${active.entryZone.low} - ${active.entryZone.high}`);
    if (currentPrice) {
      const midZone = (active.entryZone.low + active.entryZone.high) / 2;
      const distPct = ((currentPrice - midZone) / midZone * 100).toFixed(2);
      const inZone = currentPrice >= active.entryZone.low && currentPrice <= active.entryZone.high;
      lines.push(`  当前价距入场区间: ${inZone ? '已在区间内' : distPct + '%'}`);
    }
    lines.push(`  目标: ${active.targets.map((t) => `${t.price}(${t.percent}%)`).join(', ')}`);
    lines.push(`  止损: ${active.stopLoss}`);
    lines.push(`  失效条件: ${active.invalidation}`);
    if (active.invalidationPrice) lines.push(`  失效价格: ${active.invalidationPrice}`);
    lines.push(`  置信度: ${(active.confidence * 100).toFixed(0)}%`);
  }

  for (const p of pending) {
    lines.push(`\n[待执行计划] ${p.direction} ${p.symbol}`);
    lines.push(`  入场条件: ${p.entryCondition}`);
    lines.push(`  入场区间: ${p.entryZone.low} - ${p.entryZone.high}`);
    if (currentPrice) {
      const midZone = (p.entryZone.low + p.entryZone.high) / 2;
      const distPct = ((currentPrice - midZone) / midZone * 100).toFixed(2);
      const inZone = currentPrice >= p.entryZone.low && currentPrice <= p.entryZone.high;
      lines.push(`  当前价距入场区间: ${inZone ? '已在区间内' : distPct + '%'}`);
    }
    lines.push(`  论点: ${p.thesis}`);
    lines.push(`  置信度: ${(p.confidence * 100).toFixed(0)}%`);
  }

  return lines.join('\n');
}

// ─── Helpers ─────────────────────────────────────────────────────

function rowToPlan(row: any): TradingPlan {
  return {
    id: row.id,
    symbol: row.symbol,
    direction: row.direction,
    entryCondition: row.entry_condition ?? '',
    entryZone: { low: row.entry_zone_low ?? 0, high: row.entry_zone_high ?? 0 },
    targets: row.targets_json ? JSON.parse(row.targets_json) : [],
    stopLoss: row.stop_loss ?? 0,
    invalidation: row.invalidation ?? '',
    invalidationPrice: row.invalidation_price ?? undefined,
    thesis: row.thesis ?? '',
    confidence: row.confidence ?? 0,
    status: row.status,
    marketRegime: row.market_regime ?? '',
    narrativeSnapshot: row.narrative_snapshot ?? '',
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? '',
    activatedAt: row.activated_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
  };
}
