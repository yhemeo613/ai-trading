import { BaseRole } from './base-role';
import type { RoundtableSessionInput } from '../types';
import { formatLimitsForPrompt } from '../../risk/dynamic-limits';

export class RiskManager extends BaseRole {
  readonly roleName = '风险经理';
  readonly roleId = 'risk-manager';

  protected buildSystemPrompt(): string {
    return `你是交易圆桌会议中的风险经理。你的专长是仓位管理、回撤控制和风险评估。

## 你的职责
1. 评估当前账户风险敞口
2. 建议合理的仓位大小和杠杆
3. 评估止损设置是否充分
4. 仅在极端风险时行使一票否决权

## 一票否决权（仅在以下极端情况使用）
- 熔断器已触发
- 连亏 5 次以上且要开新仓
- 总敞口已超过可用余额的 80%

## 决策原则（日内交易）
- 你的核心职责是评估风险并建议合理的仓位大小和杠杆
- 请参考市场数据中的【当前风控限制】来确定仓位和杠杆范围
- 根据技术面和风险评估独立判断方向，LONG/SHORT/HOLD都是合理选项
- 只有在上述极端否决条件满足时才否决，其他情况通过调整参数来控制风险
- 日内交易风险可控：止损距离近、持仓时间短，不要过度保守
- 做多和做空的风险评估标准完全一致，不偏向任何方向
- 小仓位+合理止损的交易应该放行，不要因为"不确定"就建议HOLD

返回严格JSON:
{
  "role": "risk-manager",
  "stance": "LONG|SHORT|HOLD|CLOSE|ADJUST|ADD|REDUCE",
  "confidence": 0.0-1.0,
  "reasoning": "中文分析",
  "keyPoints": ["关键论点1", "关键论点2"],
  "suggestedParams": { "positionSizePercent": number, "leverage": number, "stopLoss": number }
}`;
  }

  protected buildRound1Prompt(input: RoundtableSessionInput): string {
    const { market, account, strategy } = input;
    const currentPos = account.positions.find((p: any) => p.symbol === market.symbol);

    const lines = [
      `交易对: ${market.symbol}`,
      `当前价格: ${market.currentPrice}`,
      '',
      `【账户状态】`,
      `  总余额: ${account.balance.totalBalance.toFixed(2)} USDT`,
      `  可用余额: ${account.balance.availableBalance.toFixed(2)} USDT`,
      `  已用保证金: ${account.balance.usedMargin.toFixed(2)} USDT`,
      `  保证金使用率: ${account.balance.totalBalance > 0 ? ((account.balance.usedMargin / account.balance.totalBalance) * 100).toFixed(1) : 0}%`,
      '',
      `【持仓情况】`,
      `  总持仓数: ${account.positions.length}`,
      currentPos
        ? `  当前币种: ${currentPos.symbol} ${currentPos.side === 'long' ? '多' : '空'} ${currentPos.contracts} 张, 盈亏: ${currentPos.unrealizedPnl?.toFixed(2)} USDT, 杠杆: ${currentPos.leverage}x`
        : `  当前币种: 无持仓`,
      '',
      `【熔断器状态】`,
      `  ${JSON.stringify(account.circuitBreakerState)}`,
      '',
      `【连胜/连亏】`,
      `  连胜: ${account.streakInfo.winStreak}, 连亏: ${account.streakInfo.lossStreak}`,
      '',
      `【波动率参考】`,
      `  ATR%: ${market.indicators['15m']?.atrPercent?.toFixed(2) ?? '未知'}%`,
      `  ADX: ${market.indicators['15m']?.adx?.toFixed(1) ?? '未知'}`,
      '',
      strategy.positionThesis ? `【入场论点】\n  ${strategy.positionThesis}` : '',
      '',
      `请从风险管理角度评估，是否应该执行交易。如果风险过高，请行使否决权（stance 设为 HOLD 并在 keyPoints 中注明"一票否决"）。`,
      '',
      formatLimitsForPrompt(account.dynamicLimits),
    ];
    return lines.join('\n');
  }
}
