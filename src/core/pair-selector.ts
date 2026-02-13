import { aiChat } from '../ai/router';
import { AIMessage } from '../ai/provider';
import { parsePairSelection, PairSelection } from './decision';
import { fetchTopSymbolsByVolume } from '../exchange/market-data';
import { logger } from '../utils/logger';

export async function selectTradingPairs(): Promise<string[]> {
  const topSymbols = await fetchTopSymbolsByVolume(30);
  logger.info(`Top 30 symbols by volume: ${topSymbols.slice(0, 10).join(', ')}...`);

  const messages: AIMessage[] = [
    {
      role: 'system',
      content: `You are a crypto market analyst. Select 3-5 trading pairs from the provided list that have the best trading opportunities right now.

Consider: volume, volatility potential, trend clarity, and diversification.

Return ONLY valid JSON:
{
  "symbols": ["BTC/USDT", "ETH/USDT", ...],
  "reasoning": "brief explanation"
}`,
    },
    {
      role: 'user',
      content: `Select 3-5 best trading pairs from these top-30 by volume:\n${topSymbols.join('\n')}`,
    },
  ];

  try {
    const response = await aiChat(messages);
    const selection = parsePairSelection(response.content);
    // Validate that selected symbols are in the top list
    const valid = selection.symbols.filter((s) => topSymbols.includes(s));
    if (valid.length === 0) {
      logger.warn('AI selected no valid symbols, falling back to top 3');
      return topSymbols.slice(0, 3);
    }
    logger.info(`AI selected pairs: ${valid.join(', ')}`, { reasoning: selection.reasoning });
    return valid;
  } catch (err) {
    logger.error('Pair selection failed, using top 3 by volume', {
      error: err instanceof Error ? err.message : String(err),
    });
    return topSymbols.slice(0, 3);
  }
}
