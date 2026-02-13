import { aiChat } from '../ai/router';
import { AIMessage } from '../ai/provider';
import { parsePairSelection, PairSelection } from './decision';
import { fetchTopSymbolsByVolume } from '../exchange/market-data';
import { logger } from '../utils/logger';

export async function selectTradingPairs(): Promise<string[]> {
  const topSymbols = await fetchTopSymbolsByVolume(30);
  logger.info(`成交量前30交易对: ${topSymbols.slice(0, 10).join(', ')}...`);

  const messages: AIMessage[] = [
    {
      role: 'system',
      content: `你是一位加密货币市场分析师。请从提供的列表中选择 3-5 个最具交易机会的交易对。

考虑因素: 成交量、波动性、趋势清晰度、分散化。

重要: 使用列表中的完整符号格式（如 "BTC/USDT:USDT"）。

仅返回有效 JSON:
{
  "symbols": ["BTC/USDT:USDT", "ETH/USDT:USDT", ...],
  "reasoning": "用中文简要说明选择理由"
}`,
    },
    {
      role: 'user',
      content: `请从以下成交量前30的交易对中选择 3-5 个最佳交易对:\n${topSymbols.join('\n')}`,
    },
  ];

  try {
    const response = await aiChat(messages);
    const selection = parsePairSelection(response.content);
    // Validate that selected symbols are in the top list
    const valid = selection.symbols.filter((s) => topSymbols.includes(s));
    if (valid.length === 0) {
      logger.warn('AI 未选出有效交易对，回退到成交量前3');
      return topSymbols.slice(0, 3);
    }
    logger.info(`AI 已选择交易对: ${valid.join(', ')}`, { reasoning: selection.reasoning });
    return valid;
  } catch (err) {
    logger.error('交易对选择失败，使用成交量前3', {
      error: err instanceof Error ? err.message : String(err),
    });
    return topSymbols.slice(0, 3);
  }
}
