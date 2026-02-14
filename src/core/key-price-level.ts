import { getDb } from '../persistence/db';
import { logger } from '../utils/logger';

export interface KeyPriceLevel {
  id?: number;
  symbol: string;
  price: number;
  type: 'resistance' | 'support' | 'reversal' | 'breakout' | 'breakdown';
  triggerRadius: number;
  direction: 'LONG' | 'SHORT' | null;
  reasoning: string;
  confidence: number;
  invalidationPrice?: number;
  status: 'ACTIVE' | 'TRIGGERED' | 'INVALIDATED' | 'EXPIRED';
  sourceSessionId?: string;
  createdAt: string;
  expiresAt: string;
  triggeredAt?: string;
}

const MAX_ACTIVE_PER_SYMBOL = 6;

export function createKeyLevel(level: Omit<KeyPriceLevel, 'id' | 'status' | 'createdAt' | 'triggeredAt'>): number {
  const db = getDb();

  // Clamp triggerRadius to [price * 0.001, price * 0.01] (0.1% ~ 1%)
  const minRadius = level.price * 0.001;
  const maxRadius = level.price * 0.01;
  const clampedRadius = Math.max(minRadius, Math.min(maxRadius, level.triggerRadius));

  // Enforce max ACTIVE per symbol: remove oldest if at limit
  const activeCount = db.prepare(
    'SELECT COUNT(*) as cnt FROM key_price_levels WHERE symbol = ? AND status = ?'
  ).get(level.symbol, 'ACTIVE') as any;

  if (activeCount && activeCount.cnt >= MAX_ACTIVE_PER_SYMBOL) {
    db.prepare(
      `DELETE FROM key_price_levels WHERE id IN (
        SELECT id FROM key_price_levels WHERE symbol = ? AND status = 'ACTIVE'
        ORDER BY created_at ASC LIMIT ?
      )`
    ).run(level.symbol, activeCount.cnt - MAX_ACTIVE_PER_SYMBOL + 1);
  }

  const result = db.prepare(`
    INSERT INTO key_price_levels (symbol, price, type, trigger_radius, direction, reasoning, confidence, invalidation_price, status, source_session_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
  `).run(
    level.symbol,
    level.price,
    level.type,
    clampedRadius,
    level.direction,
    level.reasoning,
    level.confidence,
    level.invalidationPrice ?? null,
    level.sourceSessionId ?? null,
    level.expiresAt,
  );

  return Number(result.lastInsertRowid);
}

export function getActiveKeyLevels(symbol: string): KeyPriceLevel[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM key_price_levels WHERE symbol = ? AND status = 'ACTIVE' ORDER BY price ASC`
  ).all(symbol) as any[];
  return rows.map(rowToLevel);
}

export function getAllActiveKeyLevels(): KeyPriceLevel[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM key_price_levels WHERE status = 'ACTIVE' ORDER BY symbol, price ASC`
  ).all() as any[];
  return rows.map(rowToLevel);
}

export function evaluateLevelProximity(level: KeyPriceLevel, price: number): boolean {
  return Math.abs(price - level.price) <= level.triggerRadius;
}

export function triggerLevel(id: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE key_price_levels SET status = 'TRIGGERED', triggered_at = datetime('now') WHERE id = ?`
  ).run(id);
}

export function invalidateLevel(id: number, reason?: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE key_price_levels SET status = 'INVALIDATED' WHERE id = ?`
  ).run(id);
  if (reason) {
    logger.info(`关键点位 #${id} 已失效: ${reason}`);
  }
}

export function evaluateLevelValidity(level: KeyPriceLevel, currentPrice: number): { valid: boolean; reason: string } {
  if (!level.invalidationPrice) return { valid: true, reason: '' };

  // For support/long levels: invalidated if price drops below invalidation
  // For resistance/short levels: invalidated if price rises above invalidation
  if (level.direction === 'LONG' || level.type === 'support') {
    if (currentPrice < level.invalidationPrice) {
      return { valid: false, reason: `价格 ${currentPrice.toFixed(2)} 跌破失效价 ${level.invalidationPrice.toFixed(2)}` };
    }
  } else if (level.direction === 'SHORT' || level.type === 'resistance') {
    if (currentPrice > level.invalidationPrice) {
      return { valid: false, reason: `价格 ${currentPrice.toFixed(2)} 突破失效价 ${level.invalidationPrice.toFixed(2)}` };
    }
  } else {
    // For reversal/breakout/breakdown without clear direction, check distance
    if (Math.abs(currentPrice - level.invalidationPrice) < level.triggerRadius * 0.1) {
      return { valid: false, reason: `价格接近失效价 ${level.invalidationPrice.toFixed(2)}` };
    }
  }

  return { valid: true, reason: '' };
}

export function expireOldKeyLevels(): void {
  const db = getDb();
  const result = db.prepare(
    `UPDATE key_price_levels SET status = 'EXPIRED' WHERE status = 'ACTIVE' AND expires_at < datetime('now')`
  ).run();
  if (result.changes > 0) {
    logger.info(`已过期 ${result.changes} 个关键点位`);
  }
}

export function formatLevelsForPrompt(symbol: string, currentPrice?: number): string {
  const levels = getActiveKeyLevels(symbol);
  if (levels.length === 0) return '无活跃关键点位';

  const TYPE_LABELS: Record<string, string> = {
    resistance: '压力位',
    support: '支撑位',
    reversal: '反转点',
    breakout: '突破点',
    breakdown: '跌破点',
  };

  const lines = levels.map((l) => {
    const typeLabel = TYPE_LABELS[l.type] || l.type;
    const dirLabel = l.direction ? (l.direction === 'LONG' ? '做多' : '做空') : '中性';
    const proximity = currentPrice ? ` (距离: ${Math.abs(currentPrice - l.price).toFixed(2)}, 触发半径: ${l.triggerRadius.toFixed(2)})` : '';
    return `- ${typeLabel} ${l.price.toFixed(2)} [${dirLabel}] 置信度:${(l.confidence * 100).toFixed(0)}% ${l.reasoning}${proximity}`;
  });

  return `关键点位 (${symbol}):\n${lines.join('\n')}`;
}

function rowToLevel(row: any): KeyPriceLevel {
  return {
    id: row.id,
    symbol: row.symbol,
    price: row.price,
    type: row.type,
    triggerRadius: row.trigger_radius,
    direction: row.direction,
    reasoning: row.reasoning,
    confidence: row.confidence,
    invalidationPrice: row.invalidation_price ?? undefined,
    status: row.status,
    sourceSessionId: row.source_session_id ?? undefined,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    triggeredAt: row.triggered_at ?? undefined,
  };
}
