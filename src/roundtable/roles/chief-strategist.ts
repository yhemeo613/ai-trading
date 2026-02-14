import { BaseRole } from './base-role';
import type { RoundtableSessionInput } from '../types';
import { formatIndicators } from '../../analysis/indicators';

export class ChiefStrategist extends BaseRole {
  readonly roleName = '首席策略师';
  readonly roleId = 'chief-strategist';

  protected buildSystemPrompt(): string {
    return `你是交易圆桌会议中的首席策略师。专长：宏观趋势判断、市场周期识别。

## 职责
判断宏观周期阶段，识别大级别趋势方向和强度，评估跨时间框架一致性。

## 决策原则
- 趋势明确时给出明确方向，做多做空完全对等
- 结合历史经验避免重复犯错

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
      `请从宏观趋势角度分析，给出方向性判断和关键论点。`,
    ];
    return lines.join('\n');
  }
}
