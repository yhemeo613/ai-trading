import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeDecision, setLeverage, closePosition, OrderResult } from '../../src/exchange/executor';
import { AIDecision } from '../../src/core/decision';
import { AccountBalance } from '../../src/exchange/account';

// --- Mock CCXT exchange ---

const mockExchange = {
  setLeverage: vi.fn(),
  createOrder: vi.fn(),
  fetchPositions: vi.fn(),
  amountToPrecision: vi.fn((symbol: string, amount: number) => amount.toFixed(3)),
  priceToPrecision: vi.fn((symbol: string, price: number) => price.toFixed(2)),
};

const mockPublicExchange = {
  fetchTicker: vi.fn(),
};

vi.mock('../../src/exchange/client', () => ({
  getExchange: () => mockExchange,
  getPublicExchange: () => mockPublicExchange,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/utils/retry', () => ({
  retry: async <T>(fn: () => Promise<T>, _label: string) => fn(),
}));

// --- Helpers ---

function makeBalance(available = 10000): AccountBalance {
  return { totalBalance: available, availableBalance: available, usedMargin: 0 };
}

function makeLongDecision(overrides: Partial<AIDecision> = {}): AIDecision {
  return {
    action: 'LONG',
    symbol: 'BTC/USDT:USDT',
    confidence: 0.8,
    reasoning: 'test',
    params: {
      positionSizePercent: 10,
      leverage: 5,
      stopLossPrice: 90000,
      takeProfitPrice: 110000,
      orderType: 'MARKET',
    },
    ...overrides,
  };
}

function makeShortDecision(overrides: Partial<AIDecision> = {}): AIDecision {
  return {
    action: 'SHORT',
    symbol: 'ETH/USDT:USDT',
    confidence: 0.75,
    reasoning: 'test',
    params: {
      positionSizePercent: 8,
      leverage: 3,
      stopLossPrice: 4000,
      takeProfitPrice: 3000,
      orderType: 'MARKET',
    },
    ...overrides,
  };
}

function mockPosition(symbol: string, side: 'long' | 'short', contracts: number) {
  return {
    symbol,
    side,
    contracts,
    notional: contracts * 100000,
    entryPrice: 100000,
    markPrice: 100500,
    unrealizedPnl: 50,
    leverage: 5,
    marginMode: 'cross',
    percentage: 0.5,
  };
}

// --- Tests ---

