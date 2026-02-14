import { logger } from '../utils/logger';
import { broadcast } from '../dashboard/websocket';
import { getRoundtableConfig } from './config';
import { insertDiscussion } from './discussion-log';
import { runChairmanSynthesis } from './moderator';
import { ChiefStrategist } from './roles/chief-strategist';
import { TechnicalAnalyst } from './roles/technical-analyst';
import { RiskManager } from './roles/risk-manager';
import { ExecutionTrader } from './roles/execution-trader';
import { SentimentAnalyst } from './roles/sentiment-analyst';
import { PortfolioManager } from './roles/portfolio-manager';
import { DEFAULT_ROLE_WEIGHTS } from './types';
import type { BaseRole } from './roles/base-role';
import type {
  ChairmanDecision,
  DiscussionDepth,
  Round1Opinion,
  Round2Response,
  RoundtableSessionInput,
  RoundtableSessionResult,
  Stance,
} from './types';

function generateSessionId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `rt-${ts}-${rand}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时 (${ms}ms)`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

interface RoleTiming {
  role: string;
  round: 'R1' | 'R2' | 'chairman';
  durationMs: number;
  status: 'ok' | 'failed' | 'timeout';
}

async function withTiming<T>(
  promise: Promise<T>,
  timeoutMs: number,
  role: string,
  round: 'R1' | 'R2' | 'chairman',
): Promise<{ value: T; timing: RoleTiming }> {
  const start = Date.now();
  try {
    const value = await withTimeout(promise, timeoutMs, `${role} ${round}`);
    return { value, timing: { role, round, durationMs: Date.now() - start, status: 'ok' } };
  } catch (err) {
    const durationMs = Date.now() - start;
    const isTimeout = err instanceof Error && err.message.includes('超时');
    throw Object.assign(err as Error, {
      timing: { role, round, durationMs, status: isTimeout ? 'timeout' : 'failed' } as RoleTiming,
    });
  }
}

function createRoles(): BaseRole[] {
  const cfg = getRoundtableConfig();
  const roles: BaseRole[] = [
    new ChiefStrategist(),
    new TechnicalAnalyst(),
    new RiskManager(),
    new ExecutionTrader(),
    new SentimentAnalyst(),
    new PortfolioManager(),
  ];

  for (const role of roles) {
    const provider = cfg.roleProviders[role.roleId];
    if (provider) role.setProvider(provider);
  }

  return roles;
}

export function determineDepth(
  hasPosition: boolean,
  configDepth: DiscussionDepth,
  allowDeep: boolean,
): DiscussionDepth {
  if (configDepth === 'deep' && allowDeep) return 'deep';
  if (hasPosition) return 'quick';
  return configDepth === 'quick' ? 'quick' : 'standard';
}

/**
 * Check if Round 1 opinions are unanimous (all same direction).
 * Returns the unanimous stance or null if split.
 */
function checkUnanimous(opinions: Round1Opinion[]): Stance | null {
  if (opinions.length < 3) return null;
  const stances = opinions.map((o) => o.stance);
  const first = stances[0];
  return stances.every((s) => s === first) ? first : null;
}

/**
 * Fallback: build a ChairmanDecision from weighted Round 1 voting.
 * Used when chairman AI call fails.
 */
