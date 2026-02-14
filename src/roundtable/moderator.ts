import { aiChat } from '../ai/router';
import type { AIMessage } from '../ai/provider';
import type { Round1Opinion, Round2Response, ChairmanDecision } from './types';
import { ChairmanDecisionSchema } from './types';
import { logger } from '../utils/logger';

/**
 * Extract the first complete JSON object from a string.
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

function formatRound1ForChairman(opinions: Round1Opinion[]): string {
  return opinions.map((o) => {
    const params = o.suggestedParams
      ? ` | 参数: SL=${o.suggestedParams.stopLoss ?? '-'} TP=${o.suggestedParams.takeProfit ?? '-'} 仓位=${o.suggestedParams.positionSizePercent ?? '-'}% 杠杆=${o.suggestedParams.leverage ?? '-'}x`
      : '';
    return `[${o.role}] ${o.stance}(${o.confidence}) ${o.keyPoints.join('; ')}${params}`;
  }).join('\n');
}

function formatRound2ForChairman(responses: Round2Response[]): string {
  return responses.map((r) => {
    const changed = r.stanceChanged ? `←改` : '';
    const challenges = r.challenges.length > 0
      ? ` 质疑: ${r.challenges.map((c) => `[${c.severity}]${c.toRole}:${c.challenge}`).join('; ')}`
      : '';
    return `[${r.role}] ${r.revisedStance}(${r.finalConfidence})${changed} ${r.finalReasoning}${challenges}`;
  }).join('\n');
}

function detectRiskVeto(round1: Round1Opinion[], round2: Round2Response[] | null): boolean {
  // Check Round 2 first (more recent opinion)
  if (round2) {
    const riskR2 = round2.find((r) => r.role === 'risk-manager');
    if (riskR2) {
      return riskR2.revisedStance === 'HOLD' &&
        riskR2.challenges.some((c) => c.severity === 'critical');
    }
  }
  // Fallback to Round 1
  const riskR1 = round1.find((o) => o.role === 'risk-manager');
  if (riskR1) {
    return riskR1.stance === 'HOLD' &&
      riskR1.keyPoints.some((p) => p.includes('一票否决'));
  }
  return false;
}

export async function runChairmanSynthesis(
  symbol: string,
  round1: Round1Opinion[],
  round2: Round2Response[] | null,
  totalBalance: number,
  signal?: AbortSignal,
): Promise<ChairmanDecision> {
  const riskVeto = detectRiskVeto(round1, round2);

  const systemPrompt = `你是交易圆桌会议主席，综合所有角色分析做出最终决策。

角色权重: 首席策略师0.25, 技术分析师0.25, 风险经理0.20, 执行交易员0.10, 情绪分析师0.10, 投资组合经理0.10

共识级别: unanimous=全票一致, strong_majority=4-5/6高置信, majority=4/6, split=接近平分, overruled=风险经理否决

决策原则:
- 多数角色方向一致时果断决策，不因少数保守意见HOLD
- 风险经理否决权仅限极端情况（熔断器触发、连亏5+、杠杆超限）
- 小余额≠不交易，小账户更需要抓住趋势机会，用合理仓位积极参与
- 小账户(<500U)：仓位15%-25%，杠杆8x-15x，果断重仓抓趋势
- 中账户(500-2000U)：仓位10%-18%，杠杆5x-10x
- 大账户(>2000U)：仓位5%-12%，杠杆3x-8x
- 趋势明确时果断>完美，不要因为部分角色说HOLD就放弃明确的趋势机会
- 如果reasoning中认为应该做多/做空，action就必须是LONG/SHORT，绝对不能reasoning说做多但action写HOLD
- HOLD只用于真正没有方向或风险极端的情况，不是"谨慎"的默认选项
${riskVeto ? '⚠️ 风险经理已行使否决权（极端风险）' : ''}

⚠️ 重要：action字段必须与reasoning一致。如果你的分析结论是应该做多，action必须是LONG而不是HOLD。

返回严格JSON:
{"action":"LONG|SHORT|CLOSE|HOLD|ADJUST|ADD|REDUCE","confidence":0-1,"reasoning":"中文综合分析","consensusLevel":"unanimous|strong_majority|majority|split|overruled","keyDebatePoints":["点1","点2"],"dissent":"少数派意见","riskManagerVerdict":"风险经理意见","params":{"positionSizePercent":num,"leverage":num,"stopLossPrice":num,"takeProfitPrice":num,"orderType":"MARKET|LIMIT"},"marketRegime":"trending_up|trending_down|ranging|volatile|quiet"}`;

  const balanceTier = totalBalance < 500 ? '小账户' : totalBalance < 2000 ? '中账户' : '大账户';
  let userContent = `交易对: ${symbol} | 账户: ${totalBalance.toFixed(0)}U (${balanceTier})\n\n`;
  userContent += `═══ 第一轮：独立分析 ═══\n${formatRound1ForChairman(round1)}\n\n`;
  if (round2) {
    userContent += `═══ 第二轮：辩论与质疑 ═══\n${formatRound2ForChairman(round2)}\n\n`;
  }
  userContent += `请综合以上讨论，做出最终交易决策。`;

  const messages: AIMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  const response = await aiChat(messages, undefined, undefined, signal);
  logger.info(`[圆桌] 主席决策响应来自 ${response.provider}/${response.model}`);

  const json = extractJson(response.content);
  const parsed = JSON.parse(json);
  parsed.symbol = symbol;
  // Normalize action stance
  if (parsed.action) {
    const upper = String(parsed.action).toUpperCase().trim();
    const validStances = ['LONG', 'SHORT', 'HOLD', 'CLOSE', 'ADJUST', 'ADD', 'REDUCE'];
    if (!validStances.includes(upper)) {
      if (upper.includes('LONG') || upper.includes('BUY')) parsed.action = 'LONG';
      else if (upper.includes('SHORT') || upper.includes('SELL')) parsed.action = 'SHORT';
      else if (upper.includes('CLOSE') || upper.includes('EXIT')) parsed.action = 'CLOSE';
      else if (upper.includes('ADD')) parsed.action = 'ADD';
      else if (upper.includes('REDUCE') || upper.includes('TRIM')) parsed.action = 'REDUCE';
      else if (upper.includes('ADJUST')) parsed.action = 'ADJUST';
      else parsed.action = 'HOLD';
    } else {
      parsed.action = upper;
    }
  }
  // Strip nulls from params (AI often returns null for optional numeric fields)
  if (parsed.params && typeof parsed.params === 'object') {
    for (const key of Object.keys(parsed.params)) {
      if (parsed.params[key] === null) delete parsed.params[key];
    }
    if (Object.keys(parsed.params).length === 0) parsed.params = null;
  }
  // Normalize marketRegime to valid enum values
  const validRegimes = ['trending_up', 'trending_down', 'ranging', 'volatile', 'quiet'];
  if (parsed.marketRegime && !validRegimes.includes(parsed.marketRegime)) {
    const raw = String(parsed.marketRegime).toLowerCase();
    if (raw.includes('trending_up') || raw.includes('bullish')) parsed.marketRegime = 'trending_up';
    else if (raw.includes('trending_down') || raw.includes('bearish')) parsed.marketRegime = 'trending_down';
    else if (raw.includes('volatile')) parsed.marketRegime = 'volatile';
    else if (raw.includes('quiet')) parsed.marketRegime = 'quiet';
    else parsed.marketRegime = 'ranging';
  }
  return ChairmanDecisionSchema.parse(parsed);
}
