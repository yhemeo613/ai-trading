import { logger } from '../utils/logger';

// 固定主流币列表，不再通过 AI 筛选
const MAIN_PAIRS = [
  'BTC/USDT:USDT',
  'ETH/USDT:USDT',
  'SOL/USDT:USDT',
  'BNB/USDT:USDT',
  'XRP/USDT:USDT',
  'DOGE/USDT:USDT',
];

export function getTradingPairs(): string[] {
  logger.info(`交易对: ${MAIN_PAIRS.join(', ')}`);
  return MAIN_PAIRS;
}
