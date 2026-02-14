import { BaseRole } from './base-role';
import type { RoundtableSessionInput } from '../types';

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
- 总敞口已超过可用余额的 50%
- 杠杆超过 10x

## 决策原则（重要）
- 你的核心职责是建议合理的仓位大小和杠杆，而不是阻止交易
- 账户余额小不是否决理由，小账户更需要抓住趋势机会来积累资金
- 小账户（<500U）：仓位 15%-25%，杠杆 8x-15x，目标快速积累资金
- 中账户（500-2000U）：仓位 10%-18%，杠杆 5x-10x
- 大账户（>2000U）：仓位 5%-12%，杠杆 3x-8x，逐步保守
- 趋势明确时应该给出与趋势一致的stance（LONG/SHORT），而不是HOLD
- 只有在上述极端否决条件满足时才否决，其他情况通过调整参数来控制风险
- 不要因为"谨慎"就否决一切，过度保守导致错过机会也是一种风险
- 你的stance应该反映风险调整后的方向判断，不是默认HOLD

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
    ];
    return lines.join('\n');
  }
}