function fallbackWeightedVote(symbol: string, round1: Round1Opinion[]): ChairmanDecision {
  const weightMap = new Map(DEFAULT_ROLE_WEIGHTS.map((w) => [w.role, w.weight]));

  // Tally weighted votes per stance
  const stanceScores = new Map<string, number>();
  for (const opinion of round1) {
    const weight = weightMap.get(opinion.role) ?? 0.1;
    const score = weight * opinion.confidence;
    stanceScores.set(opinion.stance, (stanceScores.get(opinion.stance) ?? 0) + score);
  }

  // Find winning stance
  let bestStance: Stance = 'HOLD';
  let bestScore = 0;
  for (const [stance, score] of stanceScores) {
    if (score > bestScore) {
      bestScore = score;
      bestStance = stance as Stance;
    }
  }

  // Aggregate params from roles that voted for the winning stance
  const winningOpinions = round1.filter((o) => o.stance === bestStance);
  const avgConfidence = winningOpinions.reduce((s, o) => s + o.confidence, 0) / winningOpinions.length;

  // Collect suggested params
  let params: ChairmanDecision['params'] = null;
  const paramsOpinions = winningOpinions.filter((o) => o.suggestedParams);
  if (paramsOpinions.length > 0) {
    const avg = (arr: (number | null | undefined)[]) => {
      const valid = arr.filter((v): v is number => v != null);
      return valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : undefined;
    };
    params = {
      positionSizePercent: avg(paramsOpinions.map((o) => o.suggestedParams?.positionSizePercent)),
      leverage: avg(paramsOpinions.map((o) => o.suggestedParams?.leverage)),
      stopLossPrice: avg(paramsOpinions.map((o) => o.suggestedParams?.stopLoss)),
      takeProfitPrice: avg(paramsOpinions.map((o) => o.suggestedParams?.takeProfit)),
      orderType: 'MARKET' as const,
    };
  }

  const riskOpinion = round1.find((o) => o.role === 'risk-manager');

  return {
    action: bestStance,
    symbol,
    confidence: avgConfidence,
    reasoning: `加权投票回退: ${winningOpinions.map((o) => o.role).join(', ')} 支持 ${bestStance}`,
    consensusLevel: checkUnanimous(round1) ? 'unanimous' : winningOpinions.length >= 4 ? 'strong_majority' : 'majority',
    keyDebatePoints: round1.map((o) => `${o.role}: ${o.stance} (${o.confidence})`),
    riskManagerVerdict: riskOpinion?.reasoning ?? '风险经理未响应',
    params,
  };
}

/**
 * Run a full roundtable session for a symbol.
 */
