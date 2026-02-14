import { getDb } from '../persistence/db';
import type { DiscussionRecord } from './types';

export function insertDiscussion(record: DiscussionRecord): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO roundtable_discussions
      (session_id, symbol, depth, round1_json, round2_json, chairman_decision_json, consensus_level, duration_ms, action_taken, timings_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.sessionId,
    record.symbol,
    record.depth,
    record.round1Json,
    record.round2Json,
    record.chairmanDecisionJson,
    record.consensusLevel,
    record.durationMs,
    record.actionTaken,
    record.timingsJson ?? null,
  );
}

export function getRecentDiscussions(symbol: string, limit = 5): any[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM roundtable_discussions
    WHERE symbol = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(symbol, limit);
}
