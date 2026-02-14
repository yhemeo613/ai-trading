import { describe, it, expect } from 'vitest';
import { calcIndicators, analyzeOrderbook, calcSentiment, TechnicalIndicators } from '../../src/analysis/indicators';

// Helper: generate synthetic kline data as raw arrays [ts, o, h, l, c, v]
function makeKlines(closes: number[], baseTs = 1700000000000): any[][] {
  return closes.map((c, i) => {
    const o = c - 0.5 + Math.random();
    const h = Math.max(o, c) + Math.random() * 2;
    const l = Math.min(o, c) - Math.random() * 2;
    const v = 100 + Math.random() * 500;
    return [baseTs + i * 60000, o, h, l, c, v];
  });
}

// Generate a simple trending series
function trendingSeries(start: number, step: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => start + step * i);
}

// Generate a flat series
function flatSeries(value: number, count: number): number[] {
  return Array.from({ length: count }, () => value);
}

describe('calcIndicators', () => {
  it('returns empty indicators for fewer than 10 candles', () => {
    const raw = makeKlines([100, 101, 102]);
    const result = calcIndicators(raw);
    expect(result.ema7).toBeNull();
    expect(result.rsi14).toBeNull();
    expect(result.macd).toBeNull();
    expect(result.emaTrend).toBe('交织');
    expect(result.adxSignal).toBe('无趋势');
  });

  it('returns empty indicators for empty array', () => {
    const result = calcIndicators([]);
    expect(result.ema7).toBeNull();
    expect(result.rsi14).toBeNull();
    expect(result.bollingerBands).toBeNull();
  });

  it('computes EMA7 for sufficient data', () => {
    // 20 candles should be enough for EMA7
    const closes = trendingSeries(100, 1, 20);
    const raw = makeKlines(closes);
    const result = calcIndicators(raw);
    expect(result.ema7).not.toBeNull();
    expect(typeof result.ema7).toBe('number');
    expect(Number.isFinite(result.ema7!)).toBe(true);
  });

  it('computes EMA21 for sufficient data', () => {
    const closes = trendingSeries(100, 0.5, 30);
    const raw = makeKlines(closes);
    const result = calcIndicators(raw);
    expect(result.ema21).not.toBeNull();
    expect(Number.isFinite(result.ema21!)).toBe(true);
  });

  it('returns null EMA50 when fewer than 50 candles', () => {
    const closes = trendingSeries(100, 1, 30);
    const raw = makeKlines(closes);
    const result = calcIndicators(raw);
    // With only 30 candles, EMA50 should be null (bug fix verification)
    expect(result.ema50).toBeNull();
  });

  it('computes EMA50 when 50+ candles available', () => {
    const closes = trendingSeries(100, 0.2, 60);
    const raw = makeKlines(closes);
    const result = calcIndicators(raw);
    expect(result.ema50).not.toBeNull();
    expect(Number.isFinite(result.ema50!)).toBe(true);
  });

  it('detects bullish EMA alignment', () => {
    // Strong uptrend: EMA7 > EMA21 > EMA50
    const closes = trendingSeries(100, 2, 60);
    const raw = makeKlines(closes);
    const result = calcIndicators(raw);
    expect(result.emaTrend).toBe('多头排列');
  });

  it('detects bearish EMA alignment', () => {
    // Strong downtrend: EMA7 < EMA21 < EMA50
    const closes = trendingSeries(200, -2, 60);
    const raw = makeKlines(closes);
    const result = calcIndicators(raw);
    expect(result.emaTrend).toBe('空头排列');
  });

  it('computes RSI14 in valid range', () => {
    const closes = trendingSeries(100, 0.5, 30);
    const raw = makeKlines(closes);
    const result = calcIndicators(raw);
    expect(result.rsi14).not.toBeNull();
    expect(result.rsi14!).toBeGreaterThanOrEqual(0);
    expect(result.rsi14!).toBeLessThanOrEqual(100);
  });

  it('signals RSI overbought on strong uptrend', () => {
    // Very strong uptrend should push RSI high
    const closes = trendingSeries(100, 5, 30);
    const raw = makeKlines(closes);
    const result = calcIndicators(raw);
    if (result.rsi14 !== null && result.rsi14 > 70) {
      expect(result.rsiSignal).toBe('超买');
    }
  });

  it('signals RSI oversold on strong downtrend', () => {
    const closes = trendingSeries(300, -5, 30);
    const raw = makeKlines(closes);
    const result = calcIndicators(raw);
    if (result.rsi14 !== null && result.rsi14 < 30) {
      expect(result.rsiSignal).toBe('超卖');
    }
  });

  it('computes Bollinger Bands with valid structure', () => {
    const closes = trendingSeries(100, 0.3, 30);
    const raw = makeKlines(closes);
    const result = calcIndicators(raw);
    expect(result.bollingerBands).not.toBeNull();
    if (result.bollingerBands) {
      expect(result.bollingerBands.upper).toBeGreaterThan(result.bollingerBands.middle);
      expect(result.bollingerBands.middle).toBeGreaterThan(result.bollingerBands.lower);
      expect(Number.isFinite(result.bollingerBands.width)).toBe(true);
      expect(Number.isFinite(result.bollingerBands.percentB)).toBe(true);
    }
  });

  it('handles flat price series without NaN in Bollinger Bands', () => {
    // All same price -> upper === lower, should not produce NaN (bug fix verification)
    const closes = flatSeries(100, 30);
    const raw = makeKlines(closes);
    // Override to make exact flat klines
    const flatRaw = closes.map((c, i) => [1700000000000 + i * 60000, c, c, c, c, 100]);
    const result = calcIndicators(flatRaw);
    if (result.bollingerBands) {
      expect(Number.isFinite(result.bollingerBands.percentB)).toBe(true);
      expect(Number.isNaN(result.bollingerBands.percentB)).toBe(false);
      expect(Number.isFinite(result.bollingerBands.width)).toBe(true);
    }
  });

  it('computes MACD with valid structure', () => {
    const closes = trendingSeries(100, 0.3, 40);
    const raw = makeKlines(closes);
    const result = calcIndicators(raw);
    if (result.macd) {
      expect(typeof result.macd.macd).toBe('number');
      expect(typeof result.macd.signal).toBe('number');
      expect(typeof result.macd.histogram).toBe('number');
      expect(Number.isFinite(result.macd.macd)).toBe(true);
    }
  });

  it('computes ATR and ATR percent', () => {
    const closes = trendingSeries(100, 0.5, 30);
    const raw = makeKlines(closes);
    const result = calcIndicators(raw);
    expect(result.atr14).not.toBeNull();
    expect(result.atrPercent).not.toBeNull();
    if (result.atrPercent !== null) {
      expect(result.atrPercent).toBeGreaterThan(0);
      expect(Number.isFinite(result.atrPercent)).toBe(true);
    }
  });

  it('computes volume ratio when enough data', () => {
    const closes = trendingSeries(100, 0.3, 30);
    const raw = makeKlines(closes);
    const result = calcIndicators(raw);
    if (result.volumeRatio !== null) {
      expect(result.volumeRatio).toBeGreaterThan(0);
      expect(Number.isFinite(result.volumeRatio)).toBe(true);
    }
  });

  it('handles NaN values in input gracefully', () => {
    const closes = trendingSeries(100, 1, 20);
    closes[10] = NaN;
    const raw = makeKlines(closes);
    // Should not throw
    expect(() => calcIndicators(raw)).not.toThrow();
  });

  it('handles single candle without crashing', () => {
    const raw = makeKlines([100]);
    const result = calcIndicators(raw);
    expect(result.ema7).toBeNull();
  });
});

