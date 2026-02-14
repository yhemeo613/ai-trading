import { z } from 'zod';
import { MarketRegimeSchema } from '../core/decision';

// ─── Stance ─────────────────────────────────────────────────────

export const StanceSchema = z.enum([
  'LONG', 'SHORT', 'HOLD', 'CLOSE', 'ADJUST', 'ADD', 'REDUCE',
]);
export type Stance = z.infer<typeof StanceSchema>;

// ─── Round 1: Independent Analysis ─────────────────────────────

export const Round1OpinionSchema = z.object({
  role: z.string(),
  stance: StanceSchema,
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  keyPoints: z.array(z.string()),
  suggestedParams: z.object({
    entryPrice: z.number().nullable().optional(),
    stopLoss: z.number().nullable().optional(),
    takeProfit: z.number().nullable().optional(),
    positionSizePercent: z.number().nullable().optional(),
    leverage: z.number().nullable().optional(),
  }).nullable().optional(),
});
export type Round1Opinion = z.infer<typeof Round1OpinionSchema>;

// ─── Round 2: Debate & Challenge ────────────────────────────────

export const Round2ResponseSchema = z.object({
  role: z.string(),
  revisedStance: StanceSchema,
  finalConfidence: z.number().min(0).max(1),
  stanceChanged: z.boolean(),
  changeReason: z.string().optional(),
  agreements: z.array(z.object({
    withRole: z.string(),
    point: z.string(),
  })),
  challenges: z.array(z.object({
    toRole: z.string(),
    challenge: z.string(),
    severity: z.enum(['minor', 'major', 'critical']),
  })),
  finalReasoning: z.string(),
});
export type Round2Response = z.infer<typeof Round2ResponseSchema>;

// ─── Chairman Decision ──────────────────────────────────────────

export const ConsensusLevelSchema = z.enum([
  'unanimous', 'strong_majority', 'majority', 'split', 'overruled',
]);
export type ConsensusLevel = z.infer<typeof ConsensusLevelSchema>;

export const ChairmanDecisionSchema = z.object({
  action: StanceSchema,
  symbol: z.string(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  consensusLevel: ConsensusLevelSchema,
  keyDebatePoints: z.array(z.string()),
  dissent: z.string().nullable().optional(),
  riskManagerVerdict: z.string(),
  params: z.object({
    positionSizePercent: z.number().nullable().optional(),
    leverage: z.number().nullable().optional(),
    stopLossPrice: z.number().nullable().optional(),
    takeProfitPrice: z.number().nullable().optional(),
    orderType: z.enum(['MARKET', 'LIMIT']).nullable().optional(),
  }).nullable(),
  marketRegime: MarketRegimeSchema.optional(),
});
export type ChairmanDecision = z.infer<typeof ChairmanDecisionSchema>;

// ─── Discussion Depth ───────────────────────────────────────────

export type DiscussionDepth = 'quick' | 'standard' | 'deep';

// ─── Role Definition ────────────────────────────────────────────

export interface RoleWeight {
  role: string;
  weight: number;
}

export const DEFAULT_ROLE_WEIGHTS: RoleWeight[] = [
  { role: 'chief-strategist', weight: 0.25 },
  { role: 'technical-analyst', weight: 0.25 },
  { role: 'risk-manager', weight: 0.20 },
  { role: 'execution-trader', weight: 0.10 },
  { role: 'sentiment-analyst', weight: 0.10 },
  { role: 'portfolio-manager', weight: 0.10 },
];

// ─── Session Context (shared data passed to all roles) ──────────

export interface RoundtableMarketData {
  symbol: string;
  currentPrice: number;
  indicators: { [tf: string]: any };
  orderbook: any;
  sentiment: any;
  narrative: any;
  fundingRate: number | null;
  ticker: { last: number; percentage: number; volume: number; quoteVolume: number };
}

export interface RoundtableAccountData {
  balance: { totalBalance: number; availableBalance: number; usedMargin: number };
  positions: any[];
  circuitBreakerState: any;
  streakInfo: { winStreak: number; lossStreak: number };
  dynamicLimits?: import('../risk/dynamic-limits').DynamicRiskLimits;
}

export interface RoundtableStrategyData {
  strategicContext: any;
  memoryContext: string;
  activePlan: any | null;
  positionOps: any[];
  positionThesis: string | null;
}

export interface RoundtableSessionInput {
  market: RoundtableMarketData;
  account: RoundtableAccountData;
  strategy: RoundtableStrategyData;
}

// ─── Session Result ─────────────────────────────────────────────

export interface RoundtableSessionResult {
  sessionId: string;
  symbol: string;
  depth: DiscussionDepth;
  round1: Round1Opinion[];
  round2: Round2Response[] | null;
  chairmanDecision: ChairmanDecision;
  consensusLevel: ConsensusLevel;
  durationMs: number;
}

// ─── Discussion Record (for DB persistence) ─────────────────────

export interface DiscussionRecord {
  sessionId: string;
  symbol: string;
  depth: string;
  round1Json: string;
  round2Json: string | null;
  chairmanDecisionJson: string;
  consensusLevel: string;
  durationMs: number;
  actionTaken: string;
  timingsJson?: string | null;
}
