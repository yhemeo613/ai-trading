import { aiChat } from '../ai/router';
import { AIMessage } from '../ai/provider';
import { config } from '../config';
import { AIDecision, parseAIDecision } from './decision';
import { StrategicContext } from './strategic-session';
import { MarketSnapshot } from '../exchange/market-data';
import { AccountBalance, PositionInfo } from '../exchange/account';
import { TechnicalIndicators, OrderbookAnalysis, MarketSentiment, formatIndicators, formatOrderbook, formatSentiment } from '../analysis/indicators';
import { formatPlansForPrompt, getActivePlan } from './trading-plan';
import { getPositionThesis } from '../persistence/models/position';
import { getStreakInfo } from '../risk/circuit-breaker';
import { getOpenPositionBySymbol } from '../persistence/models/position';
import { getPositionOperations } from '../persistence/models/position-ops';
import { logger } from '../utils/logger';

// ─── Types ───────────────────────────────────────────────────────

export interface TacticalSessionResult {
  decision: AIDecision;
  thinking: string;
  aiProvider: string;
  aiModel: string;
  indicatorsJson: string;
  orderbookJson: string;
  sentimentJson: string;
}

// ─── Prompt Building ─────────────────────────────────────────────

function buildTacticalSystemPrompt(): string {
  return `你是一位果断的交易执行者。战略分析师已经给出了大方向和交易计划。

## 回复格式
请先在 <think>...</think> 标签内写出你的完整思考过程（中文），包括：
1. 账户与仓位评估（余额、已有持仓、盈亏状况）
2. 战略上下文理解（大方向、计划、入场区间）
3. 短周期技术面分析（1m/5m 指标、K线形态、订单簿）
4. 最终决策理由

然后在标签外返回严格JSON。

## 你的任务
1. 判断当前是否适合执行计划
2. 如果持有仓位，评估入场论点是否仍然成立
3. 精确设定入场价、止损、止盈
4. 管理现有仓位（加仓/减仓/调整止损/平仓）

## 决策原则
- 趋势明确时要果断入场，不要过度等待完美价格
- 价格在入场区间内或接近入场区间（±1%）时，如果短周期有支撑信号就应该执行
- 不需要所有指标都完美对齐，大方向对 + 短周期不矛盾即可执行
- 论点失效时果断平仓
- 盈亏比至少 1.5:1
- 连续 HOLD 超过多轮后，如果大方向没变，应降低入场标准
- LONG 和 SHORT 是完全对等的操作，战略方向看空时应果断做空

## 入场判断（重要）
- 价格在入场区间内：只要短周期没有明显反向信号，就应该执行
- 价格接近入场区间（差距 <1%）：如果有任何短周期支撑信号就可以执行
- 价格远离入场区间（差距 >2%）：HOLD，等待回调
- 不要因为"等待更好的确认信号"而反复 HOLD，这会导致错过行情
- 做空和做多的入场逻辑完全一样，不要对 SHORT 有额外的犹豫

## 仓位管理
- 盈利 > 2% 且趋势延续时考虑 ADD（加仓30-50%）
- 亏损但出现微观反弹信号时考虑 REDUCE（减仓30-50%做T）
- 动态追踪止损保护利润

## 杠杆与仓位指导
- 杠杆范围: 2x-10x，根据市场环境和置信度调整
- 趋势明确 + 高置信度: 5x-10x
- 趋势不明确 / 震荡: 2x-5x
- 高波动环境: 2x-3x
- 仓位大小: 5%-15% 可用余额
- 不要使用 1x 杠杆，合约交易至少 2x 起步

## 决策优先级
有仓位: CLOSE > REDUCE > ADD > ADJUST > HOLD
无仓位（战略看多）: LONG > HOLD
无仓位（战略看空）: SHORT > HOLD
趋势明确时优先执行，不要因为是做空就额外犹豫

返回严格JSON格式:
{
  "action": "LONG|SHORT|CLOSE|HOLD|ADJUST|ADD|REDUCE",
  "symbol": "BTC/USDT:USDT",
  "confidence": 0.0-1.0,
  "reasoning": "中文简要说明",
  "marketRegime": "trending_up|trending_down|ranging|volatile|quiet",
  "params": {
    "positionSizePercent": number,
    "leverage": number,
    "stopLossPrice": number,
    "takeProfitPrice": number,
    "orderType": "MARKET|LIMIT",
    "addPercent": number,
    "reducePercent": number
  }
}`;
}