describe('analyzeOrderbook', () => {
  it('computes bid/ask totals correctly', () => {
    const bids: [number, number][] = [[100, 10], [99, 20], [98, 30]];
    const asks: [number, number][] = [[101, 15], [102, 25], [103, 10]];
    const result = analyzeOrderbook(bids, asks);
    expect(result.bidTotal).toBe(60);
    expect(result.askTotal).toBe(50);
  });

  it('computes bid/ask ratio', () => {
    const bids: [number, number][] = [[100, 30]];
    const asks: [number, number][] = [[101, 10]];
    const result = analyzeOrderbook(bids, asks);
    expect(result.bidAskRatio).toBe(3);
    expect(result.imbalance).toBe('买方主导');
  });

  it('detects seller dominance', () => {
    const bids: [number, number][] = [[100, 5]];
    const asks: [number, number][] = [[101, 20]];
    const result = analyzeOrderbook(bids, asks);
    expect(result.bidAskRatio).toBe(0.25);
    expect(result.imbalance).toBe('卖方主导');
  });

  it('detects balanced orderbook', () => {
    const bids: [number, number][] = [[100, 10]];
    const asks: [number, number][] = [[101, 10]];
    const result = analyzeOrderbook(bids, asks);
    expect(result.bidAskRatio).toBe(1);
    expect(result.imbalance).toBe('均衡');
  });

  it('handles empty orderbook', () => {
    const result = analyzeOrderbook([], []);
    expect(result.bidTotal).toBe(0);
    expect(result.askTotal).toBe(0);
    expect(result.bidWall).toBeNull();
    expect(result.askWall).toBeNull();
    expect(result.spreadPercent).toBe(0);
  });

  it('finds bid and ask walls', () => {
    const bids: [number, number][] = [[100, 5], [99, 50], [98, 10]];
    const asks: [number, number][] = [[101, 3], [102, 100], [103, 7]];
    const result = analyzeOrderbook(bids, asks);
    expect(result.bidWall).toEqual({ price: 99, amount: 50 });
    expect(result.askWall).toEqual({ price: 102, amount: 100 });
  });

  it('computes spread percent', () => {
    const bids: [number, number][] = [[100, 10]];
    const asks: [number, number][] = [[101, 10]];
    const result = analyzeOrderbook(bids, asks);
    expect(result.spreadPercent).toBeCloseTo(1, 1);
  });

  it('computes micro pressure from top 3 levels', () => {
    const bids: [number, number][] = [[100, 10], [99, 20], [98, 30], [97, 100]];
    const asks: [number, number][] = [[101, 5], [102, 10], [103, 15], [104, 200]];
    const result = analyzeOrderbook(bids, asks);
    // top3Bid = 10+20+30 = 60, top3Ask = 5+10+15 = 30
    expect(result.microPressure).toBe(2);
  });
});

