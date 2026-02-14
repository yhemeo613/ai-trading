import { aiChat } from '../ai/router';
import type { AIMessage } from '../ai/provider';
import type { Round1Opinion, Round2Response, ChairmanDecision } from './types';
import { ChairmanDecisionSchema } from './types';
import { logger } from '../utils/logger';
import { formatLimitsForPrompt, type DynamicRiskLimits } from '../risk/dynamic-limits';

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
  dynamicLimits?: DynamicRiskLimits,
  signal?: AbortSignal,
): Promise<ChairmanDecision> {
  const riskVeto = detectRiskVeto(round1, round2);

  const limitsBlock = dynamicLimits
    ? `\n${formatLimitsForPrompt(dynamicLimits)}\n根据账户分档动态调整仓位和杠杆，严格遵守以上限制。`
    : `- 小账户(<500U)：仓位15%-25%，杠杆8x-15x，果断重仓抓趋势
- 中账户(500-2000U)：仓位10%-18%，杠杆5x-10x
- 大账户(>2000U)：仓位5%-12%，杠杆3x-8x`;

  const systemPrompt = `你是交易圆桌会议主席，综合所有角色分析做出最终决策。你是日内交易决策者，追求快速捕捉短期机会。

角色权重: 技术分析师0.30, 首席策略师0.20, 执行交易员0.20, 情绪分析师0.15, 风险经理0.10, 投资组合经理0.05

共识级别: unanimous=全票一致, strong_majority=4-5/6高置信, majority=4/6, split=接近平分, overruled=风险经理否决

决策原则:
- 综合所有角色意见，按权重加权判断方向
- 风险经理否决权仅限极端情况（熔断器触发、连亏5+、杠杆超限）
${limitsBlock}
- 做多和做空完全对等，空头趋势明确时果断做空，多头趋势明确时果断做多
- 日内交易核心：有3个以上角色方向一致就应果断执行，不要过度等待完美信号
- 只有在所有信号真正矛盾、完全无法判断方向时才HOLD
- 短期趋势+动量+订单簿方向一致 = 立即执行，不需要所有周期完美共振
- 宁可小仓位试错，也不要反复HOLD错过行情
- 空头信号同样重要：EMA空头排列+下跌动量 = 果断做空，不要有多头偏好
${riskVeto ? '⚠️ 风险经理已行使否决权（极端风险）' : ''}

⚠️ 重要：action字段必须与reasoning一致。分析看空→SHORT，分析看多→LONG。只有真正无法判断时才HOLD。

当决策为HOLD时，你必须额外输出keyPriceLevels(关键价格点位)用于后续监控。
每个点位:
- price: 具体价格
- type: "resistance"(压力位) | "support"(支撑位) | "reversal"(反转点) | "breakout"(突破点) | "breakdown"(跌破点)
- triggerRadius: 触发半径(日内交易应设置较小的触发半径，通常为价格的0.05%-0.2%)
- direction: "LONG" | "SHORT" | null
- reasoning: 为什么这个点位重要
- confidence: 0-1
- invalidationPrice: 可选，失效价格

输出3-6个关键点位，覆盖上方和下方。

返回严格JSON:
{"action":"SHORT|LONG|CLOSE|HOLD|ADJUST|ADD|REDUCE","confidence":0-1,"reasoning":"中文综合分析","consensusLevel":"unanimous|strong_majority|majority|split|overruled","keyDebatePoints":["点1","点2"],"dissent":"少数派意见","riskManagerVerdict":"风险经理意见","params":{"positionSizePercent":num,"leverage":num,"stopLossPrice":num,"takeProfitPrice":num,"orderType":"MARKET|LIMIT"},"marketRegime":"trending_up|trending_down|ranging|volatile|quiet","keyPriceLevels":[{"price":0,"type":"support","triggerRadius":0,"direction":"SHORT","reasoning":"原因","confidence":0.8,"invalidationPrice":0}]}`;

  const balanceTier = dynamicLimits?.tierLabel ?? (totalBalance < 500 ? '小账户' : totalBalance < 2000 ? '中账户' : '大账户');
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
