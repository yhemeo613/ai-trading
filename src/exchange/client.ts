import ccxt, { Exchange } from 'ccxt';
import { config } from '../config';
import { getProxyAgent } from '../utils/proxy';
import { logger } from '../utils/logger';

let exchange: Exchange | null = null;

export function getExchange(): Exchange {
  if (exchange) return exchange;

  if (config.testnetOnly) {
    logger.info('Initializing ccxt binance futures TESTNET client');
    exchange = new ccxt.binance({
      apiKey: config.binance.apiKey,
      secret: config.binance.secret,
      enableRateLimit: true,
      options: {
        defaultType: 'future',
      },
    });
    // Swap API URLs with testnet URLs
    const testUrls = (exchange as any).urls['test'];
    if (testUrls) {
      (exchange as any).urls['api'] = {
        ...(exchange as any).urls['api'],
        ...testUrls,
      };
      logger.info('Switched to testnet URLs');
    }
  } else {
    logger.info('Initializing ccxt binance futures LIVE client');
    exchange = new ccxt.binance({
      apiKey: config.binanceLive.apiKey,
      secret: config.binanceLive.secret,
      enableRateLimit: true,
      options: {
        defaultType: 'future',
      },
    });
  }

  const agent = getProxyAgent();
  if (agent) {
    (exchange as any).agent = agent;
    (exchange as any).httpAgent = agent;
    (exchange as any).httpsAgent = agent;
    logger.info('Proxy agent attached to exchange client');
  }

  return exchange;
}
