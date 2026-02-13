import { aiChat } from '../ai/router';
import { AIMessage } from '../ai/provider';
import { AIDecision, parseAIDecision } from './decision';
import { MarketSnapshot } from '../exchange/market-data';
import { AccountBalance, PositionInfo } from '../exchange/account';
import { logger } from '../utils/logger';

function formatKlines(klines: any[][], label: string): string {
  if (!klines.length) return `${label}: 无数据`;
  const recent = klines.slice(-10);
  const lines = recent.map((k) => {
    const [ts, open, high, low, close, vol] = k;
    const date = new Date(ts).toISOString().slice(0, 16);
    return `  ${date} 开:${open} 高:${high} 低:${low} 收:${close} 量:${vol}`;
  });
  return `${label} (最近 ${recent.length} 根K线):\n${lines.join('\n')}`;
}

function buildSystemPrompt(): string {
  return `你是一位专业的加密货币合约交易 AI 分析师。你需要分析市场数据并做出交易决策。

你的角色与思路:
- 你是一位经验丰富的量化交易员，擅长技术分析和风险管理
- 你会综合分析多个时间周期的K线走势、订单簿深度、资金费率等数据
- 你偏向保守策略，只在高置信度(>0.6)时才开仓
- 你始终设置止损和止盈来控制风险

交易规则:
- 交易标的: 币安 USDT 永续合约
- 仓位大小: 可用余额的 1-10%
- 杠杆倍数: 1-10倍（优先使用低杠杆）
- 必须设置止损和止盈价格
- 综合考虑多时间周期、订单簿、资金费率和现有持仓
- 不确定时返回 HOLD（观望）

请用中文详细说明你的分析思路，包括:
1. 趋势判断（多头/空头/震荡）
2. 关键支撑位和阻力位
3. 成交量和资金费率分析
4. 风险评估
5. 最终决策理由

返回格式（严格 JSON）:
{
  "action": "LONG" | "SHORT" | "CLOSE" | "HOLD" | "ADJUST",
  "symbol": "BTC/USDT:USDT",
  "confidence": 0.0-1.0,
  "reasoning": "用中文详细说明你的分析思路和决策理由",
  "params": {
    "positionSizePercent": 1-10,
    "leverage": 1-10,
    "stopLossPrice": number,
    "takeProfitPrice": number,
    "orderType": "MARKET" | "LIMIT"
  } 或 null（观望时）
}`;
}

function buildUserPrompt(
  snapshot: MarketSnapshot,
  balance: AccountBalance,
  positions: PositionInfo[]
): string {
  const posStr = positions.length
    ? positions.map((p) =>
        `  ${p.symbol} ${p.side === 'long' ? '多' : '空'} ${p.contracts} 张 @ ${p.entryPrice}, 标记价: ${p.markPrice}, 盈亏: ${p.unrealizedPnl.toFixed(2)} USDT, 杠杆: ${p.leverage}x`
      ).join('\n')
    : '  无';

  return `请分析以下市场数据并做出交易决策:

交易对: ${snapshot.symbol}

账户状态:
  总余额: ${balance.totalBalance.toFixed(2)} USDT
  可用余额: ${balance.availableBalance.toFixed(2)} USDT
  已用保证金: ${balance.usedMargin.toFixed(2)} USDT

当前持仓:
${posStr}

行情数据:
  最新价: ${snapshot.ticker.last}
  买一: ${snapshot.ticker.bid}
  卖一: ${snapshot.ticker.ask}
  24h成交额: ${snapshot.ticker.quoteVolume.toFixed(0)} USDT
  24h涨跌幅: ${snapshot.ticker.percentage?.toFixed(2)}%

资金费率: ${snapshot.fundingRate !== null ? (snapshot.fundingRate * 100).toFixed(4) + '%' : '暂无'}

订单簿 (前5档):
  买盘: ${snapshot.orderbook.bids.slice(0, 5).map(([p, q]) => `${p}@${q}`).join(', ')}
  卖盘: ${snapshot.orderbook.asks.slice(0, 5).map(([p, q]) => `${p}@${q}`).join(', ')}

${formatKlines(snapshot.klines['1h'], '1小时K线')}

${formatKlines(snapshot.klines['4h'], '4小时K线')}

${formatKlines(snapshot.klines['1d'], '日线')}

请用中文详细分析后返回 JSON 决策:`;
}

export async function runTradingSession(
  snapshot: MarketSnapshot,
  balance: AccountBalance,
  positions: PositionInfo[]
): Promise<AIDecision> {
  const messages: AIMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserPrompt(snapshot, balance, positions) },
  ];

  // First attempt
  try {
    const response = await aiChat(messages);
    logger.info(`AI 响应来自 ${response.provider}/${response.model}`, {
      usage: response.usage,
    });
    return parseAIDecision(response.content);
  } catch (firstErr) {
    logger.warn('首次 AI 调用失败，正在重试', {
      error: firstErr instanceof Error ? firstErr.message : String(firstErr),
    });

    // Retry once
    const response = await aiChat(messages);
    return parseAIDecision(response.content);
  }
}
