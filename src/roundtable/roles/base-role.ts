import { aiChat } from '../../ai/router';
import type { AIMessage } from '../../ai/provider';
import type { Round1Opinion, Round2Response, RoundtableSessionInput } from '../types';
import { Round1OpinionSchema, Round2ResponseSchema } from '../types';
import { logger } from '../../utils/logger';

/**
 * Extract the first complete JSON object from a string by tracking brace depth.
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
    if (ch === '}') { depth--; if (depth === 0) return raw.slice(start, i + 1); }
  }
  throw new Error('AI 响应中 JSON 不完整');
}

/**
 * Strip null values from an object (shallow), converting them to undefined.
 * Handles AI responses that return null instead of omitting optional fields.
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
 * Normalize AI-returned stance to valid enum values.
 * AI models sometimes return creative variants like "STRONG_LONG", "CAUTIOUS_HOLD", etc.
 */
function normalizeStance(raw: string): string {
  const validStances = ['LONG', 'SHORT', 'HOLD', 'CLOSE', 'ADJUST', 'ADD', 'REDUCE'];
  const upper = String(raw).toUpperCase().trim();
  if (validStances.includes(upper)) return upper;
  // Fuzzy match
  if (upper.includes('LONG') || upper.includes('BUY')) return 'LONG';
  if (upper.includes('SHORT') || upper.includes('SELL')) return 'SHORT';
  if (upper.includes('CLOSE') || upper.includes('EXIT')) return 'CLOSE';
  if (upper.includes('ADD') || upper.includes('INCREASE')) return 'ADD';
  if (upper.includes('REDUCE') || upper.includes('DECREASE') || upper.includes('TRIM')) return 'REDUCE';
  if (upper.includes('ADJUST')) return 'ADJUST';
  return 'HOLD'; // Default fallback
}

export abstract class BaseRole {
  abstract readonly roleName: string;
  abstract readonly roleId: string;

  /** Build the system prompt for this role */
  protected abstract buildSystemPrompt(): string;

  /** Build the user prompt for Round 1 (independent analysis) */
  protected abstract buildRound1Prompt(input: RoundtableSessionInput): string;

  /** Optional: which AI provider to use for this role */
  protected preferredProvider?: string;

  async analyzeRound1(input: RoundtableSessionInput, signal?: AbortSignal): Promise<Round1Opinion> {
    const messages: AIMessage[] = [
      { role: 'system', content: this.buildSystemPrompt() },
      { role: 'user', content: this.buildRound1Prompt(input) },
    ];

    const response = await aiChat(messages, this.preferredProvider, undefined, signal);
    logger.info(`[圆桌] ${this.roleName} R1 响应来自 ${response.provider}/${response.model}`);

    const json = extractJson(response.content);
    const parsed = JSON.parse(json);
    parsed.role = this.roleId;
    if (parsed.stance) parsed.stance = normalizeStance(parsed.stance);
    if (parsed.suggestedParams && typeof parsed.suggestedParams === 'object') {
      parsed.suggestedParams = stripNulls(parsed.suggestedParams);
      if (Object.keys(parsed.suggestedParams).length === 0) {
        delete parsed.suggestedParams;
      }
    }
    return Round1OpinionSchema.parse(parsed);
  }

  async debateRound2(
    input: RoundtableSessionInput,
    allRound1: Round1Opinion[],
    signal?: AbortSignal,
  ): Promise<Round2Response> {
    const myOpinion = allRound1.find((o) => o.role === this.roleId);
    const otherOpinions = allRound1.filter((o) => o.role !== this.roleId);

    // Find disagreements: roles with different stance
    const disagreements = otherOpinions.filter((o) => o.stance !== myOpinion?.stance);
    const agreements = otherOpinions.filter((o) => o.stance === myOpinion?.stance);

    const round1Summary = allRound1.map((o) =>
      `【${o.role}】立场: ${o.stance}, 置信度: ${o.confidence}\n  理由: ${o.reasoning}\n  关键论点: ${o.keyPoints.join('; ')}`
    ).join('\n\n');

    const disagreementSection = disagreements.length > 0
      ? `\n⚠️ 以下角色与你立场不同，你必须逐一回应他们的论点：\n${disagreements.map((o) =>
          `- ${o.role} 主张 ${o.stance}（置信度 ${o.confidence}）: ${o.keyPoints.join('; ')}`
        ).join('\n')}\n`
      : '';

    const agreementSection = agreements.length > 0
      ? `\n✓ 以下角色与你立场一致：${agreements.map((o) => o.role).join(', ')}\n`
      : '';

    // Round 2: only send market summary instead of full data
    const marketSummary = `交易对: ${input.market.symbol} | 价格: ${input.market.currentPrice} | 环境: ${input.strategy.strategicContext?.marketRegime ?? '未知'} | 偏好: ${input.strategy.strategicContext?.bias ?? '未知'}`;

    const messages: AIMessage[] = [
      { role: 'system', content: this.buildSystemPrompt() },
      {
        role: 'user',
        content: `${marketSummary}\n\n` +
          `═══ 第一轮所有角色观点 ═══\n${round1Summary}\n\n` +
          `你是 ${this.roleName}（${this.roleId}），你在第一轮的立场是: ${myOpinion?.stance ?? '未知'}\n` +
          agreementSection +
          disagreementSection +
          `\n## 辩论要求\n` +
          `1. 对每个与你不同立场的角色，必须在 challenges 中明确回应（不能为空）\n` +
          `2. 如果对方论点有道理，诚实修正你的立场（stanceChanged=true）\n` +
          `3. 如果坚持原立场，必须给出具体反驳理由\n` +
          `4. severity 评级: minor=细节分歧, major=方向性分歧, critical=致命缺陷\n\n` +
          `返回严格JSON:\n` +
          `{\n` +
          `  "role": "${this.roleId}",\n` +
          `  "revisedStance": "LONG|SHORT|HOLD|CLOSE|ADJUST|ADD|REDUCE",\n` +
          `  "finalConfidence": 0.0-1.0,\n` +
          `  "stanceChanged": true/false,\n` +
          `  "changeReason": "如果改变了立场，说明原因；如果坚持，说明为什么对方论点不成立",\n` +
          `  "agreements": [{"withRole": "角色ID", "point": "同意的具体观点"}],\n` +
          `  "challenges": [{"toRole": "角色ID", "challenge": "针对其论点的具体质疑或反驳", "severity": "minor|major|critical"}],\n` +
          `  "finalReasoning": "综合辩论后的最终分析"\n` +
          `}`,
      },
    ];

    const response = await aiChat(messages, this.preferredProvider, undefined, signal);
    logger.info(`[圆桌] ${this.roleName} R2 响应来自 ${response.provider}/${response.model}`);

    const json = extractJson(response.content);
    const parsed = JSON.parse(json);
    parsed.role = this.roleId;
    if (parsed.revisedStance) parsed.revisedStance = normalizeStance(parsed.revisedStance);
    return Round2ResponseSchema.parse(parsed);
  }

  setProvider(provider: string) {
    this.preferredProvider = provider;
  }
}
