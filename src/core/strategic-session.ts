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
  narrative: MarketNarrative;
  plan?: StrategicOutput['plan'];
  fetchedAt: number;
  aiProvider: string;
  aiModel: string;
}

// ─── Cache ───────────────────────────────────────────────────────

const strategicCache: Map<string, StrategicContext> = new Map();
const STRATEGIC_INTERVAL = 5 * 60 * 1000; // 5 minutes

export function getCachedStrategicContext(symbol: string): StrategicContext | undefined {
  return strategicCache.get(symbol);
}

export function shouldRunStrategicAnalysis(
  symbol: string,
  narrativeShift?: string,
  regimeChanged?: boolean,
): boolean {
  const cached = strategicCache.get(symbol);
  if (!cached) return true;
  if (Date.now() - cached.fetchedAt > STRATEGIC_INTERVAL) return true;
  if (narrativeShift) return true;
  if (regimeChanged) return true;
  return false;
}

// ─── Prompt Building ─────────────────────────────────────────────

function buildStrategicSystemPrompt(): string {
  return `你是一位顶级交易策略师。你的任务是分析大周期市场结构，制定交易计划。

## 决策框架
1. 先看1h确定大方向（趋势、关键位、市场环境）
2. 再看15m确定结构（回调位置、形态、动量）
3. 趋势明确时要敢于行动，不要过度等待"完美"入场点
4. 宁可在趋势中途入场，也不要错过整段行情
5. 做多和做空是完全对等的操作，下跌趋势中做空和上涨趋势中做多一样正常

## 交易计划规则
- 每个币种最多1个活跃计划
- 计划必须包含：方向、入场条件、入场区间、目标、止损、失效条件
- 如果市场不明朗，选择 NONE（不制定计划）
- 已有计划时，评估是否 MAINTAIN（维持）或 INVALIDATE（失效）
- 计划的盈亏比至少 1.5:1
- 入场区间应基于关键支撑/阻力位
- 下跌趋势中应该制定 SHORT 计划，不要只会做多

## 入场区间设置（重要）
- 入场区间必须设置得足够宽，覆盖当前价格附近合理范围
- 入场区间宽度建议为当前价格的 1%-3%
- 如果趋势明确且当前价格已在合理位置，入场区间应包含当前价格
- 不要设置过于理想化的入场价，市场不会总是回调到你想要的位置
- 例如：当前价 100，看多，合理入场区间是 97-101，而不是 90-92

## 市场环境识别
- trending_up: EMA多头排列，ADX>25 → 优先做多
- trending_down: EMA空头排列，ADX>25 → 优先做空，反弹到阻力位是做空机会
- ranging: ADX<20，高抛低吸，上沿做空下沿做多
- volatile: ATR%>2%，缩小仓位
- quiet: ATR%<0.5%，观望为主

## 方向偏好（重要）
- bullish: 看涨，制定 LONG 计划
- bearish: 看跌，制定 SHORT 计划。EMA空头排列、价格持续走低、MACD死叉等都是看跌信号
- neutral: 方向不明，可以选择 NONE 或在区间边缘制定计划
- 不要害怕给出 bearish 判断，下跌趋势做空是正确的交易行为
- 如果 EMA 空头排列且 ADX>25，bias 应该是 bearish 而不是 neutral

返回严格JSON格式:
{
  "marketRegime": "trending_up|trending_down|ranging|volatile|quiet",
  "bias": "bullish|bearish|neutral",
  "reasoning": "中文分析思路",
  "plan": {
    "action": "CREATE|MAINTAIN|INVALIDATE|NONE",
    "direction": "LONG|SHORT",
    "entryCondition": "入场条件描述",
    "entryZoneLow": number,
    "entryZoneHigh": number,
    "targets": [{"price": number, "percent": number}],
    "stopLoss": number,
    "invalidation": "失效条件描述",
    "invalidationPrice": number,
    "confidence": 0.0-1.0,
    "thesis": "交易论点"
  }
}`;
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

  const response = await aiChat(messages, config.ai.strategicProvider || undefined, config.ai.tacticalProvider || undefined);
  logger.info(`${symbol} 战略分析响应来自 ${response.provider}/${response.model}`);

  const output = parseStrategicOutput(response.content);

  const context: StrategicContext = {
    symbol,
    marketRegime: output.marketRegime,
    bias: output.bias,
    reasoning: output.reasoning,
    narrative,
    plan: output.plan,
    fetchedAt: Date.now(),
    aiProvider: response.provider,
    aiModel: response.model,
  };

  strategicCache.set(symbol, context);
  return context;
}
