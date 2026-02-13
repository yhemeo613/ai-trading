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

export function parseAIDecision(raw: string): AIDecision {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in AI response');
  const parsed = JSON.parse(jsonMatch[0]);
  return AIDecisionSchema.parse(parsed);
}

export function parsePairSelection(raw: string): PairSelection {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in AI response');
  const parsed = JSON.parse(jsonMatch[0]);
  return PairSelectionSchema.parse(parsed);
}

export function parsePortfolioReview(raw: string): PortfolioReview {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in AI response');
  const parsed = JSON.parse(jsonMatch[0]);
  return PortfolioReviewSchema.parse(parsed);
}
