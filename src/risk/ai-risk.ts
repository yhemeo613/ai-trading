import { aiChat } from '../ai/router';
import { AIMessage } from '../ai/provider';
import { parsePortfolioReview, PortfolioReview } from '../core/decision';
import { AccountBalance, PositionInfo } from '../exchange/account';
import { logger } from '../utils/logger';

export async function runPortfolioReview(
  balance: AccountBalance,
  positions: PositionInfo[]
): Promise<PortfolioReview | null> {
  if (positions.length === 0) {
    logger.info('No positions to review');
    return null;
  }

  const posStr = positions.map((p) =>
    `${p.symbol} ${p.side} ${p.contracts} contracts @ ${p.entryPrice}, mark: ${p.markPrice}, PnL: ${p.unrealizedPnl.toFixed(2)} USDT (${p.percentage.toFixed(2)}%), leverage: ${p.leverage}x`
  ).join('\n');

  const messages: AIMessage[] = [
    {
      role: 'system',
      content: `You are a portfolio risk manager for crypto futures. Review all open positions and suggest adjustments.

Consider: correlation between positions, overall exposure, unrealized P&L, market conditions.

Return ONLY valid JSON:
{
  "actions": [
    {
      "symbol": "BTC/USDT",
      "action": "HOLD" | "CLOSE" | "ADJUST",
      "reasoning": "brief explanation",
      "adjustParams": { "newStopLoss": number, "newTakeProfit": number } or null
    }
  ],
  "overallAssessment": "brief portfolio assessment"
}`,
    },
    {
      role: 'user',
      content: `PORTFOLIO REVIEW:

Account Balance: ${balance.totalBalance.toFixed(2)} USDT
Available: ${balance.availableBalance.toFixed(2)} USDT

Open Positions:
${posStr}

Analyze and provide recommendations:`,
    },
  ];

  try {
    const response = await aiChat(messages);
    const review = parsePortfolioReview(response.content);
    logger.info('Portfolio review completed', { assessment: review.overallAssessment });
    return review;
  } catch (err) {
    logger.error('Portfolio review failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