export async function runRoundtableSession(
  input: RoundtableSessionInput,
  signal?: AbortSignal,
): Promise<RoundtableSessionResult> {
  const cfg = getRoundtableConfig();
  const sessionId = generateSessionId();
  const symbol = input.market.symbol;
  const startTime = Date.now();

  const hasPosition = input.account.positions.some((p: any) => p.symbol === symbol);
  const depth = determineDepth(hasPosition, cfg.defaultDepth, cfg.allowDeepMode);

  logger.info(`[圆桌] 会议开始: ${symbol}, 深度: ${depth}, 会话: ${sessionId}`);
  broadcast({ type: 'roundtable', data: { phase: 'start', symbol, sessionId, depth } });

  const roles = createRoles();
  const roleTimeout = cfg.roleTimeoutMs;
  const chairmanTimeout = cfg.chairmanTimeoutMs;

  // ─── Round 1: Independent Analysis (parallel with timeout) ──
  broadcast({ type: 'roundtable', data: { phase: 'round1_start', symbol, sessionId } });

  const timings: RoleTiming[] = [];

  const round1Results = await Promise.allSettled(
    roles.map((role) =>
      withTiming(role.analyzeRound1(input, signal), roleTimeout, role.roleId, 'R1')
    )
  );

  const round1: Round1Opinion[] = [];
  for (let i = 0; i < round1Results.length; i++) {
    const result = round1Results[i];
    if (result.status === 'fulfilled') {
      round1.push(result.value.value);
      timings.push(result.value.timing);
    } else {
      const timing = (result.reason as any)?.timing as RoleTiming | undefined;
      if (timing) timings.push(timing);
      logger.warn(`[圆桌] ${roles[i].roleName} R1 失败 (${timing?.durationMs ?? '?'}ms): ${result.reason?.message ?? result.reason}`);
    }
  }

  if (round1.length < cfg.quorum) {
    throw new Error(`圆桌会议法定人数不足: 需要 ${cfg.quorum}, 实际 ${round1.length}`);
  }

  logger.info(`[圆桌] R1 完成: ${round1.length}/${roles.length} 角色响应`);
  broadcast({ type: 'roundtable', data: {
    phase: 'round1_done', symbol, sessionId,
    opinions: round1.map((o) => ({ role: o.role, stance: o.stance, confidence: o.confidence })),
  }});

  // ─── Round 2: Debate (skip if unanimous or quick depth) ─────
  let round2: Round2Response[] | null = null;
  const unanimousStance = checkUnanimous(round1);

  if ((depth === 'standard' || depth === 'deep') && !unanimousStance) {
    broadcast({ type: 'roundtable', data: { phase: 'round2_start', symbol, sessionId } });

    const r2Roles = roles.filter((role) => round1.some((o) => o.role === role.roleId));
    const round2Results = await Promise.allSettled(
      r2Roles.map((role) =>
        withTiming(role.debateRound2(input, round1, signal), roleTimeout, role.roleId, 'R2')
      )
    );

    round2 = [];
    for (let i = 0; i < round2Results.length; i++) {
      const result = round2Results[i];
      if (result.status === 'fulfilled') {
        round2.push(result.value.value);
        timings.push(result.value.timing);
      } else {
        const timing = (result.reason as any)?.timing as RoleTiming | undefined;
        if (timing) timings.push(timing);
        logger.warn(`[圆桌] ${r2Roles[i].roleName} R2 失败 (${timing?.durationMs ?? '?'}ms): ${result.reason?.message ?? result.reason}`);
      }
    }

    logger.info(`[圆桌] R2 完成: ${round2.length} 角色响应`);
    broadcast({ type: 'roundtable', data: {
      phase: 'round2_done', symbol, sessionId,
      responses: round2.map((r) => ({
        role: r.role, revisedStance: r.revisedStance,
        finalConfidence: r.finalConfidence, stanceChanged: r.stanceChanged,
      })),
    }});
  } else if (unanimousStance) {
    logger.info(`[圆桌] R1 全票一致 (${unanimousStance})，跳过辩论轮`);
  }

  // ─── Chairman Synthesis (with fallback to weighted voting) ──
  broadcast({ type: 'roundtable', data: { phase: 'chairman_start', symbol, sessionId } });

  let chairmanDecision: ChairmanDecision;
  const chairmanStart = Date.now();
  try {
    chairmanDecision = await withTimeout(
      runChairmanSynthesis(symbol, round1, round2, input.account.balance.totalBalance, signal),
      chairmanTimeout,
      '主席综合决策',
    );
    timings.push({ role: 'chairman', round: 'chairman', durationMs: Date.now() - chairmanStart, status: 'ok' });
  } catch (err) {
    timings.push({ role: 'chairman', round: 'chairman', durationMs: Date.now() - chairmanStart, status: 'failed' });
    logger.warn(`[圆桌] 主席决策失败，使用加权投票回退: ${err instanceof Error ? err.message : String(err)}`);
    chairmanDecision = fallbackWeightedVote(symbol, round1);
  }

  const durationMs = Date.now() - startTime;

  logger.info(`[圆桌] 主席决策: ${chairmanDecision.action} (置信度: ${chairmanDecision.confidence}, 共识: ${chairmanDecision.consensusLevel}), 耗时: ${durationMs}ms`);
  logger.info(`[圆桌] 角色耗时: ${timings.map((t) => `${t.role}/${t.round}=${t.durationMs}ms(${t.status})`).join(', ')}`);
  broadcast({ type: 'roundtable', data: {
    phase: 'done', symbol, sessionId,
    action: chairmanDecision.action,
    confidence: chairmanDecision.confidence,
    consensusLevel: chairmanDecision.consensusLevel,
    durationMs,
  }});

  const result: RoundtableSessionResult = {
    sessionId,
    symbol,
    depth,
    round1,
    round2,
    chairmanDecision,
    consensusLevel: chairmanDecision.consensusLevel,
    durationMs,
  };

  try {
    insertDiscussion({
      sessionId,
      symbol,
      depth,
      round1Json: JSON.stringify(round1),
      round2Json: round2 ? JSON.stringify(round2) : null,
      chairmanDecisionJson: JSON.stringify(chairmanDecision),
      consensusLevel: chairmanDecision.consensusLevel,
      durationMs,
      actionTaken: chairmanDecision.action,
      timingsJson: JSON.stringify(timings),
    });
  } catch (err) {
    logger.warn('[圆桌] 讨论记录持久化失败', { error: err instanceof Error ? err.message : String(err) });
  }

  return result;
}