describe('executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExchange.setLeverage.mockResolvedValue(undefined);
    mockExchange.createOrder.mockResolvedValue({ id: 'order-123', status: 'open', price: 100000 });
    mockExchange.amountToPrecision.mockImplementation((_s: string, a: number) => a.toFixed(3));
    mockExchange.priceToPrecision.mockImplementation((_s: string, p: number) => p.toFixed(2));
    mockPublicExchange.fetchTicker.mockResolvedValue({ last: 100000 });
  });

  // ─── setLeverage ───────────────────────────────────────────────

  describe('setLeverage', () => {
    it('should set leverage on the exchange', async () => {
      mockExchange.setLeverage.mockResolvedValue(undefined);
      await setLeverage('BTC/USDT:USDT', 10);
      expect(mockExchange.setLeverage).toHaveBeenCalledWith(10, 'BTC/USDT:USDT');
    });

    it('should ignore "No need to change" errors', async () => {
      mockExchange.setLeverage.mockRejectedValue(new Error('No need to change leverage'));
      await expect(setLeverage('BTC/USDT:USDT', 10)).resolves.toBeUndefined();
    });

    it('should rethrow other errors', async () => {
      mockExchange.setLeverage.mockRejectedValue(new Error('Network error'));
      await expect(setLeverage('BTC/USDT:USDT', 10)).rejects.toThrow('Network error');
    });
  });

  // ─── HOLD ──────────────────────────────────────────────────────

  describe('HOLD action', () => {
    it('should return null and not place any orders', async () => {
      const decision = makeLongDecision({ action: 'HOLD' });
      const result = await executeDecision(decision, makeBalance());
      expect(result).toBeNull();
      expect(mockExchange.createOrder).not.toHaveBeenCalled();
    });
  });

  // ─── LONG ──────────────────────────────────────────────────────

  describe('LONG action', () => {
    it('should place a market buy order with correct size', async () => {
      const decision = makeLongDecision();
      const balance = makeBalance(10000);

      const result = await executeDecision(decision, balance);

      // positionValue = 10000 * 10% = 1000
      // amount = 1000 * 5 / 100000 = 0.05
      expect(mockExchange.setLeverage).toHaveBeenCalledWith(5, 'BTC/USDT:USDT');
      expect(mockExchange.createOrder).toHaveBeenCalledWith(
        'BTC/USDT:USDT', 'market', 'buy', 0.05
      );
      expect(result).not.toBeNull();
      expect(result!.side).toBe('buy');
      expect(result!.amount).toBe(0.05);
      expect(result!.orderId).toBe('order-123');
    });

    it('should place a limit order when orderType is LIMIT', async () => {
      const decision = makeLongDecision({
        params: {
          positionSizePercent: 10,
          leverage: 5,
          stopLossPrice: 90000,
          takeProfitPrice: 110000,
          orderType: 'LIMIT',
        },
      });

      await executeDecision(decision, makeBalance(10000));

      expect(mockExchange.createOrder).toHaveBeenCalledWith(
        'BTC/USDT:USDT', 'limit', 'buy', 0.05, 100000
      );
    });

    it('should return null if params are missing', async () => {
      const decision = makeLongDecision({ params: null });
      const result = await executeDecision(decision, makeBalance());
      expect(result).toBeNull();
      expect(mockExchange.createOrder).not.toHaveBeenCalled();
    });

    it('should return null if required params are incomplete', async () => {
      const decision = makeLongDecision({
        params: { positionSizePercent: 10 },
      });
      const result = await executeDecision(decision, makeBalance());
      expect(result).toBeNull();
    });

    it('should throw if price is zero', async () => {
      mockPublicExchange.fetchTicker.mockResolvedValue({ last: 0 });
      const decision = makeLongDecision();
      await expect(executeDecision(decision, makeBalance())).rejects.toThrow('价格无效');
    });

    it('should return null if rounded amount is zero', async () => {
      mockExchange.amountToPrecision.mockReturnValue('0.000');
      const decision = makeLongDecision();
      const result = await executeDecision(decision, makeBalance());
      expect(result).toBeNull();
    });
  });

  // ─── SHORT ─────────────────────────────────────────────────────

  describe('SHORT action', () => {
    it('should place a market sell order', async () => {
      mockPublicExchange.fetchTicker.mockResolvedValue({ last: 3500 });
      mockExchange.amountToPrecision.mockImplementation((_s: string, a: number) => a.toFixed(3));
      mockExchange.createOrder.mockResolvedValue({ id: 'order-456', status: 'open', price: 3500 });

      const decision = makeShortDecision();
      const balance = makeBalance(10000);

      const result = await executeDecision(decision, balance);

      // positionValue = 10000 * 8% = 800
      // amount = 800 * 3 / 3500 = 0.685714...
      expect(mockExchange.createOrder).toHaveBeenCalledWith(
        'ETH/USDT:USDT', 'market', 'sell', expect.any(Number)
      );
      expect(result).not.toBeNull();
      expect(result!.side).toBe('sell');
    });
  });

  // ─── CLOSE ─────────────────────────────────────────────────────

  describe('CLOSE action', () => {
    it('should close a long position with sell + reduceOnly', async () => {
      mockExchange.fetchPositions.mockResolvedValue([
        mockPosition('BTC/USDT:USDT', 'long', 0.5),
      ]);
      mockExchange.amountToPrecision.mockImplementation((_s: string, a: number) => a.toFixed(3));

      const decision: AIDecision = {
        action: 'CLOSE',
        symbol: 'BTC/USDT:USDT',
        confidence: 0.9,
        reasoning: 'test close',
        params: null,
      };

      const result = await executeDecision(decision, makeBalance());

      expect(mockExchange.createOrder).toHaveBeenCalledWith(
        'BTC/USDT:USDT', 'market', 'sell', 0.5, undefined, { reduceOnly: true }
      );
      expect(result).not.toBeNull();
      expect(result!.side).toBe('sell');
      expect(result!.status).toBe('closed');
    });

    it('should close a short position with buy + reduceOnly', async () => {
      mockExchange.fetchPositions.mockResolvedValue([
        mockPosition('ETH/USDT:USDT', 'short', 2.0),
      ]);
      mockExchange.amountToPrecision.mockImplementation((_s: string, a: number) => a.toFixed(3));

      const result = await closePosition('ETH/USDT:USDT');

      expect(mockExchange.createOrder).toHaveBeenCalledWith(
        'ETH/USDT:USDT', 'market', 'buy', 2.0, undefined, { reduceOnly: true }
      );
      expect(result!.side).toBe('buy');
    });

    it('should return null if no position exists', async () => {
      mockExchange.fetchPositions.mockResolvedValue([]);
      const result = await closePosition('BTC/USDT:USDT');
      expect(result).toBeNull();
      expect(mockExchange.createOrder).not.toHaveBeenCalled();
    });

    it('should round amount to precision before closing', async () => {
      mockExchange.fetchPositions.mockResolvedValue([
        mockPosition('BTC/USDT:USDT', 'long', 0.123456789),
      ]);
      mockExchange.amountToPrecision.mockReturnValue('0.123');

      await closePosition('BTC/USDT:USDT');

      expect(mockExchange.amountToPrecision).toHaveBeenCalledWith('BTC/USDT:USDT', 0.123456789);
      expect(mockExchange.createOrder).toHaveBeenCalledWith(
        'BTC/USDT:USDT', 'market', 'sell', 0.123, undefined, { reduceOnly: true }
      );
    });

    it('should return null if rounded close amount is zero', async () => {
      mockExchange.fetchPositions.mockResolvedValue([
        mockPosition('BTC/USDT:USDT', 'long', 0.0000001),
      ]);
      mockExchange.amountToPrecision.mockReturnValue('0.000');

      const result = await closePosition('BTC/USDT:USDT');
      expect(result).toBeNull();
      expect(mockExchange.createOrder).not.toHaveBeenCalled();
    });
  });

  // ─── ADD ───────────────────────────────────────────────────────

  describe('ADD action', () => {
    it('should add to a long position in the same direction', async () => {
      mockExchange.fetchPositions.mockResolvedValue([
        mockPosition('BTC/USDT:USDT', 'long', 1.0),
      ]);
      mockExchange.amountToPrecision.mockImplementation((_s: string, a: number) => a.toFixed(3));

      const decision: AIDecision = {
        action: 'ADD',
        symbol: 'BTC/USDT:USDT',
        confidence: 0.7,
        reasoning: 'add to winner',
        params: { addPercent: 25 },
      };

      const result = await executeDecision(decision, makeBalance());

      // addAmount = 1.0 * 25% = 0.25
      expect(mockExchange.createOrder).toHaveBeenCalledWith(
        'BTC/USDT:USDT', 'market', 'buy', 0.25
      );
      expect(result!.side).toBe('buy');
      expect(result!.status).toBe('added');
    });

    it('should add to a short position with sell', async () => {
      mockExchange.fetchPositions.mockResolvedValue([
        mockPosition('ETH/USDT:USDT', 'short', 5.0),
      ]);
      mockExchange.amountToPrecision.mockImplementation((_s: string, a: number) => a.toFixed(3));

      const decision: AIDecision = {
        action: 'ADD',
        symbol: 'ETH/USDT:USDT',
        confidence: 0.7,
        reasoning: 'add to short',
        params: { addPercent: 50 },
      };

      const result = await executeDecision(decision, makeBalance());

      expect(mockExchange.createOrder).toHaveBeenCalledWith(
        'ETH/USDT:USDT', 'market', 'sell', 2.5
      );
      expect(result!.side).toBe('sell');
    });

    it('should default to 50% addPercent if not specified', async () => {
      mockExchange.fetchPositions.mockResolvedValue([
        mockPosition('BTC/USDT:USDT', 'long', 2.0),
      ]);
      mockExchange.amountToPrecision.mockImplementation((_s: string, a: number) => a.toFixed(3));

      const decision: AIDecision = {
        action: 'ADD',
        symbol: 'BTC/USDT:USDT',
        confidence: 0.7,
        reasoning: 'add default',
        params: {},
      };

      const result = await executeDecision(decision, makeBalance());

      // addAmount = 2.0 * 50% = 1.0
      expect(mockExchange.createOrder).toHaveBeenCalledWith(
        'BTC/USDT:USDT', 'market', 'buy', 1.0
      );
    });

    it('should return null if no position exists', async () => {
      mockExchange.fetchPositions.mockResolvedValue([]);
      const decision: AIDecision = {
        action: 'ADD',
        symbol: 'BTC/USDT:USDT',
        confidence: 0.7,
        reasoning: 'add',
        params: { addPercent: 25 },
      };
      const result = await executeDecision(decision, makeBalance());
      expect(result).toBeNull();
    });

    it('should return null if params are null', async () => {
      const decision: AIDecision = {
        action: 'ADD',
        symbol: 'BTC/USDT:USDT',
        confidence: 0.7,
        reasoning: 'add',
        params: null,
      };
      const result = await executeDecision(decision, makeBalance());
      expect(result).toBeNull();
    });
  });

  // ─── REDUCE ────────────────────────────────────────────────────

  describe('REDUCE action', () => {
    it('should reduce a long position with sell + reduceOnly', async () => {
      mockExchange.fetchPositions.mockResolvedValue([
        mockPosition('BTC/USDT:USDT', 'long', 2.0),
      ]);
      mockExchange.amountToPrecision.mockImplementation((_s: string, a: number) => a.toFixed(3));

      const decision: AIDecision = {
        action: 'REDUCE',
        symbol: 'BTC/USDT:USDT',
        confidence: 0.6,
        reasoning: 'take profit',
        params: { reducePercent: 50 },
      };

      const result = await executeDecision(decision, makeBalance());

      // reduceAmount = 2.0 * 50% = 1.0
      expect(mockExchange.createOrder).toHaveBeenCalledWith(
        'BTC/USDT:USDT', 'market', 'sell', 1.0, undefined, { reduceOnly: true }
      );
      expect(result!.side).toBe('sell');
      expect(result!.status).toBe('reduced');
    });

    it('should reduce a short position with buy + reduceOnly', async () => {
      mockExchange.fetchPositions.mockResolvedValue([
        mockPosition('ETH/USDT:USDT', 'short', 4.0),
      ]);
      mockExchange.amountToPrecision.mockImplementation((_s: string, a: number) => a.toFixed(3));

      const decision: AIDecision = {
        action: 'REDUCE',
        symbol: 'ETH/USDT:USDT',
        confidence: 0.6,
        reasoning: 'reduce short',
        params: { reducePercent: 25 },
      };

      const result = await executeDecision(decision, makeBalance());

      expect(mockExchange.createOrder).toHaveBeenCalledWith(
        'ETH/USDT:USDT', 'market', 'buy', 1.0, undefined, { reduceOnly: true }
      );
      expect(result!.side).toBe('buy');
    });

    it('should default to 30% reducePercent if not specified', async () => {
      mockExchange.fetchPositions.mockResolvedValue([
        mockPosition('BTC/USDT:USDT', 'long', 10.0),
      ]);
      mockExchange.amountToPrecision.mockImplementation((_s: string, a: number) => a.toFixed(3));

      const decision: AIDecision = {
        action: 'REDUCE',
        symbol: 'BTC/USDT:USDT',
        confidence: 0.6,
        reasoning: 'reduce default',
        params: {},
      };

      const result = await executeDecision(decision, makeBalance());

      // reduceAmount = 10.0 * 30% = 3.0
      expect(mockExchange.createOrder).toHaveBeenCalledWith(
        'BTC/USDT:USDT', 'market', 'sell', 3.0, undefined, { reduceOnly: true }
      );
    });

    it('should return null if no position exists', async () => {
      mockExchange.fetchPositions.mockResolvedValue([]);
      const decision: AIDecision = {
        action: 'REDUCE',
        symbol: 'BTC/USDT:USDT',
        confidence: 0.6,
        reasoning: 'reduce',
        params: { reducePercent: 50 },
      };
      const result = await executeDecision(decision, makeBalance());
      expect(result).toBeNull();
    });
  });

  // ─── ADJUST ────────────────────────────────────────────────────

  describe('ADJUST action', () => {
    it('should return adjusted result for existing position', async () => {
      mockExchange.fetchPositions.mockResolvedValue([
        mockPosition('BTC/USDT:USDT', 'long', 1.0),
      ]);

      const decision: AIDecision = {
        action: 'ADJUST',
        symbol: 'BTC/USDT:USDT',
        confidence: 0.7,
        reasoning: 'tighten SL',
        params: { stopLossPrice: 95000, takeProfitPrice: 115000 },
      };

      const result = await executeDecision(decision, makeBalance());

      // ADJUST does not place exchange orders (SL/TP tracked in DB)
      expect(mockExchange.createOrder).not.toHaveBeenCalled();
      expect(result).not.toBeNull();
      expect(result!.type).toBe('ADJUST');
      expect(result!.status).toBe('adjusted');
      expect(result!.amount).toBe(1.0);
    });

    it('should return null if no position exists', async () => {
      mockExchange.fetchPositions.mockResolvedValue([]);
      const decision: AIDecision = {
        action: 'ADJUST',
        symbol: 'BTC/USDT:USDT',
        confidence: 0.7,
        reasoning: 'adjust',
        params: { stopLossPrice: 95000 },
      };
      const result = await executeDecision(decision, makeBalance());
      expect(result).toBeNull();
    });

    it('should return null if params are null', async () => {
      const decision: AIDecision = {
        action: 'ADJUST',
        symbol: 'BTC/USDT:USDT',
        confidence: 0.7,
        reasoning: 'adjust',
        params: null,
      };
      const result = await executeDecision(decision, makeBalance());
      expect(result).toBeNull();
    });
  });

  // ─── Precision rounding ────────────────────────────────────────

  describe('precision rounding', () => {
    it('should use amountToPrecision for LONG order amounts', async () => {
      mockExchange.amountToPrecision.mockReturnValue('0.050');
      const decision = makeLongDecision();
      await executeDecision(decision, makeBalance(10000));
      expect(mockExchange.amountToPrecision).toHaveBeenCalledWith('BTC/USDT:USDT', expect.any(Number));
    });

    it('should use priceToPrecision for LIMIT orders', async () => {
      mockExchange.amountToPrecision.mockReturnValue('0.050');
      mockExchange.priceToPrecision.mockReturnValue('100000.00');
      const decision = makeLongDecision({
        params: {
          positionSizePercent: 10,
          leverage: 5,
          stopLossPrice: 90000,
          takeProfitPrice: 110000,
          orderType: 'LIMIT',
        },
      });
      await executeDecision(decision, makeBalance(10000));
      expect(mockExchange.priceToPrecision).toHaveBeenCalledWith('BTC/USDT:USDT', 100000);
    });

    it('should use amountToPrecision for ADD amounts', async () => {
      mockExchange.fetchPositions.mockResolvedValue([
        mockPosition('BTC/USDT:USDT', 'long', 1.123456),
      ]);
      mockExchange.amountToPrecision.mockReturnValue('0.562');

      const decision: AIDecision = {
        action: 'ADD',
        symbol: 'BTC/USDT:USDT',
        confidence: 0.7,
        reasoning: 'add',
        params: { addPercent: 50 },
      };

      await executeDecision(decision, makeBalance());
      expect(mockExchange.amountToPrecision).toHaveBeenCalledWith('BTC/USDT:USDT', expect.closeTo(0.561728, 4));
    });

    it('should use amountToPrecision for REDUCE amounts', async () => {
      mockExchange.fetchPositions.mockResolvedValue([
        mockPosition('BTC/USDT:USDT', 'long', 3.789),
      ]);
      mockExchange.amountToPrecision.mockReturnValue('1.137');

      const decision: AIDecision = {
        action: 'REDUCE',
        symbol: 'BTC/USDT:USDT',
        confidence: 0.6,
        reasoning: 'reduce',
        params: { reducePercent: 30 },
      };

      await executeDecision(decision, makeBalance());
      expect(mockExchange.amountToPrecision).toHaveBeenCalledWith('BTC/USDT:USDT', expect.closeTo(1.1367, 4));
    });

    it('should use amountToPrecision for CLOSE amounts', async () => {
      mockExchange.fetchPositions.mockResolvedValue([
        mockPosition('BTC/USDT:USDT', 'long', 0.987654),
      ]);
      mockExchange.amountToPrecision.mockReturnValue('0.988');

      await closePosition('BTC/USDT:USDT');
      expect(mockExchange.amountToPrecision).toHaveBeenCalledWith('BTC/USDT:USDT', 0.987654);
    });
  });

  // ─── Error handling ────────────────────────────────────────────

  describe('error handling', () => {
    it('should propagate createOrder errors', async () => {
      mockExchange.amountToPrecision.mockReturnValue('0.050');
      mockExchange.createOrder.mockRejectedValue(new Error('Insufficient margin'));
      const decision = makeLongDecision();
      await expect(executeDecision(decision, makeBalance())).rejects.toThrow('Insufficient margin');
    });

    it('should propagate fetchPositions errors in closePosition', async () => {
      mockExchange.fetchPositions.mockRejectedValue(new Error('API timeout'));
      await expect(closePosition('BTC/USDT:USDT')).rejects.toThrow('API timeout');
    });

    it('should propagate fetchTicker errors', async () => {
      mockPublicExchange.fetchTicker.mockRejectedValue(new Error('Rate limited'));
      const decision = makeLongDecision();
      await expect(executeDecision(decision, makeBalance())).rejects.toThrow('Rate limited');
    });
  });
});