function buildTacticalUserPrompt(
  snapshot: MarketSnapshot,
  balance: AccountBalance,
  positions: PositionInfo[],
  strategicContext: StrategicContext,
  indicators: { [tf: string]: TechnicalIndicators },
  orderbook: OrderbookAnalysis,
  sentiment: MarketSentiment,
): string {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';

  // Strategic summary
  const strategicSummary = [
    `【战略上下文】`,
    `  市场环境: ${strategicContext.marketRegime}`,
    `  方向偏好: ${strategicContext.bias}`,
    `  战略分析: ${strategicContext.reasoning}`,
  ].join('\n');

  // Plans
  const plansStr = formatPlansForPrompt(snapshot.symbol, snapshot.ticker.last);

  // Position info
  const symbolPositions = positions.filter((p) => p.symbol === snapshot.symbol);
  let positionStr = '  无';
  let thesisStr = '';
  if (symbolPositions.length > 0) {
    positionStr = symbolPositions.map((p) => {
      const pnlPct = p.notional > 0 ? ((p.unrealizedPnl / (p.notional / p.leverage)) * 100).toFixed(2) : '0.00';
      return `  ${p.symbol} ${p.side === 'long' ? '多' : '空'} ${p.contracts} 张 @ ${p.entryPrice}, 标记价: ${p.markPrice}, 盈亏: ${p.unrealizedPnl.toFixed(2)} USDT (${pnlPct}%), 杠杆: ${p.leverage}x`;
    }).join('\n');

    // Position thesis
    const thesis = getPositionThesis(snapshot.symbol);
    if (thesis) {
      thesisStr = `\n  入场论点: ${thesis}\n  请评估此论点是否仍然成立。如果论点已失效，应考虑平仓。`;
    }
  }

  // Position operations context
  let posOpsStr = '';
  try {
    const dbPos = getOpenPositionBySymbol(snapshot.symbol);
    if (dbPos) {
      const ops = getPositionOperations(dbPos.id);
      if (ops.length > 0) {
        const lines = [`  加仓次数: ${dbPos.add_count ?? 0}/2, 做T次数: ${dbPos.reduce_count ?? 0}/3`];
        lines.push(`  当前均价: ${dbPos.avg_entry_price?.toFixed(2) ?? dbPos.entry_price?.toFixed(2) ?? 'N/A'}`);
        lines.push(`  做T累计节省: ${(dbPos.t_trade_savings ?? 0).toFixed(2)} USDT`);
        posOpsStr = '\n' + lines.join('\n');
      }
    }
  } catch { /* ignore */ }

  // Other positions summary
  const otherPositions = positions.filter((p) => p.symbol !== snapshot.symbol);
  const otherPosStr = otherPositions.length > 0
    ? otherPositions.map((p) => {
        const pnlPct = p.notional > 0 ? ((p.unrealizedPnl / (p.notional / p.leverage)) * 100).toFixed(2) : '0.00';
        return `  ${p.symbol} ${p.side === 'long' ? '多' : '空'} 盈亏: ${p.unrealizedPnl.toFixed(2)} USDT (${pnlPct}%)`;
      }).join('\n')
    : '  无';

  // Streak info
  const streak = getStreakInfo();
  const streakStr = streak.winStreak > 0
    ? `  当前连胜: ${streak.winStreak} 次`
    : streak.lossStreak > 0
    ? `  当前连败: ${streak.lossStreak} 次 → 建议缩小仓位`
    : '  无连胜/连败';

  // Only 1m and 5m indicators for tactical
  const indicatorTexts: string[] = [];
  if (indicators['1m']) indicatorTexts.push(formatIndicators('1m', indicators['1m']));
  if (indicators['5m']) indicatorTexts.push(formatIndicators('5m', indicators['5m']));

  // Recent klines (only 20 candles for tactical)
  const klines1m = formatRecentKlines(snapshot.klines['1m'], '1分钟K线', 20);
  const klines5m = formatRecentKlines(snapshot.klines['5m'], '5分钟K线', 20);

  return `当前时间: ${now}
交易对: ${snapshot.symbol}

${strategicSummary}

${plansStr}

账户状态:
  总余额: ${balance.totalBalance.toFixed(2)} USDT
  可用余额: ${balance.availableBalance.toFixed(2)} USDT

${streakStr}

当前币种持仓 (${snapshot.symbol}):
${positionStr}${thesisStr}${posOpsStr}

其他币种持仓:
${otherPosStr}

行情数据:
  最新价: ${snapshot.ticker.last}
  24h涨跌幅: ${snapshot.ticker.percentage?.toFixed(2)}%
  资金费率: ${snapshot.fundingRate !== null ? (snapshot.fundingRate * 100).toFixed(4) + '%' : '暂无'}

${indicatorTexts.join('\n\n')}

${formatOrderbook(orderbook)}

${formatSentiment(sentiment)}

${klines1m}

${klines5m}

请基于战略上下文和当前短周期数据，做出果断的执行决策。
如果价格在入场区间内或接近（±1%），且短周期没有明显反向信号，应该执行开仓。
不要因为追求完美入场点而反复 HOLD。趋势明确时，果断 > 完美。
如果持有仓位，优先评估仓位管理。`;
}

