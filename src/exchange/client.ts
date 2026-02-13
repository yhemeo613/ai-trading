import ccxt, { Exchange } from 'ccxt';
import { config } from '../config';
import { getProxyAgent } from '../utils/proxy';
import { logger } from '../utils/logger';

let exchange: Exchange | null = null;

export function getExchange(): Exchange {
  if (exchange) return exchange;

  if (config.testnetOnly) {
    logger.info('Initializing ccxt binance futures TESTNET client (demo trading)');
    exchange = new ccxt.binance({
      apiKey: config.binance.apiKey,
      secret: config.binance.secret,
      enableRateLimit: true,
      options: {
        defaultType: 'future',
      },
      urls: {
        api: {
          fapiPublic: config.binance.futuresUrl + '/fapi/v1',
          fapiPrivate: config.binance.futuresUrl + '/fapi/v1',
          fapiPrivateV2: config.binance.futuresUrl + '/fapi/v2',
        },
      },
    });
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
