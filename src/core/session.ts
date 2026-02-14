import { aiChat } from '../ai/router';
import { AIMessage } from '../ai/provider';
import { AIDecision, MarketRegime, parseAIDecision } from './decision';
import { MarketSnapshot } from '../exchange/market-data';
import { AccountBalance, PositionInfo } from '../exchange/account';
import { logger } from '../utils/logger';
import { getRecentTrades } from '../persistence/models/trade';
import { getOpenPositionBySymbol } from '../persistence/models/position';
import { getPositionOperations } from '../persistence/models/position-ops';
import { buildMemoryContext, detectMarketRegime } from '../memory/memory-context';
import { getStreakInfo } from '../risk/circuit-breaker';
import {
  calcIndicators, analyzeOrderbook, calcSentiment,
  formatIndicators, formatOrderbook, formatSentiment,
  TechnicalIndicators, OrderbookAnalysis, MarketSentiment,
} from '../analysis/indicators';

// ─── Shared Utility Functions (used by strategic/tactical sessions) ───

export function buildTradeHistory(): string {
  try {
    const trades = getRecentTrades(20) as any[];
    if (!trades.length) return '最近交易记录: 无';

    const closedTrades = trades.filter((t: any) => t.action === 'CLOSE' && t.pnl != null);
    const wins = closedTrades.filter((t: any) => t.pnl > 0).length;
    const losses = closedTrades.filter((t: any) => t.pnl < 0).length;
    const totalPnl = closedTrades.reduce((s: number, t: any) => s + (t.pnl || 0), 0);
    const winRate = closedTrades.length > 0 ? ((wins / closedTrades.length) * 100).toFixed(0) : 'N/A';

    const lines = ['═══════════════════════════════════════', '【最近交易历史】'];
    lines.push(`  总交易数: ${trades.length}, 已平仓: ${closedTrades.length}`);
    lines.push(`  胜率: ${winRate}% (${wins}胜/${losses}负), 累计盈亏: ${totalPnl.toFixed(2)} USDT`);
    lines.push('');
    lines.push('  最近 10 笔:');

    trades.slice(0, 10).forEach((t: any) => {
      const time = t.created_at?.slice(5, 16) || '--';
      const pnlStr = t.pnl != null ? `盈亏: ${t.pnl.toFixed(2)}` : '';
      lines.push(`  ${time} ${t.symbol} ${t.action} ${t.side || ''} ${t.amount?.toFixed(4) || ''} @ ${t.price?.toFixed(2) || ''} ${pnlStr}`);
    });

    return lines.join('\n');
  } catch {
    return '最近交易记录: 获取失败';
  }
}

export function buildPositionOpsContext(symbol: string): string {
  try {
    const dbPos = getOpenPositionBySymbol(symbol);
    if (!dbPos) return '';

    const ops = getPositionOperations(dbPos.id);
    if (ops.length === 0) return '';

    const lines = ['\n【当前仓位操作历史】'];
    lines.push(`  加仓次数: ${dbPos.add_count ?? 0}/2, 做T次数: ${dbPos.reduce_count ?? 0}/3`);
    lines.push(`  当前均价: ${dbPos.avg_entry_price?.toFixed(2) ?? dbPos.entry_price?.toFixed(2) ?? 'N/A'}`);
    lines.push(`  做T累计节省: ${(dbPos.t_trade_savings ?? 0).toFixed(2)} USDT`);
    lines.push('  操作记录:');

    for (const op of ops.slice(-5)) {
      lines.push(`    ${op.operation} ${op.side} ${op.amount.toFixed(4)} @ ${op.price.toFixed(2)} → 均价: ${op.avg_entry_after?.toFixed(2) ?? 'N/A'}`);
    }

    return lines.join('\n');
  } catch {
    return '';
  }
}

// ─── Re-exports for backward compatibility ───

export { calcIndicators, analyzeOrderbook, calcSentiment, detectMarketRegime };
export type { TechnicalIndicators, OrderbookAnalysis, MarketSentiment };

// ─── Legacy Session (deprecated — delegates to new two-layer system) ───

function formatKlines(klines: any[][], label: string): string {
  if (!klines.length) return `${label}: 无数据`;
  const recent = klines.slice(-100);
  const lines = recent.map((k) => {
    const [ts, open, high, low, close, vol] = k;
    const date = new Date(ts).toISOString().slice(11, 19);
    return `  ${date} O:${open} H:${high} L:${low} C:${close} V:${vol}`;
  });
  return `${label} (最近 ${recent.length} 根):\n${lines.join('\n')}`;
}

