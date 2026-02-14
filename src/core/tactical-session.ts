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
import { formatLimitsForPrompt, type DynamicRiskLimits } from '../risk/dynamic-limits';

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

function buildTacticalSystemPrompt(dynamicLimits?: DynamicRiskLimits): string {
  const limitsBlock = dynamicLimits
    ? `\n${formatLimitsForPrompt(dynamicLimits)}\n根据以上动态风控限制调整仓位和杠杆。`
    : `- 小账户(<500U)：仓位15%-25%，杠杆8x-15x，趋势明确时果断重仓
- 中账户(500-2000U)：仓位10%-18%，杠杆5x-10x
- 大账户(>2000U)：仓位5%-12%，杠杆3x-8x，逐步保守`;

  return `你是果断的交易执行者。战略方向已定，你负责执行。先思考再回答JSON。

## 任务
判断是否执行计划，设定入场/止损/止盈，管理仓位（加仓/减仓/平仓）。

## 决策原则
- 大方向对+短周期不矛盾即可执行，不需所有指标完美对齐
- 价格在入场区间±1%内+短周期有支撑→执行；>2%→HOLD等回调
- 论点失效→果断平仓；盈亏比≥1.5:1
- LONG/SHORT完全对等，不要对做空额外犹豫
- 连续HOLD多轮且大方向没变→降低入场标准

## 仓位管理
- 盈利>2%+趋势延续→ADD(30-50%)；亏损+微观反弹→REDUCE(30-50%做T)
${limitsBlock}

## 优先级
有仓位: CLOSE>REDUCE>ADD>ADJUST>HOLD
无仓位看多: LONG>HOLD | 看空: SHORT>HOLD

返回JSON:
{"action":"LONG|SHORT|CLOSE|HOLD|ADJUST|ADD|REDUCE","symbol":"BTC/USDT:USDT","confidence":0.0-1.0,"reasoning":"中文","marketRegime":"trending_up|trending_down|ranging|volatile|quiet","params":{"positionSizePercent":0,"leverage":0,"stopLossPrice":0,"takeProfitPrice":0,"orderType":"MARKET|LIMIT","addPercent":0,"reducePercent":0}}`;
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

请基于战略上下文和当前短周期数据，做出果断的执行决策。价格在入场区间±1%内且短周期无反向信号就应执行。趋势明确时，果断 > 完美。持有仓位时优先评估仓位管理。`;
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
  dynamicLimits?: DynamicRiskLimits,
): Promise<TacticalSessionResult> {
  const messages: AIMessage[] = [
    { role: 'system', content: buildTacticalSystemPrompt(dynamicLimits) },
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
