import { describe, it, expect } from 'vitest';
import {
  parseAIDecision,
  parsePairSelection,
  extractThinking,
} from '../../src/core/decision';

describe('parseAIDecision', () => {
  it('parses a valid HOLD decision', () => {
    const raw = JSON.stringify({
      action: 'HOLD',
      symbol: 'BTC/USDT:USDT',
      confidence: 0.6,
      reasoning: 'Market is sideways',
      params: null,
    });
    const result = parseAIDecision(raw);
    expect(result.action).toBe('HOLD');
    expect(result.symbol).toBe('BTC/USDT:USDT');
    expect(result.confidence).toBe(0.6);
  });

  it('parses a LONG decision with params', () => {
    const raw = JSON.stringify({
      action: 'LONG',
      symbol: 'ETH/USDT:USDT',
      confidence: 0.85,
      reasoning: 'Bullish breakout',
      params: {
        positionSizePercent: 5,
        leverage: 3,
        stopLossPrice: 3000,
        takeProfitPrice: 4000,
      },
    });
    const result = parseAIDecision(raw);
    expect(result.action).toBe('LONG');
    expect(result.params?.leverage).toBe(3);
    expect(result.params?.stopLossPrice).toBe(3000);
  });

  it('extracts JSON from surrounding text', () => {
    const raw = `Here is my analysis:\n${JSON.stringify({
      action: 'SHORT',
      symbol: 'BTC/USDT:USDT',
      confidence: 0.7,
      reasoning: 'Bearish divergence',
      params: null,
    })}\nEnd of response.`;
    const result = parseAIDecision(raw);
    expect(result.action).toBe('SHORT');
  });

  it('strips null param values and converts empty params to null', () => {
    const raw = JSON.stringify({
      action: 'HOLD',
      symbol: 'BTC/USDT:USDT',
      confidence: 0.5,
      reasoning: 'Waiting',
      params: { positionSizePercent: null, leverage: null },
    });
    const result = parseAIDecision(raw);
    expect(result.params).toBeNull();
  });

  it('throws on missing JSON', () => {
    expect(() => parseAIDecision('no json here')).toThrow();
  });
});

describe('extractThinking', () => {
  it('extracts think tags', () => {
    const raw = '<think>Internal reasoning here</think>{"action":"HOLD"}';
    const { thinking, rest } = extractThinking(raw);
    expect(thinking).toBe('Internal reasoning here');
    expect(rest).toBe('{"action":"HOLD"}');
  });

  it('returns empty thinking when no tags present', () => {
    const raw = '{"action":"HOLD"}';
    const { thinking, rest } = extractThinking(raw);
    expect(thinking).toBe('');
    expect(rest).toBe('{"action":"HOLD"}');
  });
});

describe('parsePairSelection', () => {
  it('parses valid pair selection', () => {
    const raw = JSON.stringify({
      symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT'],
      reasoning: 'High volume pairs',
    });
    const result = parsePairSelection(raw);
    expect(result.symbols).toHaveLength(2);
    expect(result.symbols[0]).toBe('BTC/USDT:USDT');
  });
});
