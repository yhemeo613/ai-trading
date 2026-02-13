import { getExchange, getPublicExchange } from './client';
import { logger } from '../utils/logger';
import { retry } from '../utils/retry';

export interface MarketSnapshot {
  symbol: string;
  ticker: {
    last: number;
    bid: number;
    ask: number;
    volume: number;
    quoteVolume: number;
    percentage: number;
  };
  klines: {
    '1h': any[][];
    '4h': any[][];
    '1d': any[][];
  };
  orderbook: {
    bids: [number, number][];
    asks: [number, number][];
  };
  fundingRate: number | null;
}

export async function fetchTicker(symbol: string) {
  const ex = getPublicExchange();
  return retry(() => ex.fetchTicker(symbol), `fetchTicker(${symbol})`);
}

export async function fetchKlines(symbol: string, timeframe: string, limit = 50) {
  const ex = getPublicExchange();
  return retry(() => ex.fetchOHLCV(symbol, timeframe, undefined, limit), `fetchKlines(${symbol},${timeframe})`);
}

export async function fetchOrderbook(symbol: string, limit = 20) {
  const ex = getPublicExchange();
  return retry(() => ex.fetchOrderBook(symbol, limit), `fetchOrderbook(${symbol})`);
}

export async function fetchFundingRate(symbol: string): Promise<number | null> {
  try {
    const ex = getPublicExchange();
    const rate = await retry(() => ex.fetchFundingRate(symbol), `fetchFundingRate(${symbol})`);
    return rate?.fundingRate ?? null;
  } catch {
    logger.warn(`Failed to fetch funding rate for ${symbol}`);
    return null;
  }
}

export async function fetchTopSymbolsByVolume(limit = 30): Promise<string[]> {
  const ex = getPublicExchange();
  const tickers = await retry(() => ex.fetchTickers(), 'fetchTickers');
  return Object.values(tickers)
    .filter((t) => t.symbol.endsWith('/USDT') && t.quoteVolume && t.quoteVolume > 0)
    .sort((a, b) => (b.quoteVolume ?? 0) - (a.quoteVolume ?? 0))
    .slice(0, limit)
    .map((t) => t.symbol);
}

export async function fetchMarketSnapshot(symbol: string): Promise<MarketSnapshot> {
  const [ticker, klines1h, klines4h, klines1d, orderbook, fundingRate] = await Promise.all([
    fetchTicker(symbol),
    fetchKlines(symbol, '1h'),
    fetchKlines(symbol, '4h'),
    fetchKlines(symbol, '1d'),
    fetchOrderbook(symbol),
    fetchFundingRate(symbol),
  ]);

  return {
    symbol,
    ticker: {
      last: ticker.last ?? 0,
      bid: ticker.bid ?? 0,
      ask: ticker.ask ?? 0,
      volume: ticker.baseVolume ?? 0,
      quoteVolume: ticker.quoteVolume ?? 0,
      percentage: ticker.percentage ?? 0,
    },
    klines: {
      '1h': klines1h,
      '4h': klines4h,
      '1d': klines1d,
    },
    orderbook: {
      bids: orderbook.bids.slice(0, 10) as [number, number][],
      asks: orderbook.asks.slice(0, 10) as [number, number][],
    },
    fundingRate,
  };
}
