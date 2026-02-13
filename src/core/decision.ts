import { z } from 'zod';

export const TradeParamsSchema = z.object({
  positionSizePercent: z.number().min(1).max(10),
  leverage: z.number().min(1).max(10),
  stopLossPrice: z.number().positive(),
  takeProfitPrice: z.number().positive(),
  orderType: z.enum(['MARKET', 'LIMIT']),
});

export const AIDecisionSchema = z.object({
  action: z.enum(['LONG', 'SHORT', 'CLOSE', 'HOLD', 'ADJUST']),
  symbol: z.string(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  params: TradeParamsSchema.nullable(),
});

export type AIDecision = z.infer<typeof AIDecisionSchema>;
export type TradeParams = z.infer<typeof TradeParamsSchema>;

export const PairSelectionSchema = z.object({
  symbols: z.array(z.string()).min(1).max(5),
  reasoning: z.string(),
});

export type PairSelection = z.infer<typeof PairSelectionSchema>;

export const PortfolioReviewSchema = z.object({
  actions: z.array(z.object({
    symbol: z.string(),
    action: z.enum(['HOLD', 'CLOSE', 'ADJUST']),
    reasoning: z.string(),
    adjustParams: z.object({
      newStopLoss: z.number().positive().optional(),
      newTakeProfit: z.number().positive().optional(),
    }).nullable().optional(),
  })),
  overallAssessment: z.string(),
});

export type PortfolioReview = z.infer<typeof PortfolioReviewSchema>;

/**
 * Extract the first complete JSON object from a string by tracking brace depth.
 * More reliable than greedy regex when AI response contains multiple JSON-like fragments.
 */
function extractJson(raw: string): string {
  const start = raw.indexOf('{');
  if (start === -1) throw new Error('AI 响应中未找到 JSON');

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  throw new Error('AI 响应中 JSON 不完整');
}

export function parseAIDecision(raw: string): AIDecision {
  const jsonStr = extractJson(raw);
  const parsed = JSON.parse(jsonStr);
  return AIDecisionSchema.parse(parsed);
}

export function parsePairSelection(raw: string): PairSelection {
  const jsonStr = extractJson(raw);
  const parsed = JSON.parse(jsonStr);
  return PairSelectionSchema.parse(parsed);
}

export function parsePortfolioReview(raw: string): PortfolioReview {
  const jsonStr = extractJson(raw);
  const parsed = JSON.parse(jsonStr);
  return PortfolioReviewSchema.parse(parsed);
}
