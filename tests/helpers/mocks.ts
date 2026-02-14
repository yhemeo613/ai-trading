/**
 * Shared mock utilities for the trading bot test suite.
 *
 * Usage:
 *   import { createMockExchange, createMockAIProvider, ... } from '../helpers/mocks';
 */

import { vi } from 'vitest';
import type { AIProvider, AIMessage, AIResponse } from '../../src/ai/provider';
import type { AccountBalance, PositionInfo } from '../../src/exchange/account';
import type { AIDecision } from '../../src/core/decision';

// ─── Exchange Mocks ──────────────────────────────────────────────

/** Minimal mock of a ccxt Exchange instance. */
export function createMockExchange(overrides: Record<string, any> = {}) {
  return {
    fetchBalance: vi.fn().mockResolvedValue({
      total: { USDT: 10000 },
      free: { USDT: 8000 },
      used: { USDT: 2000 },
    }),
    fetchPositions: vi.fn().mockResolvedValue([]),
    fetchOHLCV: vi.fn().mockResolvedValue([]),
    fetchTicker: vi.fn().mockResolvedValue({ last: 50000, bid: 49999, ask: 50001 }),
    fetchOrderBook: vi.fn().mockResolvedValue({ bids: [], asks: [] }),
    createOrder: vi.fn().mockResolvedValue({ id: 'mock-order-1', status: 'closed' }),
    setLeverage: vi.fn().mockResolvedValue(undefined),
    loadMarkets: vi.fn().mockResolvedValue({}),
    markets: {},
    urls: { api: {}, test: {} },
    ...overrides,
  };
}

// ─── AI Provider Mocks ──────────────────────────────────────────

/** Creates a mock AIProvider that returns a configurable response. */
export function createMockAIProvider(response?: Partial<AIResponse>): AIProvider {
  const defaultResponse: AIResponse = {
    content: JSON.stringify({
      action: 'HOLD',
      symbol: 'BTC/USDT:USDT',
      confidence: 0.5,
      reasoning: 'Mock AI decision',
      params: null,
    }),
    provider: 'mock',
    model: 'mock-model',
    usage: { promptTokens: 100, completionTokens: 50 },
    ...response,
  };

  return {
    name: 'mock',
    isAvailable: vi.fn().mockReturnValue(true),
    chat: vi.fn().mockResolvedValue(defaultResponse),
  };
}

// ─── Account / Position Fixtures ────────────────────────────────

export function createMockBalance(overrides: Partial<AccountBalance> = {}): AccountBalance {
  return {
    totalBalance: 10000,
    availableBalance: 8000,
    usedMargin: 2000,
    ...overrides,
  };
}

export function createMockPosition(overrides: Partial<PositionInfo> = {}): PositionInfo {
  return {
    symbol: 'BTC/USDT:USDT',
    side: 'long',
    contracts: 0.01,
    notional: 500,
    entryPrice: 50000,
    markPrice: 51000,
    unrealizedPnl: 10,
    leverage: 5,
    marginMode: 'cross',
    percentage: 2,
    ...overrides,
  };
}

// ─── Decision Fixtures ──────────────────────────────────────────

export function createMockDecision(overrides: Partial<AIDecision> = {}): AIDecision {
  return {
    action: 'HOLD',
    symbol: 'BTC/USDT:USDT',
    confidence: 0.7,
    reasoning: 'Test decision',
    params: null,
    ...overrides,
  };
}

// ─── Database Mocks ─────────────────────────────────────────────

/** Creates a mock better-sqlite3 Database with common methods. */
export function createMockDb() {
  const mockStatement = {
    run: vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: 1 }),
    get: vi.fn().mockReturnValue(undefined),
    all: vi.fn().mockReturnValue([]),
  };

  return {
    prepare: vi.fn().mockReturnValue(mockStatement),
    exec: vi.fn(),
    pragma: vi.fn(),
    close: vi.fn(),
    // Expose the inner statement mock for assertions
    _statement: mockStatement,
  };
}
