import { getDb } from '../db';

export function insertPosition(position: {
  symbol: string;
  side: string;
  amount: number;
  entryPrice?: number;
  leverage?: number;
  stopLoss?: number;
  takeProfit?: number;
  entryOrderId?: string;
  thesis?: string;
  strategicContext?: string;
}) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO positions (symbol, side, amount, entry_price, leverage, stop_loss, take_profit, entry_order_id, avg_entry_price, max_amount, thesis, strategic_context)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    position.symbol, position.side, position.amount,
    position.entryPrice ?? null, position.leverage ?? null,
    position.stopLoss ?? null, position.takeProfit ?? null,
    position.entryOrderId ?? null,
    position.entryPrice ?? null,
    position.amount,
    position.thesis ?? null,
    position.strategicContext ?? null,
  );
}

export function closePosition(params: {
  symbol: string;
  exitPrice: number;
  pnl: number;
  exitOrderId?: string;
}) {
  const db = getDb();
  db.prepare(`
    UPDATE positions SET status = 'closed', exit_price = ?, pnl = ?, exit_order_id = ?, closed_at = datetime('now')
    WHERE symbol = ? AND status = 'open'
  `).run(params.exitPrice, params.pnl, params.exitOrderId ?? null, params.symbol);
}

export function updatePositionSLTP(symbol: string, stopLoss?: number, takeProfit?: number) {
  const db = getDb();
  db.prepare(`
    UPDATE positions SET stop_loss = ?, take_profit = ?
    WHERE symbol = ? AND status = 'open'
  `).run(stopLoss ?? null, takeProfit ?? null, symbol);
}

export function getOpenPositions() {
  const db = getDb();
  return db.prepare("SELECT * FROM positions WHERE status = 'open' ORDER BY opened_at DESC").all();
}

export function getPositionHistory(limit = 50) {
  const db = getDb();
  return db.prepare('SELECT * FROM positions ORDER BY id DESC LIMIT ?').all(limit);
}

export function getOpenPositionBySymbol(symbol: string): any | null {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM positions WHERE symbol = ? AND status = 'open' ORDER BY id DESC LIMIT 1"
  ).get(symbol) ?? null;
}

export function updatePositionAdd(symbol: string, newAvgEntry: number, newAmount: number) {
  const db = getDb();
  db.prepare(`
    UPDATE positions
    SET add_count = add_count + 1,
        avg_entry_price = ?,
        amount = ?,
        max_amount = MAX(COALESCE(max_amount, amount), ?)
    WHERE symbol = ? AND status = 'open'
  `).run(newAvgEntry, newAmount, newAmount, symbol);
}

export function updatePositionReduce(symbol: string, newAmount: number, pnlRealized: number) {
  const db = getDb();
  db.prepare(`
    UPDATE positions
    SET reduce_count = reduce_count + 1,
        amount = ?,
        t_trade_savings = COALESCE(t_trade_savings, 0) + ?
    WHERE symbol = ? AND status = 'open'
  `).run(newAmount, pnlRealized, symbol);
}

export function updatePositionThesis(symbol: string, thesis: string) {
  const db = getDb();
  db.prepare(`
    UPDATE positions SET thesis = ? WHERE symbol = ? AND status = 'open'
  `).run(thesis, symbol);
}

export function getPositionThesis(symbol: string): string | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT thesis FROM positions WHERE symbol = ? AND status = 'open' ORDER BY id DESC LIMIT 1"
  ).get(symbol) as { thesis: string | null } | undefined;
  return row?.thesis ?? null;
}
