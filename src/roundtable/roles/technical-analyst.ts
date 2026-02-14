import { BaseRole } from './base-role';
import type { RoundtableSessionInput } from '../types';
import { formatIndicators, formatOrderbook } from '../../analysis/indicators';

export class TechnicalAnalyst extends BaseRole {
  readonly roleName = '技术分析师';
  readonly roleId = 'technical-analyst';

  protected buildSystemPrompt(): string {
    return `你是交易圆桌会议中的技术分析师。专长：图表形态识别、指标共振分析、精确价格行为判读。

## 职责
分析多周期指标共振/背离，识别关键位和形态，提供精确入场/止损/止盈价。

## 决策原则
- 多周期共振→高置信度，单周期→低置信度
- 盈亏比≥1.5:1，关注指标背离

返回JSON:
{"role":"technical-analyst","stance":"LONG|SHORT|HOLD|CLOSE|ADJUST|ADD|REDUCE","confidence":0.0-1.0,"reasoning":"中文","keyPoints":["论点"],"suggestedParams":{"entryPrice":0,"stopLoss":0,"takeProfit":0,"leverage":0}}`;
  }

  protected buildRound1Prompt(input: RoundtableSessionInput): string {
    const { market, account, strategy } = input;
    const currentPos = account.positions.find((p: any) => p.symbol === market.symbol);

    const lines = [
      `交易对: ${market.symbol} | 价格: ${market.currentPrice}`,
      '',
    ];

    if (currentPos) {
      const pnlPct = currentPos.notional > 0 ? ((currentPos.unrealizedPnl / (currentPos.notional / currentPos.leverage)) * 100).toFixed(2) : '0.00';
      lines.push(`【持仓】${currentPos.side === 'long' ? '多' : '空'} ${currentPos.contracts}张 @${currentPos.entryPrice}, 盈亏:${currentPos.unrealizedPnl?.toFixed(2)}U (${pnlPct}%)`);
      if (strategy.positionThesis) lines.push(`  论点: ${strategy.positionThesis}`);
      lines.push('');
    }

    const tfKeys = ['1m', '5m', '15m', '1h'] as const;
    for (const tf of tfKeys) {
      if (market.indicators[tf]) lines.push(formatIndicators(tf, market.indicators[tf]));
    }

    lines.push(
      '',
      market.narrative?.formatted ?? '无叙事数据',
      '',
      formatOrderbook(market.orderbook),
      '',
      `请从技术面角度分析，给出精确的入场/出场价位和关键论点。`,
    );
    return lines.join('\n');
  }
}