function formatRecentKlines(klines: any[][], label: string, count: number): string {
  if (!klines || !klines.length) return `${label}: 无数据`;
  const recent = klines.slice(-count);
  const lines = recent.map((k) => {
    const [ts, open, high, low, close, vol] = k;
    const date = new Date(ts).toISOString().slice(11, 19);
    return `  ${date} O:${open} H:${high} L:${low} C:${close} V:${vol}`;
  });
  return `${label} (最近 ${recent.length} 根):\n${lines.join('\n')}`;
}

// ─── Main Entry ──────────────────────────────────────────────────

export async function runTacticalExecution(
  snapshot: MarketSnapshot,
  balance: AccountBalance,
  positions: PositionInfo[],
  strategicContext: StrategicContext,
  allIndicators: { [tf: string]: TechnicalIndicators },
  orderbook: OrderbookAnalysis,
  sentiment: MarketSentiment,
  signal?: AbortSignal,
): Promise<TacticalSessionResult> {
  const messages: AIMessage[] = [
    { role: 'system', content: buildTacticalSystemPrompt() },
    {
      role: 'user',
      content: buildTacticalUserPrompt(
        snapshot, balance, positions, strategicContext,
        allIndicators, orderbook, sentiment,
      ),
    },
  ];

  const buildResult = (response: { content: string; provider: string; model: string }): TacticalSessionResult => {
    const parsed = parseAIDecision(response.content);
    const { thinking, ...decision } = parsed;
    return {
      decision,
      thinking: thinking || '',
      aiProvider: response.provider,
      aiModel: response.model,
      indicatorsJson: JSON.stringify(allIndicators),
      orderbookJson: JSON.stringify(orderbook),
      sentimentJson: JSON.stringify(sentiment),
    };
  };

  const tacticalProvider = config.ai.tacticalProvider || undefined;
  const strategicProvider = config.ai.strategicProvider || undefined;

  let response;
  try {
    response = await aiChat(messages, tacticalProvider, strategicProvider, signal);
    logger.info(`${snapshot.symbol} 战术执行响应来自 ${response.provider}/${response.model}`);
  } catch (firstErr) {
    // If aborted, don't retry
    if (signal?.aborted) throw firstErr;
    logger.warn('战术AI调用失败，正在重试', {
      error: firstErr instanceof Error ? firstErr.message : String(firstErr),
    });
    response = await aiChat(messages, tacticalProvider, strategicProvider, signal);
    logger.info(`${snapshot.symbol} 战术执行重试响应来自 ${response.provider}/${response.model}`);
  }

  return buildResult(response);
}
