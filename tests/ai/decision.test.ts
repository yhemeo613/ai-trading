import { describe, it, expect } from 'vitest';
import {
  parseAIDecision,
  parsePairSelection,
  parsePortfolioReview,
  parseStrategicOutput,
  extractThinking,
  AIDecisionSchema,
  TradeParamsSchema,
  StrategicOutputSchema,
  PortfolioReviewSchema,
  PairSelectionSchema,
} from '../../src/core/decision';

// ─── extractThinking ────────────────────────────────────────────

describe('extractThinking', () => {
  it('extracts think tags and returns rest', () => {
    const raw = '<think>some reasoning here</think>{"action":"HOLD"}';
    const { thinking, rest } = extractThinking(raw);
    expect(thinking).toBe('some reasoning here');
    expect(rest).toBe('{"action":"HOLD"}');
  });

  it('handles multiline think content', () => {
    const raw = '<think>\nline1\nline2\n</think>\n{"action":"HOLD"}';
    const { thinking, rest } = extractThinking(raw);
    expect(thinking).toBe('line1\nline2');
    expect(rest).toBe('{"action":"HOLD"}');
  });

  it('returns empty thinking when no think tags', () => {
    const raw = '{"action":"HOLD"}';
    const { thinking, rest } = extractThinking(raw);
    expect(thinking).toBe('');
    expect(rest).toBe('{"action":"HOLD"}');
  });

  it('handles empty think tags', () => {
    const raw = '<think></think>{"action":"HOLD"}';
    const { thinking, rest } = extractThinking(raw);
    expect(thinking).toBe('');
    expect(rest).toBe('{"action":"HOLD"}');
  });
});

// ─── JSON extraction (via parseAIDecision) ──────────────────────

describe('parseAIDecision', () => {
  const validDecision = {
    action: 'LONG',
    symbol: 'BTC/USDT:USDT',
    confidence: 0.85,
    reasoning: 'Bullish breakout',
    params: { positionSizePercent: 5, leverage: 3, stopLossPrice: 60000, takeProfitPrice: 72000 },
  };

  it('parses clean JSON', () => {
    const result = parseAIDecision(JSON.stringify(validDecision));
    expect(result.action).toBe('LONG');
    expect(result.symbol).toBe('BTC/USDT:USDT');
    expect(result.confidence).toBe(0.85);
    expect(result.params?.positionSizePercent).toBe(5);
  });

  it('parses JSON with surrounding text', () => {
    const raw = 'Here is my analysis:\n' + JSON.stringify(validDecision) + '\nEnd of response.';
    const result = parseAIDecision(raw);
    expect(result.action).toBe('LONG');
  });

  it('parses JSON with think tags', () => {
    const raw = '<think>I analyzed the chart and see a breakout pattern.</think>\n' + JSON.stringify(validDecision);
    const result = parseAIDecision(raw);
    expect(result.action).toBe('LONG');
    expect(result.thinking).toBe('I analyzed the chart and see a breakout pattern.');
  });

  it('handles null params', () => {
    const raw = JSON.stringify({ ...validDecision, params: null });
    const result = parseAIDecision(raw);
    expect(result.params).toBeNull();
  });

  it('handles params with null fields (converts to empty -> null)', () => {
    const raw = JSON.stringify({
      ...validDecision,
      params: { positionSizePercent: null, leverage: null },
    });
    const result = parseAIDecision(raw);
    // All null fields stripped, empty object becomes null
    expect(result.params).toBeNull();
  });

  it('handles params with mix of null and valid fields', () => {
    const raw = JSON.stringify({
      ...validDecision,
      params: { positionSizePercent: 5, leverage: null, stopLossPrice: 60000 },
    });
    const result = parseAIDecision(raw);
    expect(result.params?.positionSizePercent).toBe(5);
    expect(result.params?.stopLossPrice).toBe(60000);
    expect(result.params?.leverage).toBeUndefined();
  });

  // All action types
  it.each(['LONG', 'SHORT', 'HOLD', 'CLOSE', 'ADD', 'REDUCE', 'ADJUST'] as const)(
    'accepts action type %s',
    (action) => {
      const raw = JSON.stringify({ ...validDecision, action, params: null });
      const result = parseAIDecision(raw);
      expect(result.action).toBe(action);
    },
  );

  it('rejects invalid action type', () => {
    const raw = JSON.stringify({ ...validDecision, action: 'BUY' });
    expect(() => parseAIDecision(raw)).toThrow();
  });

  it('rejects confidence > 1', () => {
    const raw = JSON.stringify({ ...validDecision, confidence: 1.5 });
    expect(() => parseAIDecision(raw)).toThrow();
  });

  it('rejects confidence < 0', () => {
    const raw = JSON.stringify({ ...validDecision, confidence: -0.1 });
    expect(() => parseAIDecision(raw)).toThrow();
  });

  it('rejects missing required fields', () => {
    const raw = JSON.stringify({ action: 'HOLD' });
    expect(() => parseAIDecision(raw)).toThrow();
  });

  it('throws on no JSON in response', () => {
    expect(() => parseAIDecision('No JSON here at all')).toThrow('AI 响应中未找到 JSON');
  });

  it('throws on incomplete JSON', () => {
    expect(() => parseAIDecision('{"action": "HOLD"')).toThrow('AI 响应中 JSON 不完整');
  });

  it('parses JSON with markdown code fences', () => {
    const raw = '```json\n' + JSON.stringify(validDecision) + '\n```';
    const result = parseAIDecision(raw);
    expect(result.action).toBe('LONG');
  });

  it('handles optional marketRegime field', () => {
    const raw = JSON.stringify({ ...validDecision, marketRegime: 'trending_up' });
    const result = parseAIDecision(raw);
    expect(result.marketRegime).toBe('trending_up');
  });
});

