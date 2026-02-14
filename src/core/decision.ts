import { z } from 'zod';

export const TradeParamsSchema = z.object({
  positionSizePercent: z.number().min(0).optional(),
  leverage: z.number().min(0).optional(),
  stopLossPrice: z.number().min(0).optional(),
  takeProfitPrice: z.number().min(0).optional(),
  orderType: z.enum(['MARKET', 'LIMIT']).optional(),
  addPercent: z.number().min(0).max(100).optional(),
  reducePercent: z.number().min(0).max(100).optional(),
});

export const MarketRegimeSchema = z.enum([
  'trending_up', 'trending_down', 'ranging', 'volatile', 'quiet',
]);

export type MarketRegime = z.infer<typeof MarketRegimeSchema>;

export const AIDecisionSchema = z.object({
  action: z.enum(['LONG', 'SHORT', 'CLOSE', 'HOLD', 'ADJUST', 'ADD', 'REDUCE']),
  symbol: z.string(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  params: TradeParamsSchema.nullable(),
  marketRegime: MarketRegimeSchema.optional(),
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

// ─── Strategic Output Schema ─────────────────────────────────────

export const StrategicPlanActionSchema = z.object({
  action: z.enum(['CREATE', 'MAINTAIN', 'INVALIDATE', 'NONE']),
  direction: z.enum(['LONG', 'SHORT']).optional(),
  entryCondition: z.string().optional(),
  entryZoneLow: z.number().optional(),
  entryZoneHigh: z.number().optional(),
  targets: z.array(z.object({ price: z.number(), percent: z.number() })).optional(),
  stopLoss: z.number().optional(),
  invalidation: z.string().optional(),
  invalidationPrice: z.number().optional(),
  confidence: z.number().min(0).max(1).optional(),
  thesis: z.string().optional(),
});

export const StrategicOutputSchema = z.object({
  marketRegime: MarketRegimeSchema,
  bias: z.enum(['bullish', 'bearish', 'neutral']),
  reasoning: z.string(),
  plan: StrategicPlanActionSchema,
});

export type StrategicOutput = z.infer<typeof StrategicOutputSchema>;
export type StrategicPlanAction = z.infer<typeof StrategicPlanActionSchema>;

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

/**
 * Strip null values from an object, converting them to undefined.
 * This handles AI responses that return null instead of omitting fields.
 */
function stripNulls<T extends Record<string, any>>(obj: T): T {
  const result = { ...obj };
  for (const key of Object.keys(result)) {
    if (result[key] === null) {
      delete result[key];
    }
  }
  return result;
}

/**
 * Extract <think>...</think> content from AI response.
 * Returns the thinking text and the remaining content.
 */
export function extractThinking(raw: string): { thinking: string; rest: string } {
  const match = raw.match(/<think>([\s\S]*?)<\/think>/);
  if (match) {
    const thinking = match[1].trim();
    const rest = raw.slice(match.index! + match[0].length).trim();
    return { thinking, rest };
  }
  return { thinking: '', rest: raw };
}

export function parseAIDecision(raw: string): AIDecision & { thinking?: string } {
  const { thinking, rest } = extractThinking(raw);
  const jsonStr = extractJson(rest || raw);
  const parsed = JSON.parse(jsonStr);
  // Clean null values in params before validation
  if (parsed.params && typeof parsed.params === 'object') {
    parsed.params = stripNulls(parsed.params);
    // If params is now empty or all fields removed, set to null
    if (Object.keys(parsed.params).length === 0) {
      parsed.params = null;
    }
  }
  const decision = AIDecisionSchema.parse(parsed);
  return thinking ? { ...decision, thinking } : decision;
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

export function parseStrategicOutput(raw: string): StrategicOutput & { thinking?: string } {
  const { thinking, rest } = extractThinking(raw);
  const jsonStr = extractJson(rest || raw);
  const parsed = JSON.parse(jsonStr);
  // Clean null values in plan before validation
  if (parsed.plan && typeof parsed.plan === 'object') {
    parsed.plan = stripNulls(parsed.plan);
  }
  const output = StrategicOutputSchema.parse(parsed);
  return thinking ? { ...output, thinking } : output;
}
