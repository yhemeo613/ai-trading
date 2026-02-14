import { getDb } from '../db';

export function insertDecision(decision: {
  symbol: string;
  action: string;
  confidence?: number;
  reasoning?: string;
  rawResponse?: string;
  aiProvider?: string;
  aiModel?: string;
  riskPassed: boolean;
  riskReason?: string;
  executed: boolean;
  indicatorsJson?: string;
  orderbookJson?: string;
  sentimentJson?: string;
}) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO decisions (symbol, action, confidence, reasoning, raw_response, ai_provider, ai_model, risk_passed, risk_reason, executed, indicators_json, orderbook_json, sentiment_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    decision.symbol, decision.action, decision.confidence ?? null,
    decision.reasoning ?? null, decision.rawResponse ?? null,
    decision.aiProvider ?? null, decision.aiModel ?? null,
    decision.riskPassed ? 1 : 0, decision.riskReason ?? null,
    decision.executed ? 1 : 0,
    decision.indicatorsJson ?? null, decision.orderbookJson ?? null,
    decision.sentimentJson ?? null
  );
}

export function updateDecisionExecuted(id: number) {
  const db = getDb();
  db.prepare('UPDATE decisions SET executed = 1 WHERE id = ?').run(id);
}

export function getRecentDecisions(limit = 100) {
  const db = getDb();
  return db.prepare('SELECT * FROM decisions ORDER BY id DESC LIMIT ?').all(limit);
}
