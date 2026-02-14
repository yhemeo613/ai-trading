import { getDb } from '../db';

export interface PositionOperation {
  positionId: number;
  operation: 'OPEN' | 'ADD' | 'REDUCE' | 'CLOSE';
  side: string;
  amount: number;
  price: number;
  pnlRealized?: number;
  avgEntryAfter?: number;
  totalAmountAfter?: number;
}

export function insertPositionOperation(op: PositionOperation) {
  const db = getDb();
  return db.prepare(`
    INSERT INTO position_operations (position_id, operation, side, amount, price, pnl_realized, avg_entry_after, total_amount_after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    op.positionId, op.operation, op.side, op.amount, op.price,
    op.pnlRealized ?? 0, op.avgEntryAfter ?? null, op.totalAmountAfter ?? null,
  );
}

export function getPositionOperations(positionId: number): any[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM position_operations WHERE position_id = ? ORDER BY created_at ASC'
  ).all(positionId);
}

/**
 * Calculate new average entry price after adding to a position.
 * Formula: (oldAvg * oldAmount + newPrice * newAmount) / (oldAmount + newAmount)
 */
export function calcNewAvgEntry(
  oldAvgEntry: number,
  oldAmount: number,
  newPrice: number,
  newAmount: number,
): number {
  const totalCost = oldAvgEntry * oldAmount + newPrice * newAmount;
  const totalAmount = oldAmount + newAmount;
  return totalAmount > 0 ? totalCost / totalAmount : newPrice;
}

/**
 * Calculate realized PnL from a partial reduce.
 * For long: (reducePrice - avgEntry) * reduceAmount
 * For short: (avgEntry - reducePrice) * reduceAmount
 */
export function calcReducePnl(
  side: string,
  avgEntry: number,
  reducePrice: number,
  reduceAmount: number,
): number {
  if (side === 'long' || side === 'buy') {
    return (reducePrice - avgEntry) * reduceAmount;
  }
  return (avgEntry - reducePrice) * reduceAmount;
}
