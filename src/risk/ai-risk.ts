import { aiChat } from '../ai/router';
import { AIMessage } from '../ai/provider';
import { config } from '../config';
import { parsePortfolioReview, PortfolioReview } from '../core/decision';
import { AccountBalance, PositionInfo } from '../exchange/account';
import { logger } from '../utils/logger';

export async function runPortfolioReview(
  balance: AccountBalance,
  positions: PositionInfo[]
): Promise<PortfolioReview | null> {
  if (positions.length === 0) {
    logger.info('无持仓需要审查');
    return null;
  }

  const posStr = positions.map((p) =>
    `${p.symbol} ${p.side} ${p.contracts} contracts @ ${p.entryPrice}, mark: ${p.markPrice}, PnL: ${p.unrealizedPnl.toFixed(2)} USDT (${p.percentage.toFixed(2)}%), leverage: ${p.leverage}x`
  ).join('\n');

  const messages: AIMessage[] = [
    {
      role: 'system',
      content: `你是一位加密货币合约投资组合风险管理师。请审查所有持仓并提出调整建议。

考虑因素: 持仓间的相关性、整体敞口、未实现盈亏、市场状况。

仅返回有效 JSON:
{
  "actions": [
    {
      "symbol": "BTC/USDT:USDT",
      "action": "HOLD" | "CLOSE" | "ADJUST",
      "reasoning": "用中文简要说明理由",
      "adjustParams": { "newStopLoss": number, "newTakeProfit": number } 或 null
    }
  ],
  "overallAssessment": "用中文简要评估整体投资组合状况"
}`,
    },
    {
      role: 'user',
      content: `投资组合审查:

账户余额: ${balance.totalBalance.toFixed(2)} USDT
可用余额: ${balance.availableBalance.toFixed(2)} USDT

当前持仓:
${posStr}

请分析并提供建议:`,
    },
  ];

  try {
    const auxProvider = config.ai.auxiliaryProvider || undefined;
    const response = await aiChat(messages, auxProvider);
    const review = parsePortfolioReview(response.content);
    logger.info('投资组合审查完成', { assessment: review.overallAssessment });
    return review;
  } catch (err) {
    logger.error('投资组合审查失败', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
