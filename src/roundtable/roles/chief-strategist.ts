import { BaseRole } from './base-role';
import type { RoundtableSessionInput } from '../types';
import { formatIndicators } from '../../analysis/indicators';

export class ChiefStrategist extends BaseRole {
  readonly roleName = '首席策略师';
  readonly roleId = 'chief-strategist';

  protected buildSystemPrompt(): string {
    return `你是交易圆桌会议中的首席策略师。专长：短周期趋势判断、动量识别、市场结构分析。

## 职责
判断15m-1h级别趋势方向和强度，识别短期动量变化，评估趋势延续或反转概率。

## 决策原则（日内交易）
- 15m趋势+1h方向一致→高置信度果断给方向
- 不要等待完美信号，趋势初期就应该给出方向判断
- 短期EMA排列+ADX>20就足以判断方向
- 做多做空完全对等，空头趋势果断看空

返回JSON:
{"role":"chief-strategist","stance":"LONG|SHORT|HOLD|CLOSE|ADJUST|ADD|REDUCE","confidence":0.0-1.0,"reasoning":"中文","keyPoints":["论点"],"suggestedParams":{"entryPrice":0,"stopLoss":0,"takeProfit":0}}`;
  }

  protected buildRound1Prompt(input: RoundtableSessionInput): string {
    const { market, strategy } = input;

    const lines = [
      `交易对: ${market.symbol} | 价格: ${market.currentPrice} | 时间: ${new Date().toISOString().slice(0, 19)} UTC`,
      '',
      `【战略】环境:${strategy.strategicContext?.marketRegime ?? '未知'} 偏好:${strategy.strategicContext?.bias ?? '未知'} ${strategy.strategicContext?.reasoning ?? ''}`,
      '',
      market.narrative?.formatted ?? '无叙事数据',
      '',
      market.indicators['15m'] ? formatIndicators('15m', market.indicators['15m']) : '',
      market.indicators['1h'] ? formatIndicators('1h', market.indicators['1h']) : '',
      '',
      strategy.memoryContext || '无历史记忆',
      '',
      strategy.activePlan ? `【交易计划】${JSON.stringify(strategy.activePlan)}` : '无活跃计划',
      '',
      `请从宏观趋势角度分析，给出方向性判断和关键论点。请特别标注关键价格点位(支撑位、压力位、反转点、突破点、跌破点)及其重要性。`,
    ];

    if (strategy.triggeredKeyLevel) {
      const tl = strategy.triggeredKeyLevel;
      const dirLabel = tl.direction === 'LONG' ? '做多' : tl.direction === 'SHORT' ? '做空' : '中性';
      lines.push('', `⚠️ 触发点位: ${tl.type} ${tl.price} [${dirLabel}] 置信度:${(tl.confidence * 100).toFixed(0)}% ${tl.reasoning}`);
    }

    return lines.join('\n');
  }
}
