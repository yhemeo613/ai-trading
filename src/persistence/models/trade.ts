import { getDb } from '../db';

export function insertTrade(trade: {
  symbol: string;
  action: string;
  side?: string;
  amount?: number;
  price?: number;
  leverage?: number;
  stopLoss?: number;
  takeProfit?: number;
  orderId?: string;
  confidence?: number;
  reasoning?: string;
  aiProvider?: string;
  pnl?: number;
}) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO trades (symbol, action, side, amount, price, leverage, stop_loss, take_profit, order_id, confidence, reasoning, ai_provider, pnl)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    trade.symbol, trade.action, trade.side ?? null, trade.amount ?? null,
    trade.price ?? null, trade.leverage ?? null, trade.stopLoss ?? null,
    trade.takeProfit ?? null, trade.orderId ?? null, trade.confidence ?? null,
    trade.reasoning ?? null, trade.aiProvider ?? null, trade.pnl ?? null
  );
}

export function getRecentTrades(limit = 50) {
  const db = getDb();
  return db.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT ?').all(limit);
}

export function getTodayTrades() {
  const db = getDb();
  return db.prepare("SELECT * FROM trades WHERE date(created_at) = date('now') ORDER BY id DESC").all();
}