function buildSystemPrompt(): string {
  return `你是一位顶级加密货币合约交易大师，拥有10年以上实战经验。你不是简单的信号机器人，而是一个有记忆、会反思、能自我优化的职业交易员。

## 你的核心身份
- 你记得过去的每一笔交易，从成功和失败中学习
- 你能识别市场环境（regime），并据此调整策略
- 你擅长仓位管理：盈利时滚仓加码，亏损时做T降本
- 你有严格的风控纪律，但也有灵活的战术执行能力

## 市场环境识别（5种 regime）
1. **trending_up** - 上升趋势：EMA多头排列，ADX>25，顺势做多为主
2. **trending_down** - 下降趋势：EMA空头排列，ADX>25，顺势做空为主
3. **ranging** - 震荡区间：ADX<20，高抛低吸，缩小仓位
4. **volatile** - 高波动：ATR%>2%，缩小仓位，宽止损
5. **quiet** - 低波动：ATR%<0.5%，观望为主，等待突破

## 仓位管理策略

### 盈利滚仓（ADD）
- 当持仓盈利 > 2% 时，评估是否加仓
- 加仓条件：趋势延续确认（EMA排列+MACD同向+成交量配合）
- 每次加仓量为当前仓位的 30-50%
- 最多加仓 2 次，总仓位不超过初始的 2.5 倍
- 加仓后必须上移止损到新均价附近保护利润

### 亏损做T（REDUCE）
- 当持仓亏损但出现微观反弹信号时，减仓 30-50%
- 做T条件：RSI超卖反弹、订单簿买方增强、短周期MACD金叉
- 目的是降低持仓成本，等回落后再加回
- 最多做T 3 次

### 动态止损
- 初始止损基于 ATR（1.5-2倍ATR）
- 盈利后追踪止损：每盈利1个ATR，上移止损0.5个ATR
- 加仓后止损调整到新均价 - 1倍ATR

### 仓位大小（简化Kelly）
- 基础仓位 = 胜率 × 2 - 1（Kelly比例的一半）
- 连胜时可适当加大（最多1.5倍基础仓位）
- 连败时必须缩小（最少0.5倍基础仓位）

## 决策优先级（有仓位时）
CLOSE > REDUCE > ADD > ADJUST > HOLD

## 决策优先级（无仓位时）
LONG/SHORT > HOLD

## 核心交易原则
1. 宁可错过，不可做错。没有明确信号时必须 HOLD
2. 盈亏比至少 1.5:1
3. 止损基于技术位（支撑/阻力/ATR）
4. 顺势交易为主，逆势只在极端超买超卖时考虑
5. 多周期共振才开仓：至少 2 个以上周期方向一致
6. 已有持仓时，重点评估仓位管理（加仓/减仓/调整止损）
7. 连续亏损后降低仓位，不急于回本
8. 关注成交量确认：突破需放量配合
9. 从历史记忆中学习，避免重复犯错
10. 根据市场环境调整策略参数

你拥有完全的自主决策权。请用中文简要说明分析思路和决策理由。

返回格式（严格 JSON）:
{
  "action": "LONG" | "SHORT" | "CLOSE" | "HOLD" | "ADJUST" | "ADD" | "REDUCE",
  "symbol": "BTC/USDT:USDT",
  "confidence": 0.0-1.0,
  "reasoning": "用中文简要说明分析思路和决策理由",
  "marketRegime": "trending_up" | "trending_down" | "ranging" | "volatile" | "quiet",
  "params": {
    "positionSizePercent": number,
    "leverage": number,
    "stopLossPrice": number,
    "takeProfitPrice": number,
    "orderType": "MARKET" | "LIMIT",
    "addPercent": number (加仓时: 加仓比例, 30-50),
    "reducePercent": number (减仓时: 减仓比例, 30-50)
  } 或 null（观望时）
}`;
}

