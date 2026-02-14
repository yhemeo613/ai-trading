import { BaseRole } from './base-role';
import type { RoundtableSessionInput } from '../types';
import { formatIndicators, formatOrderbook, formatSentiment } from '../../analysis/indicators';

export class ExecutionTrader extends BaseRole {
  readonly roleName = '执行交易员';
  readonly roleId = 'execution-trader';

  protected buildSystemPrompt(): string {
    return `你是交易圆桌会议中的执行交易员。专长：订单执行时机、滑点控制、微观市场结构。

## 职责
评估执行时机，分析订单簿深度，确定订单类型，评估滑点。

## 决策原则（日内交易）
- 流动性充足→市价单快速入场，不足→限价单
- 订单簿买卖比失衡 = 短期方向信号，应果断给出方向
- 资金费率极端→可能是反转信号但不要因此否定趋势
- 成交量放大+价格突破 = 好的入场时机，应该支持开仓

返回JSON:
{"role":"execution-trader","stance":"SHORT|LONG|HOLD|CLOSE|ADJUST|ADD|REDUCE","confidence":0.0-1.0,"reasoning":"中文","keyPoints":["论点"],"suggestedParams":{"entryPrice":0,"leverage":0,"positionSizePercent":0}}`;
  }

  protected buildRound1Prompt(input: RoundtableSessionInput): string {
    const { market, account, strategy } = input;
    const currentPos = account.positions.find((p: any) => p.symbol === market.symbol);

    const lines = [
      `交易对: ${market.symbol} | 价格: ${market.currentPrice}`,
      '',
    ];

    if (currentPos) {
      lines.push(`【持仓】${currentPos.side === 'long' ? '多' : '空'} ${currentPos.contracts}张 @${currentPos.entryPrice}, 杠杆:${currentPos.leverage}x`);
      if (strategy.positionThesis) lines.push(`  论点: ${strategy.positionThesis}`);
      lines.push('');
    }

    lines.push(
      formatOrderbook(market.orderbook),
      '',
      market.indicators['1m'] ? formatIndicators('1m', market.indicators['1m']) : '',
      market.indicators['5m'] ? formatIndicators('5m', market.indicators['5m']) : '',
      '',
      `资金费率: ${market.fundingRate !== null ? (market.fundingRate * 100).toFixed(4) + '%' : '暂无'}`,
      `24h涨跌: ${market.ticker.percentage?.toFixed(2)}% | 成交量: ${market.ticker.quoteVolume?.toFixed(0)} USDT`,
      '',
      formatSentiment(market.sentiment),
      '',
      `请从执行角度分析，当前是否是好的入场/出场时机，推荐订单类型和执行参数。`,
    );
    return lines.join('\n');
  }
}
