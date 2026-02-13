import { getDb } from '../db';

export function insertSnapshot(snapshot: {
  totalBalance: number;
  availableBalance: number;
  unrealizedPnl: number;
  positionCount: number;
  positionsJson: string;
}) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO snapshots (total_balance, available_balance, unrealized_pnl, position_count, positions_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  return stmt.run(
    snapshot.totalBalance, snapshot.availableBalance,
    snapshot.unrealizedPnl, snapshot.positionCount, snapshot.positionsJson
  );
}

export function getRecentSnapshots(limit = 200) {
  const db = getDb();
  return db.prepare('SELECT * FROM snapshots ORDER BY id DESC LIMIT ?').all(limit);
}

export function updateDailyPnl(date: string, balance: number, realizedPnl: number, tradeCount: number) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM daily_pnl WHERE date = ?').get(date) as any;
  if (existing) {
    db.prepare(`
      UPDATE daily_pnl SET ending_balance = ?, realized_pnl = realized_pnl + ?, trade_count = trade_count + ?
      WHERE date = ?
    `).run(balance, realizedPnl, tradeCount, date);
  } else {
    db.prepare(`
      INSERT INTO daily_pnl (date, starting_balance, ending_balance, realized_pnl, trade_count)
      VALUES (?, ?, ?, ?, ?)
    `).run(date, balance, balance, realizedPnl, tradeCount);
  }
}

export function getDailyPnlHistory(days = 30) {
  const db = getDb();
  return db.prepare('SELECT * FROM daily_pnl ORDER BY date DESC LIMIT ?').all(days);
}
