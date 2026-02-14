import { BaseRole } from './base-role';
import type { RoundtableSessionInput } from '../types';
import { formatIndicators, formatOrderbook } from '../../analysis/indicators';

export class TechnicalAnalyst extends BaseRole {
  readonly roleName = '技术分析师';
  readonly roleId = 'technical-analyst';

  protected buildSystemPrompt(): string {
    return `你是交易圆桌会议中的技术分析师。专长：短周期图表形态、指标共振、精确价格行为判读。

## 职责
分析1m-15m指标共振/背离，识别短期关键位和形态，提供精确入场/止损/止盈价。

## 决策原则（日内交易）
- 5m+15m共振→高置信度，单周期信号也可给出方向（降低置信度）
- 盈亏比≥1.2:1即可（日内不需要太高盈亏比）
- RSI超买超卖+价格形态 = 可操作信号
- 不要因为1h级别不确定就否定5m-15m的清晰信号

返回JSON:
{"role":"technical-analyst","stance":"SHORT|LONG|HOLD|CLOSE|ADJUST|ADD|REDUCE","confidence":0.0-1.0,"reasoning":"中文","keyPoints":["论点"],"suggestedParams":{"entryPrice":0,"stopLoss":0,"takeProfit":0,"leverage":0}}`;
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
      `请从技术面角度分析，给出精确的入场/出场价位和关键论点。请明确标注关键价格点位(支撑位、压力位、突破点、跌破点)及其触发条件。`,
    );

    if (strategy.triggeredKeyLevel) {
      const tl = strategy.triggeredKeyLevel;
      const dirLabel = tl.direction === 'LONG' ? '做多' : tl.direction === 'SHORT' ? '做空' : '中性';
      lines.push('', `⚠️ 触发点位: ${tl.type} ${tl.price} [${dirLabel}] 置信度:${(tl.confidence * 100).toFixed(0)}% ${tl.reasoning}`);
    }

    return lines.join('\n');
  }
}