// ─── Zod schemas ────────────────────────────────────────────────

describe('AIDecisionSchema', () => {
  it('validates a complete decision', () => {
    const result = AIDecisionSchema.safeParse({
      action: 'SHORT',
      symbol: 'ETH/USDT:USDT',
      confidence: 0.7,
      reasoning: 'Bearish divergence',
      params: { positionSizePercent: 3, leverage: 5 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects negative leverage in params', () => {
    const result = TradeParamsSchema.safeParse({ leverage: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects addPercent > 100', () => {
    const result = TradeParamsSchema.safeParse({ addPercent: 150 });
    expect(result.success).toBe(false);
  });
});

// ─── parsePairSelection ─────────────────────────────────────────

describe('parsePairSelection', () => {
  it('parses valid pair selection', () => {
    const raw = JSON.stringify({ symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT'], reasoning: 'High volume' });
    const result = parsePairSelection(raw);
    expect(result.symbols).toHaveLength(2);
    expect(result.reasoning).toBe('High volume');
  });

  it('rejects empty symbols array', () => {
    const raw = JSON.stringify({ symbols: [], reasoning: 'None' });
    expect(() => parsePairSelection(raw)).toThrow();
  });

  it('rejects more than 5 symbols', () => {
    const raw = JSON.stringify({
      symbols: ['A', 'B', 'C', 'D', 'E', 'F'],
      reasoning: 'Too many',
    });
    expect(() => parsePairSelection(raw)).toThrow();
  });
});

// ─── parsePortfolioReview ───────────────────────────────────────

describe('parsePortfolioReview', () => {
  it('parses valid portfolio review', () => {
    const raw = JSON.stringify({
      actions: [
        { symbol: 'BTC/USDT:USDT', action: 'HOLD', reasoning: 'On track' },
        {
          symbol: 'ETH/USDT:USDT',
          action: 'ADJUST',
          reasoning: 'Tighten stop',
          adjustParams: { newStopLoss: 3000 },
        },
      ],
      overallAssessment: 'Portfolio is balanced',
    });
    const result = parsePortfolioReview(raw);
    expect(result.actions).toHaveLength(2);
    expect(result.actions[1].adjustParams?.newStopLoss).toBe(3000);
  });

  it('rejects invalid action in portfolio review', () => {
    const raw = JSON.stringify({
      actions: [{ symbol: 'BTC/USDT:USDT', action: 'BUY', reasoning: 'Invalid' }],
      overallAssessment: 'Bad',
    });
    expect(() => parsePortfolioReview(raw)).toThrow();
  });
});

// ─── parseStrategicOutput ───────────────────────────────────────

describe('parseStrategicOutput', () => {
  const validStrategic = {
    marketRegime: 'trending_up',
    bias: 'bullish',
    reasoning: 'Strong uptrend with volume confirmation',
    plan: {
      action: 'CREATE',
      direction: 'LONG',
      entryCondition: 'Pullback to support',
      entryZoneLow: 65000,
      entryZoneHigh: 66000,
      targets: [{ price: 70000, percent: 50 }, { price: 75000, percent: 50 }],
      stopLoss: 63000,
      confidence: 0.8,
      thesis: 'Bullish continuation',
    },
  };

  it('parses valid strategic output', () => {
    const result = parseStrategicOutput(JSON.stringify(validStrategic));
    expect(result.marketRegime).toBe('trending_up');
    expect(result.bias).toBe('bullish');
    expect(result.plan.action).toBe('CREATE');
    expect(result.plan.targets).toHaveLength(2);
  });

  it('parses with think tags', () => {
    const raw = '<think>Analyzing macro conditions...</think>\n' + JSON.stringify(validStrategic);
    const result = parseStrategicOutput(raw);
    expect(result.thinking).toBe('Analyzing macro conditions...');
    expect(result.plan.action).toBe('CREATE');
  });

  it('handles null plan fields (strips them)', () => {
    const withNulls = {
      ...validStrategic,
      plan: { action: 'NONE', direction: null, targets: null, stopLoss: null },
    };
    const result = parseStrategicOutput(JSON.stringify(withNulls));
    expect(result.plan.action).toBe('NONE');
    expect(result.plan.direction).toBeUndefined();
  });

  it('rejects invalid market regime', () => {
    const raw = JSON.stringify({ ...validStrategic, marketRegime: 'chaotic' });
    expect(() => parseStrategicOutput(raw)).toThrow();
  });

  it('rejects invalid bias', () => {
    const raw = JSON.stringify({ ...validStrategic, bias: 'sideways' });
    expect(() => parseStrategicOutput(raw)).toThrow();
  });
});