function buildUserPrompt(
  snapshot: MarketSnapshot,
  balance: AccountBalance,
  positions: PositionInfo[],
  allIndicators: { [tf: string]: TechnicalIndicators },
  orderbook: OrderbookAnalysis,
  sentiment: MarketSentiment,
  marketRegime: MarketRegime,
  memoryContext: string,
): string {
  const totalUnrealizedPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const totalNotional = positions.reduce((s, p) => s + p.notional, 0);
  const positionOverview = positions.length > 0
    ? `  总持仓数: ${positions.length}, 总名义价值: ${totalNotional.toFixed(2)} USDT, 总未实现盈亏: ${totalUnrealizedPnl.toFixed(2)} USDT`
    : '  无持仓';

  const symbolPositions = positions.filter((p) => p.symbol === snapshot.symbol);
  const symbolPosStr = symbolPositions.length
    ? symbolPositions.map((p) => {
        const pnlPct = p.notional > 0 ? ((p.unrealizedPnl / (p.notional / p.leverage)) * 100).toFixed(2) : '0.00';
        return `  ${p.symbol} ${p.side === 'long' ? '多' : '空'} ${p.contracts} 张 @ ${p.entryPrice}, 标记价: ${p.markPrice}, 盈亏: ${p.unrealizedPnl.toFixed(2)} USDT (${pnlPct}%), 杠杆: ${p.leverage}x`;
      }).join('\n')
    : '  无';

  const otherPositions = positions.filter((p) => p.symbol !== snapshot.symbol);
  const otherPosStr = otherPositions.length
    ? otherPositions.map((p) => {
        const pnlPct = p.notional > 0 ? ((p.unrealizedPnl / (p.notional / p.leverage)) * 100).toFixed(2) : '0.00';
        return `  ${p.symbol} ${p.side === 'long' ? '多' : '空'} 盈亏: ${p.unrealizedPnl.toFixed(2)} USDT (${pnlPct}%)`;
      }).join('\n')
    : '  无';

  const now = new Date();
  const timeStr = now.toISOString().slice(0, 19).replace('T', ' ') + ' UTC';

  const indicatorTexts = Object.entries(allIndicators)
    .map(([tf, ind]) => formatIndicators(tf, ind))
    .join('\n\n');

  const streak = getStreakInfo();
  const streakStr = streak.winStreak > 0
    ? `  当前连胜: ${streak.winStreak} 次 → 可适当加大仓位`
    : streak.lossStreak > 0
    ? `  当前连败: ${streak.lossStreak} 次 → 建议缩小仓位或暂停`
    : '  无连胜/连败';

  const posOpsContext = buildPositionOpsContext(snapshot.symbol);

  return `当前时间: ${timeStr}
请分析以下市场数据并做出交易决策:

交易对: ${snapshot.symbol}
当前市场环境: ${marketRegime}

账户状态:
  总余额: ${balance.totalBalance.toFixed(2)} USDT
  可用余额: ${balance.availableBalance.toFixed(2)} USDT
  已用保证金: ${balance.usedMargin.toFixed(2)} USDT

连胜/连败状态:
${streakStr}

持仓概览:
${positionOverview}

当前币种持仓 (${snapshot.symbol}):
${symbolPosStr}
${posOpsContext}

其他币种持仓:
${otherPosStr}

行情数据:
  最新价: ${snapshot.ticker.last}
  买一: ${snapshot.ticker.bid}
  卖一: ${snapshot.ticker.ask}
  24h成交额: ${snapshot.ticker.quoteVolume.toFixed(0)} USDT
  24h涨跌幅: ${snapshot.ticker.percentage?.toFixed(2)}%

资金费率: ${snapshot.fundingRate !== null ? (snapshot.fundingRate * 100).toFixed(4) + '%' : '暂无'}

═══════════════════════════════════════
${indicatorTexts}

${formatOrderbook(orderbook)}

${formatSentiment(sentiment)}
═══════════════════════════════════════

${formatKlines(snapshot.klines['1m'], '1分钟K线')}

${formatKlines(snapshot.klines['5m'], '5分钟K线')}

${formatKlines(snapshot.klines['15m'], '15分钟K线')}

${formatKlines(snapshot.klines['1h'], '1小时K线')}

${buildTradeHistory()}

${memoryContext}

请综合以上所有指标、数据、交易历史和策略记忆，做出理性的交易决策。
如果有持仓，优先评估仓位管理（加仓/减仓/调整止损/平仓）。
如果没有明确信号，请选择 HOLD。返回 JSON 决策:`;
}

export interface TradingSessionResult {
  decision: AIDecision;
  aiProvider: string;
  aiModel: string;
  indicatorsJson: string;
  orderbookJson: string;
  sentimentJson: string;
  marketRegime: MarketRegime;
}

/**
 * @deprecated Use runStrategicAnalysis + runTacticalExecution instead.
 * Kept for backward compatibility — still works as a single-pass fallback.
 */
export async function runTradingSession(
  snapshot: MarketSnapshot,
  balance: AccountBalance,
  positions: PositionInfo[]
): Promise<TradingSessionResult> {
  const allIndicators: { [tf: string]: TechnicalIndicators } = {};
  for (const tf of ['1m', '5m', '15m', '1h'] as const) {
    allIndicators[tf] = calcIndicators(snapshot.klines[tf]);
  }

  const orderbookAnalysis = analyzeOrderbook(snapshot.orderbook.bids, snapshot.orderbook.asks);

  const sentiment = calcSentiment(
    allIndicators,
    orderbookAnalysis,
    snapshot.fundingRate,
    snapshot.ticker.percentage
  );

  const marketRegime = detectMarketRegime(allIndicators);
  const memoryContext = buildMemoryContext(snapshot.symbol, marketRegime);

  logger.info(`${snapshot.symbol} 情绪分: ${sentiment.score} (${sentiment.overallBias}), 市场环境: ${marketRegime}`);

  const messages: AIMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserPrompt(snapshot, balance, positions, allIndicators, orderbookAnalysis, sentiment, marketRegime, memoryContext) },
  ];

  const buildResult = (response: { content: string; provider: string; model: string; usage?: any }): TradingSessionResult => ({
    decision: parseAIDecision(response.content),
    aiProvider: response.provider,
    aiModel: response.model,
    indicatorsJson: JSON.stringify(allIndicators),
    orderbookJson: JSON.stringify(orderbookAnalysis),
    sentimentJson: JSON.stringify(sentiment),
    marketRegime,
  });

  try {
    const response = await aiChat(messages);
    logger.info(`AI 响应来自 ${response.provider}/${response.model}`, {
      usage: response.usage,
    });
    return buildResult(response);
  } catch (firstErr) {
    logger.warn('首次 AI 调用失败，正在重试', {
      error: firstErr instanceof Error ? firstErr.message : String(firstErr),
    });

    const response = await aiChat(messages);
    return buildResult(response);
  }
}
