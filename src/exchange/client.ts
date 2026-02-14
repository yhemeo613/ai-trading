import ccxt, { Exchange } from 'ccxt';
import { config } from '../config';
import { getProxyAgent } from '../utils/proxy';
import { logger } from '../utils/logger';

let exchange: Exchange | null = null;
let publicExchange: Exchange | null = null;

/** Reset cached exchange instances (used when switching testnet/mainnet). */
export function resetExchange() {
  exchange = null;
  publicExchange = null;
}

function applyProxy(ex: Exchange) {
  const agent = getProxyAgent();
  if (agent) {
    (ex as any).agent = agent;
    (ex as any).httpAgent = agent;
    (ex as any).httpsAgent = agent;
  }
}

function applyTestnetUrls(ex: Exchange) {
  const testUrls = (ex as any).urls['test'];
  if (testUrls) {
    (ex as any).urls['api'] = {
      ...(ex as any).urls['api'],
      ...testUrls,
    };
  }
}

export function getExchange(): Exchange {
  if (exchange) return exchange;

  if (config.testnetOnly) {
    logger.info('正在初始化 ccxt 币安合约测试网客户端');
    exchange = new ccxt.binance({
      apiKey: config.binance.apiKey,
      secret: config.binance.secret,
      enableRateLimit: true,
      options: { defaultType: 'future' },
    });
    applyTestnetUrls(exchange);
  } else {
    logger.info('正在初始化 ccxt 币安合约实盘客户端');
    exchange = new ccxt.binance({
      apiKey: config.binanceLive.apiKey,
      secret: config.binanceLive.secret,
      enableRateLimit: true,
      options: { defaultType: 'future' },
    });
  }

  applyProxy(exchange);
  logger.info('交易所客户端已初始化' + (getProxyAgent() ? '（使用代理）' : ''));
  return exchange;
}

/**
 * Public-only exchange (no API key) for market data.
 * In testnet mode, uses testnet URLs so prices match the trading environment.
 */
export function getPublicExchange(): Exchange {
  if (publicExchange) return publicExchange;

  publicExchange = new ccxt.binance({
    enableRateLimit: true,
    options: { defaultType: 'future' },
  });

  // Testnet mode: use testnet URLs so prices match the trading environment
  if (config.testnetOnly) {
    applyTestnetUrls(publicExchange);
  }

  applyProxy(publicExchange);
  return publicExchange;
}
