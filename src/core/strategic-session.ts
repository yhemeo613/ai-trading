import { aiChat } from '../ai/router';
import { AIMessage } from '../ai/provider';
import { config } from '../config';
import { MarketRegime, StrategicOutput, parseStrategicOutput } from './decision';
import { MarketNarrative } from '../analysis/narrative';
import { TechnicalIndicators, formatIndicators } from '../analysis/indicators';
import { formatPlansForPrompt, getActivePlan } from './trading-plan';
import { buildMemoryContext } from '../memory/memory-context';
import { formatForPrompt as formatSessionEvents } from '../memory/session-context';
import { logger } from '../utils/logger';

// ─── Types ───────────────────────────────────────────────────────

export interface StrategicContext {
  symbol: string;
  marketRegime: MarketRegime;
  bias: 'bullish' | 'bearish' | 'neutral';
  reasoning: string;
  thinking: string;
  narrative: MarketNarrative;
  plan?: StrategicOutput['plan'];
  fetchedAt: number;
  aiProvider: string;
  aiModel: string;
}

// ─── Cache ───────────────────────────────────────────────────────

const strategicCache: Map<string, StrategicContext> = new Map();
const STRATEGIC_INTERVAL = 3 * 60 * 1000; // 3 minutes

export function getCachedStrategicContext(symbol: string): StrategicContext | undefined {
  return strategicCache.get(symbol);
}

export function clearStrategicCache() {
  strategicCache.clear();
}

export function shouldRunStrategicAnalysis(
  symbol: string,
  narrativeShift?: string,
  regimeChanged?: boolean,
): boolean {
  const cached = strategicCache.get(symbol);
  if (!cached) return true;
  if (Date.now() - cached.fetchedAt > STRATEGIC_INTERVAL) return true;
  if (regimeChanged) return true;
  // Only trigger on significant narrative shifts (trend direction changes)
  if (narrativeShift) {
    const significantActions = ['strong_uptrend', 'strong_downtrend', 'pullback_in_uptrend', 'bounce_in_downtrend'];
    const mentionsSignificant = significantActions.some((a) => narrativeShift.includes(a));
    if (mentionsSignificant) return true;
    // Minor shifts (consolidating, testing_support/resistance, neutral) are ignored
    return false;
  }
  return false;
}

// ─── Prompt Building ─────────────────────────────────────────────

function buildStrategicSystemPrompt(): string {
  return `你是顶级交易策略师，分析大周期市场结构并制定交易计划。先思考再回答JSON。

## 决策框架
1. 1h确定大方向（趋势、关键位、环境）→ 15m确定结构（回调、形态、动量）
2. 趋势明确时敢于行动，宁可途中入场也不错过行情
3. 做多做空完全对等，EMA空头+ADX>25→bearish

## 计划规则
- 每币种最多1个活跃计划，盈亏比≥1.5:1
- 入场区间基于支撑/阻力位，宽度1%-3%，应覆盖当前价格附近
- 不明朗→NONE，已有计划→MAINTAIN或INVALIDATE

## 市场环境
- trending_up: EMA多头+ADX>25→做多
- trending_down: EMA空头+ADX>25→做空
- ranging: ADX<20→高抛低吸
- volatile: ATR%>2%→缩小仓位
- quiet: ATR%<0.5%→观望

返回JSON:
{"marketRegime":"trending_up|trending_down|ranging|volatile|quiet","bias":"bullish|bearish|neutral","reasoning":"中文","plan":{"action":"CREATE|MAINTAIN|INVALIDATE|NONE","direction":"LONG|SHORT","entryCondition":"","entryZoneLow":0,"entryZoneHigh":0,"targets":[{"price":0,"percent":0}],"stopLoss":0,"invalidation":"","invalidationPrice":0,"confidence":0.0,"thesis":""}}`;
}

function buildStrategicUserPrompt(
  symbol: string,
  narrative: MarketNarrative,
  indicators: { [tf: string]: TechnicalIndicators },
  memoryContext: string,
  sessionEvents: string,
  existingPlans: string,
  currentPrice: number,
): string {
  // Only include 15m and 1h indicators for strategic analysis
  const indicatorTexts: string[] = [];
  if (indicators['15m']) indicatorTexts.push(formatIndicators('15m', indicators['15m']));
  if (indicators['1h']) indicatorTexts.push(formatIndicators('1h', indicators['1h']));

  return `交易对: ${symbol}
当前价格: ${currentPrice}
时间: ${new Date().toISOString().slice(0, 19)} UTC

${narrative.formatted}

${indicatorTexts.join('\n\n')}

${sessionEvents}

${existingPlans}

${memoryContext}

请分析大周期市场结构，评估现有计划或制定新计划。
如果市场不明朗，plan.action 选择 NONE。
制定计划时，入场区间要务实，应覆盖当前价格附近的合理范围（1%-3%），不要设置过远的理想入场价。`;
}

// ─── Main Entry ──────────────────────────────────────────────────

export async function runStrategicAnalysis(
  symbol: string,
  narrative: MarketNarrative,
  indicators: { [tf: string]: TechnicalIndicators },
  currentPrice: number,
  signal?: AbortSignal,
): Promise<StrategicContext> {
  const memoryContext = buildMemoryContext(symbol);
  const sessionEvents = formatSessionEvents(symbol);
  const existingPlans = formatPlansForPrompt(symbol, currentPrice);

  const messages: AIMessage[] = [
    { role: 'system', content: buildStrategicSystemPrompt() },
    {
      role: 'user',
      content: buildStrategicUserPrompt(
        symbol, narrative, indicators, memoryContext,
        sessionEvents, existingPlans, currentPrice,
      ),
    },
  ];

  const response = await aiChat(messages, config.ai.strategicProvider || undefined, config.ai.tacticalProvider || undefined, signal);
  logger.info(`${symbol} 战略分析响应来自 ${response.provider}/${response.model}`);

  const output = parseStrategicOutput(response.content);

  const context: StrategicContext = {
    symbol,
    marketRegime: output.marketRegime,
    bias: output.bias,
    reasoning: output.reasoning,
    thinking: output.thinking || '',
    narrative,
    plan: output.plan,
    fetchedAt: Date.now(),
    aiProvider: response.provider,
    aiModel: response.model,
  };

  strategicCache.set(symbol, context);
  return context;
}
