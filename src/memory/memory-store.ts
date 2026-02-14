import { getDb } from '../persistence/db';
import { logger } from '../utils/logger';

export interface StrategyMemory {
  id?: number;
  symbol: string;
  memoryType: string;
  content: string;
  marketCondition?: string;
  outcome?: string;
  pnlPercent?: number;
  relevanceScore?: number;
  tags?: string;
  expiresAt?: string;
}

export interface SymbolStats {
  symbol: string;
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  avgWinPnl: number;
  avgLossPnl: number;
  bestTradePnl: number;
  worstTradePnl: number;
  winRate: number;
  profitFactor: number;
}

export function insertMemory(memory: StrategyMemory) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO strategy_memory (symbol, memory_type, content, market_condition, outcome, pnl_percent, relevance_score, tags, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    memory.symbol,
    memory.memoryType,
    memory.content,
    memory.marketCondition ?? null,
    memory.outcome ?? null,
    memory.pnlPercent ?? null,
    memory.relevanceScore ?? 1.0,
    memory.tags ?? null,
    memory.expiresAt ?? null,
  );
}

export function getRelevantMemories(symbol: string, condition?: string, limit = 10): any[] {
  const db = getDb();
  if (condition) {
    return db.prepare(`
      SELECT * FROM strategy_memory
      WHERE (symbol = ? OR symbol = '*') AND (market_condition = ? OR market_condition IS NULL)
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY relevance_score DESC, created_at DESC
      LIMIT ?
    `).all(symbol, condition, limit);
  }
  return db.prepare(`
    SELECT * FROM strategy_memory
    WHERE (symbol = ? OR symbol = '*')
      AND (expires_at IS NULL OR expires_at > datetime('now'))
    ORDER BY relevance_score DESC, created_at DESC
    LIMIT ?
  `).all(symbol, limit);
}

export function decayMemories() {
  const db = getDb();
  // Decay relevance by 5% for memories older than 3 days
  const result = db.prepare(`
    UPDATE strategy_memory
    SET relevance_score = MAX(0.1, relevance_score * 0.95)
    WHERE created_at < datetime('now', '-3 days')
      AND relevance_score > 0.1
  `).run();
  logger.info(`记忆衰减完成，影响 ${result.changes} 条记录`);
}

export function boostMemory(id: number) {
  const db = getDb();
  db.prepare(`
    UPDATE strategy_memory
    SET relevance_score = MIN(2.0, relevance_score * 1.2)
    WHERE id = ?
  `).run(id);
}

export function updateSymbolStats(symbol: string) {
  const db = getDb();
  const trades = db.prepare(`
    SELECT pnl FROM positions WHERE symbol = ? AND status = 'closed' AND pnl IS NOT NULL
  `).all(symbol) as { pnl: number }[];

  if (trades.length === 0) return;

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWinPnl = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLossPnl = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const bestTradePnl = trades.reduce((best, t) => Math.max(best, t.pnl), -Infinity);
  const worstTradePnl = trades.reduce((worst, t) => Math.min(worst, t.pnl), Infinity);
  const winRate = trades.length > 0 ? wins.length / trades.length : 0;
  const totalWinPnl = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLossPnl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = totalLossPnl > 0 ? totalWinPnl / totalLossPnl : totalWinPnl > 0 ? 999 : 0;

  db.prepare(`
    INSERT INTO symbol_stats (symbol, total_trades, wins, losses, total_pnl, avg_win_pnl, avg_loss_pnl, best_trade_pnl, worst_trade_pnl, win_rate, profit_factor, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(symbol) DO UPDATE SET
      total_trades = ?, wins = ?, losses = ?, total_pnl = ?,
      avg_win_pnl = ?, avg_loss_pnl = ?, best_trade_pnl = ?, worst_trade_pnl = ?,
      win_rate = ?, profit_factor = ?, updated_at = datetime('now')
  `).run(
    symbol, trades.length, wins.length, losses.length, totalPnl,
    avgWinPnl, avgLossPnl, bestTradePnl, worstTradePnl, winRate, profitFactor,
    trades.length, wins.length, losses.length, totalPnl,
    avgWinPnl, avgLossPnl, bestTradePnl, worstTradePnl, winRate, profitFactor,
  );
}

export function getSymbolStats(symbol: string): SymbolStats | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM symbol_stats WHERE symbol = ?').get(symbol) as any;
  if (!row) return null;
  return {
    symbol: row.symbol,
    totalTrades: row.total_trades,
    wins: row.wins,
    losses: row.losses,
    totalPnl: row.total_pnl,
    avgWinPnl: row.avg_win_pnl,
    avgLossPnl: row.avg_loss_pnl,
    bestTradePnl: row.best_trade_pnl,
    worstTradePnl: row.worst_trade_pnl,
    winRate: row.win_rate,
    profitFactor: row.profit_factor,
  };
}

export function getAllSymbolStats(): SymbolStats[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM symbol_stats ORDER BY win_rate DESC').all() as any[];
  return rows.map((row) => ({
    symbol: row.symbol,
    totalTrades: row.total_trades,
    wins: row.wins,
    losses: row.losses,
    totalPnl: row.total_pnl,
    avgWinPnl: row.avg_win_pnl,
    avgLossPnl: row.avg_loss_pnl,
    bestTradePnl: row.best_trade_pnl,
    worstTradePnl: row.worst_trade_pnl,
    winRate: row.win_rate,
    profitFactor: row.profit_factor,
  }));
}

/**
 * Convenience function to insert a market observation memory.
 */
export function insertMarketObservation(
  symbol: string,
  type: string,
  content: string,
  regime?: string,
) {
  return insertMemory({
    symbol,
    memoryType: `observation_${type}`,
    content,
    marketCondition: regime,
    relevanceScore: 1.0,
    tags: `observation,${type}`,
  });
}