describe('calcSentiment', () => {
  function makeEmptyIndicators(): TechnicalIndicators {
    return {
      ema7: null, ema21: null, ema50: null, sma20: null, emaTrend: '交织',
      psar: null, psarTrend: '多',
      rsi14: null, rsiSignal: '中性', macd: null, macdSignal: '中性',
      stochK: null, stochD: null, stochSignal: '中性', williamsR: null, cci: null,
      bollingerBands: null, atr14: null, atrPercent: null,
      adx: null, plusDI: null, minusDI: null, adxSignal: '无趋势',
      obv: null, obvTrend: '平稳', mfi: null, volumeRatio: null, vwap: null,
      ichimoku: null,
    };
  }

  const neutralOrderbook = {
    bidTotal: 100, askTotal: 100, bidAskRatio: 1,
    imbalance: '均衡' as const, bidWall: null, askWall: null,
    spreadPercent: 0.01, microPressure: 1,
  };

  it('returns score in [-100, 100] range', () => {
    const indicators = { '5m': makeEmptyIndicators() };
    const result = calcSentiment(indicators, neutralOrderbook, null, 0);
    expect(result.score).toBeGreaterThanOrEqual(-100);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('detects extreme greed from high funding rate', () => {
    const indicators = { '5m': makeEmptyIndicators() };
    const result = calcSentiment(indicators, neutralOrderbook, 0.002, 0);
    expect(result.fundingRateSignal).toBe('极度贪婪');
  });

  it('detects extreme fear from negative funding rate', () => {
    const indicators = { '5m': makeEmptyIndicators() };
    const result = calcSentiment(indicators, neutralOrderbook, -0.002, 0);
    expect(result.fundingRateSignal).toBe('极度恐惧');
  });

  it('produces bullish bias for bullish indicators', () => {
    const bullInd = makeEmptyIndicators();
    bullInd.emaTrend = '多头排列';
    bullInd.macdSignal = '金叉';
    bullInd.rsi14 = 65;
    bullInd.stochSignal = '超卖';
    bullInd.adxSignal = '强趋势';
    bullInd.plusDI = 30;
    bullInd.minusDI = 10;
    const indicators = { '15m': bullInd };
    const result = calcSentiment(indicators, neutralOrderbook, null, 3);
    expect(result.score).toBeGreaterThan(0);
    expect(['偏多', '强多']).toContain(result.overallBias);
  });

  it('produces bearish bias for bearish indicators', () => {
    const bearInd = makeEmptyIndicators();
    bearInd.emaTrend = '空头排列';
    bearInd.macdSignal = '死叉';
    bearInd.rsi14 = 75;
    bearInd.stochSignal = '超买';
    bearInd.adxSignal = '强趋势';
    bearInd.plusDI = 10;
    bearInd.minusDI = 30;
    const indicators = { '15m': bearInd };
    const result = calcSentiment(indicators, neutralOrderbook, null, -3);
    expect(result.score).toBeLessThan(0);
    expect(['偏空', '强空']).toContain(result.overallBias);
  });

  it('detects volume momentum correctly', () => {
    const ind = makeEmptyIndicators();
    ind.volumeRatio = 2.0;
    const indicators = { '5m': ind };
    const result = calcSentiment(indicators, neutralOrderbook, null, 3);
    expect(result.volumeMomentum).toBe('放量上涨');
  });

  it('handles null funding rate', () => {
    const indicators = { '5m': makeEmptyIndicators() };
    const result = calcSentiment(indicators, neutralOrderbook, null, 0);
    expect(result.fundingRateSignal).toBe('中性');
  });
});
