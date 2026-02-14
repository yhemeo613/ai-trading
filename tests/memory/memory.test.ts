import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectMarketRegime } from '../../src/memory/memory-context';
import { TechnicalIndicators } from '../../src/analysis/indicators';

// Mock the DB-dependent modules so we don't need a real database
vi.mock('../../src/persistence/db', () => ({
  getDb: () => {
    const rows: any[] = [];
    return {
      prepare: () => ({
        run: vi.fn(() => ({ changes: 0 })),
        get: vi.fn(() => null),
        all: vi.fn(() => rows),
      }),
    };
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function makeIndicators(overrides: Partial<TechnicalIndicators> = {}): TechnicalIndicators {
  return {
    ema7: null, ema21: null, ema50: null, sma20: null, emaTrend: '交织',
    psar: null, psarTrend: '多',
    rsi14: null, rsiSignal: '中性', macd: null, macdSignal: '中性',
    stochK: null, stochD: null, stochSignal: '中性', williamsR: null, cci: null,
    bollingerBands: null, atr14: null, atrPercent: null,
    adx: null, plusDI: null, minusDI: null, adxSignal: '无趋势',
    obv: null, obvTrend: '平稳', mfi: null, volumeRatio: null, vwap: null,
    ichimoku: null,
    ...overrides,
  };
}

describe('detectMarketRegime', () => {
  it('returns "quiet" when no indicators available', () => {
    expect(detectMarketRegime({})).toBe('quiet');
  });

  it('returns "volatile" when ATR percent is high', () => {
    const ind = makeIndicators({ atrPercent: 3.0 });
    expect(detectMarketRegime({ '15m': ind })).toBe('volatile');
  });

  it('returns "trending_up" for strong bullish trend', () => {
    const ind = makeIndicators({
      adx: 30,
      emaTrend: '多头排列',
      atrPercent: 1.0,
    });
    expect(detectMarketRegime({ '15m': ind })).toBe('trending_up');
  });

  it('returns "trending_down" for strong bearish trend', () => {
    const ind = makeIndicators({
      adx: 30,
      emaTrend: '空头排列',
      atrPercent: 1.0,
    });
    expect(detectMarketRegime({ '15m': ind })).toBe('trending_down');
  });

  it('returns "quiet" for low ADX and low ATR', () => {
    const ind = makeIndicators({
      adx: 15,
      atrPercent: 0.3,
    });
    expect(detectMarketRegime({ '15m': ind })).toBe('quiet');
  });

  it('returns "ranging" for low ADX but moderate ATR', () => {
    const ind = makeIndicators({
      adx: 15,
      atrPercent: 0.8,
    });
    expect(detectMarketRegime({ '15m': ind })).toBe('ranging');
  });

  it('returns "trending_up" from RSI + MACD when ADX is moderate', () => {
    const ind = makeIndicators({
      adx: 22,
      rsi14: 60,
      macdSignal: '金叉',
      atrPercent: 1.0,
    });
    expect(detectMarketRegime({ '15m': ind })).toBe('trending_up');
  });

  it('returns "trending_down" from RSI + MACD when ADX is moderate', () => {
    const ind = makeIndicators({
      adx: 22,
      rsi14: 40,
      macdSignal: '死叉',
      atrPercent: 1.0,
    });
    expect(detectMarketRegime({ '15m': ind })).toBe('trending_down');
  });

  it('returns "ranging" as default for ambiguous indicators', () => {
    const ind = makeIndicators({
      adx: 22,
      rsi14: 50,
      macdSignal: '中性',
      atrPercent: 1.0,
    });
    expect(detectMarketRegime({ '15m': ind })).toBe('ranging');
  });

  it('prefers 15m timeframe over 1h', () => {
    const ind15m = makeIndicators({ atrPercent: 3.0 }); // volatile
    const ind1h = makeIndicators({ adx: 30, emaTrend: '多头排列', atrPercent: 1.0 }); // trending_up
    // 15m is checked first
    expect(detectMarketRegime({ '15m': ind15m, '1h': ind1h })).toBe('volatile');
  });

  it('falls back to 1h when 15m is missing', () => {
    const ind1h = makeIndicators({ adx: 30, emaTrend: '空头排列', atrPercent: 1.0 });
    expect(detectMarketRegime({ '1h': ind1h })).toBe('trending_down');
  });

  it('falls back to first available timeframe', () => {
    const ind5m = makeIndicators({ atrPercent: 3.5 });
    expect(detectMarketRegime({ '5m': ind5m })).toBe('volatile');
  });

  it('volatility check takes priority over trend', () => {
    const ind = makeIndicators({
      atrPercent: 2.5,
      adx: 35,
      emaTrend: '多头排列',
    });
    expect(detectMarketRegime({ '15m': ind })).toBe('volatile');
  });
});

describe('memory-store (insertMemory / decayMemories / boostMemory)', () => {
  // These are integration-level tests that verify the function signatures
  // and basic behavior with mocked DB

  it('insertMemory does not throw with mocked DB', async () => {
    const { insertMemory } = await import('../../src/memory/memory-store');
    expect(() => insertMemory({
      symbol: 'BTC/USDT',
      memoryType: 'lesson',
      content: 'Test lesson',
      relevanceScore: 1.0,
    })).not.toThrow();
  });

  it('decayMemories does not throw with mocked DB', async () => {
    const { decayMemories } = await import('../../src/memory/memory-store');
    expect(() => decayMemories()).not.toThrow();
  });

  it('boostMemory does not throw with mocked DB', async () => {
    const { boostMemory } = await import('../../src/memory/memory-store');
    expect(() => boostMemory(1)).not.toThrow();
  });

  it('getRelevantMemories returns array with mocked DB', async () => {
    const { getRelevantMemories } = await import('../../src/memory/memory-store');
    const result = getRelevantMemories('BTC/USDT');
    expect(Array.isArray(result)).toBe(true);
  });

  it('getRelevantMemories with condition returns array', async () => {
    const { getRelevantMemories } = await import('../../src/memory/memory-store');
    const result = getRelevantMemories('BTC/USDT', 'trending_up', 5);
    expect(Array.isArray(result)).toBe(true);
  });

  it('getSymbolStats returns null for unknown symbol', async () => {
    const { getSymbolStats } = await import('../../src/memory/memory-store');
    const result = getSymbolStats('UNKNOWN/USDT');
    expect(result).toBeNull();
  });

  it('getAllSymbolStats returns array', async () => {
    const { getAllSymbolStats } = await import('../../src/memory/memory-store');
    const result = getAllSymbolStats();
    expect(Array.isArray(result)).toBe(true);
  });
});

describe('session-context', () => {
  it('addSessionEvent and getSessionEvents work correctly', async () => {
    const { addSessionEvent, getSessionEvents, clearSessionEvents } = await import('../../src/memory/session-context');
    clearSessionEvents('TEST/USDT');

    addSessionEvent({
      type: 'level_test',
      symbol: 'TEST/USDT',
      timestamp: Date.now(),
      description: 'Testing support at 100',
      price: 100,
    });

    const events = getSessionEvents('TEST/USDT');
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('level_test');
    expect(events[0].description).toBe('Testing support at 100');

    clearSessionEvents('TEST/USDT');
  });

  it('limits events per symbol to MAX_EVENTS_PER_SYMBOL', async () => {
    const { addSessionEvent, getSessionEvents, clearSessionEvents } = await import('../../src/memory/session-context');
    clearSessionEvents('LIMIT/USDT');

    // Add 35 events (max is 30)
    for (let i = 0; i < 35; i++) {
      addSessionEvent({
        type: 'level_test',
        symbol: 'LIMIT/USDT',
        timestamp: Date.now() + i,
        description: `Event ${i}`,
      });
    }

    const events = getSessionEvents('LIMIT/USDT');
    expect(events.length).toBe(30);
    // Should keep the most recent ones
    expect(events[events.length - 1].description).toBe('Event 34');
    expect(events[0].description).toBe('Event 5');

    clearSessionEvents('LIMIT/USDT');
  });

  it('getSessionEvents with limit returns limited results', async () => {
    const { addSessionEvent, getSessionEvents, clearSessionEvents } = await import('../../src/memory/session-context');
    clearSessionEvents('LIM2/USDT');

    for (let i = 0; i < 10; i++) {
      addSessionEvent({
        type: 'volume_anomaly',
        symbol: 'LIM2/USDT',
        timestamp: Date.now() + i,
        description: `Vol event ${i}`,
      });
    }

    const events = getSessionEvents('LIM2/USDT', 3);
    expect(events.length).toBe(3);

    clearSessionEvents('LIM2/USDT');
  });

  it('formatForPrompt returns empty string for no events', async () => {
    const { formatForPrompt, clearSessionEvents } = await import('../../src/memory/session-context');
    clearSessionEvents('EMPTY/USDT');
    expect(formatForPrompt('EMPTY/USDT')).toBe('');
  });

  it('formatForPrompt includes event descriptions', async () => {
    const { addSessionEvent, formatForPrompt, clearSessionEvents } = await import('../../src/memory/session-context');
    clearSessionEvents('FMT/USDT');

    addSessionEvent({
      type: 'regime_change',
      symbol: 'FMT/USDT',
      timestamp: 1700000000000,
      description: 'Regime changed to volatile',
    });

    const output = formatForPrompt('FMT/USDT');
    expect(output).toContain('Regime changed to volatile');
    expect(output).toContain('近期市场事件');

    clearSessionEvents('FMT/USDT');
  });

  it('clearSessionEvents clears all when no symbol given', async () => {
    const { addSessionEvent, getSessionEvents, clearSessionEvents } = await import('../../src/memory/session-context');

    addSessionEvent({ type: 'level_test', symbol: 'A/USDT', timestamp: Date.now(), description: 'a' });
    addSessionEvent({ type: 'level_test', symbol: 'B/USDT', timestamp: Date.now(), description: 'b' });

    clearSessionEvents();

    expect(getSessionEvents('A/USDT').length).toBe(0);
    expect(getSessionEvents('B/USDT').length).toBe(0);
  });
});
