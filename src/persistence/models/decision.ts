import { getDb } from '../db';

export function insertDecision(decision: {
  symbol: string;
  action: string;
  confidence?: number;
  reasoning?: string;
  rawResponse?: string;
  aiProvider?: string;
  riskPassed: boolean;
  riskReason?: string;
  executed: boolean;
}) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO decisions (symbol, action, confidence, reasoning, raw_response, ai_provider, risk_passed, risk_reason, executed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    decision.symbol, decision.action, decision.confidence ?? null,
    decision.reasoning ?? null, decision.rawResponse ?? null,
    decision.aiProvider ?? null, decision.riskPassed ? 1 : 0,
    decision.riskReason ?? null, decision.executed ? 1 : 0
  );
}

export function getRecentDecisions(limit = 100) {
  const db = getDb();
  return db.prepare('SELECT * FROM decisions ORDER BY id DESC LIMIT ?').all(limit);
}
