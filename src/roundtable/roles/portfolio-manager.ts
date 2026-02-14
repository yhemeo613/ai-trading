import { BaseRole } from './base-role';
import type { RoundtableSessionInput } from '../types';

export class PortfolioManager extends BaseRole {
  readonly roleName = '投资组合经理';
  readonly roleId = 'portfolio-manager';

  protected buildSystemPrompt(): string {
    return `你是交易圆桌会议中的投资组合经理。你的专长是组合平衡、仓位相关性分析和资金分配优化。

## 你的职责
1. 评估新交易对整体组合的影响
2. 检查仓位间的相关性和集中度
3. 优化资金分配比例
4. 基于组合视角调整建议仓位大小

## 分析重点
- 当前所有持仓的方向和盈亏
- 新交易与现有持仓的相关性
- 总敞口和资金利用率
- 持仓操作历史（加仓/减仓记录）
- 交易计划的执行情况

## 决策原则
- 避免同方向过度集中（如全部做多）
- 单币种仓位不超过总资金的 15%
- 总持仓不超过 5 个
- 盈利仓位可适当加仓，亏损仓位应考虑减仓
- 新开仓要考虑对组合整体风险的影响

返回严格JSON:
{
  "role": "portfolio-manager",
  "stance": "LONG|SHORT|HOLD|CLOSE|ADJUST|ADD|REDUCE",
  "confidence": 0.0-1.0,
  "reasoning": "中文分析",
  "keyPoints": ["关键论点1", "关键论点2"],
  "suggestedParams": { "positionSizePercent": number, "leverage": number }
}`;
  }

  protected buildRound1Prompt(input: RoundtableSessionInput): string {
    const { market, account, strategy } = input;

    const positionLines = account.positions.length > 0
      ? account.positions.map((p: any) => {
          const pnlPct = p.notional > 0 ? ((p.unrealizedPnl / (p.notional / p.leverage)) * 100).toFixed(2) : '0.00';
          return `  ${p.symbol} ${p.side === 'long' ? '多' : '空'} ${p.contracts} 张, 盈亏: ${p.unrealizedPnl?.toFixed(2)} USDT (${pnlPct}%), 杠杆: ${p.leverage}x`;
        }).join('\n')
      : '  无持仓';

    const opsLines = strategy.positionOps.length > 0
      ? strategy.positionOps.map((op: any) =>
          `  ${op.operation} ${op.side} ${op.amount} @ ${op.price}, 实现盈亏: ${op.pnl_realized ?? 0}`
        ).join('\n')
      : '  无操作记录';

    const lines = [
      `交易对: ${market.symbol}`,
      `当前价格: ${market.currentPrice}`,
      '',
      `【账户概览】`,
      `  总余额: ${account.balance.totalBalance.toFixed(2)} USDT`,
      `  可用余额: ${account.balance.availableBalance.toFixed(2)} USDT`,
      `  持仓数: ${account.positions.length}`,
      '',
      `【所有持仓】`,
      positionLines,
      '',
      `【当前币种持仓操作历史】`,
      opsLines,
      '',
      strategy.activePlan ? `【交易计划】${JSON.stringify(strategy.activePlan)}` : '无活跃计划',
      '',
      `【策略记忆】`,
      strategy.memoryContext || '无历史记忆',
      '',
      `请从投资组合角度分析，评估新交易对组合的影响，建议合适的仓位大小。`,
    ];
    return lines.join('\n');
  }
}
