import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────

const mockBalance = { totalBalance: 10000, availableBalance: 8000, usedMargin: 2000 };
const mockPositions = [
  { symbol: 'BTC/USDT:USDT', side: 'long', contracts: 0.01, notional: 500, entryPrice: 50000, markPrice: 51000, unrealizedPnl: 10, leverage: 5 },
];

vi.mock('../../src/exchange/account', () => ({
  fetchBalance: vi.fn().mockResolvedValue({ totalBalance: 10000, availableBalance: 8000, usedMargin: 2000 }),
  fetchPositions: vi.fn().mockResolvedValue([
    { symbol: 'BTC/USDT:USDT', side: 'long', contracts: 0.01, notional: 500, entryPrice: 50000, markPrice: 51000, unrealizedPnl: 10, leverage: 5 },
  ]),
}));

vi.mock('../../src/exchange/market-data', () => ({
  fetchTicker: vi.fn().mockResolvedValue({ last: 50000, percentage: 2.5 }),
}));

vi.mock('../../src/exchange/executor', () => ({
  closePosition: vi.fn().mockResolvedValue({ orderId: 'mock-close-1', symbol: 'BTC/USDT:USDT', side: 'sell', type: 'MARKET', amount: 0.01, price: 51000, status: 'closed' }),
}));

vi.mock('../../src/exchange/client', () => ({
  resetExchange: vi.fn(),
  getExchange: vi.fn().mockReturnValue({ markets: {} }),
  getPublicExchange: vi.fn().mockReturnValue({ loadMarkets: vi.fn().mockResolvedValue({}), markets: {} }),
}));

vi.mock('../../src/persistence/models/trade', () => ({
  getRecentTrades: vi.fn().mockReturnValue([
    { id: 1, symbol: 'BTC/USDT:USDT', action: 'LONG', side: 'buy', amount: 0.01, price: 50000, confidence: 0.8, created_at: '2025-01-01 12:00:00' },
  ]),
}));

vi.mock('../../src/persistence/models/decision', () => ({
  getRecentDecisions: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/persistence/models/snapshot', () => ({
  getRecentSnapshots: vi.fn().mockReturnValue([]),
  getDailyPnlHistory: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/persistence/models/position', () => ({
  getOpenPositions: vi.fn().mockReturnValue([]),
  getPositionHistory: vi.fn().mockReturnValue([]),
}));

let circuitState = {
  tripped: false,
  reason: '',
  trippedAt: 0,
  cooldownMs: 3600000,
  consecutiveLosses: 0,
  consecutiveApiFailures: 0,
  dailyLossPct: 0,
  manualStop: false,
  winStreak: 0,
  lossStreak: 0,
};

vi.mock('../../src/risk/circuit-breaker', () => ({
  getCircuitState: vi.fn(() => ({ ...circuitState })),
  resetCircuit: vi.fn(() => {
    circuitState = { ...circuitState, tripped: false, reason: '', manualStop: false, consecutiveLosses: 0, consecutiveApiFailures: 0 };
  }),
  emergencyStop: vi.fn(() => {
    circuitState = { ...circuitState, tripped: true, manualStop: true, reason: '手动紧急停止', trippedAt: Date.now() };
  }),
  isCircuitTripped: vi.fn(() => circuitState.tripped || circuitState.manualStop),
}));

let loopRunning = false;
vi.mock('../../src/core/loop', () => ({
  isRunning: vi.fn(() => loopRunning),
  startLoop: vi.fn(async () => { loopRunning = true; }),
  stopLoop: vi.fn(() => { loopRunning = false; }),
  clearLoopState: vi.fn(),
}));

vi.mock('../../src/core/pair-selector', () => ({
  getTradingPairs: vi.fn().mockReturnValue(['BTC/USDT:USDT', 'ETH/USDT:USDT']),
}));

vi.mock('../../src/ai/router', () => ({
  getAvailableProviders: vi.fn().mockReturnValue(['deepseek']),
  getProviderStats: vi.fn().mockReturnValue({}),
}));

vi.mock('../../src/core/trading-plan', () => ({
  getAllActivePlans: vi.fn().mockReturnValue([]),
  getActivePlan: vi.fn().mockReturnValue(null),
  getPendingPlans: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/analysis/narrative', () => ({
  getCachedNarrative: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/core/strategic-session', () => ({
  clearStrategicCache: vi.fn(),
}));

vi.mock('../../src/memory/session-context', () => ({
  clearSessionEvents: vi.fn(),
}));

vi.mock('../../src/persistence/db', () => ({
  getDb: vi.fn().mockReturnValue({
    prepare: vi.fn().mockReturnValue({ get: vi.fn(), all: vi.fn().mockReturnValue([]), run: vi.fn() }),
  }),
  resetDb: vi.fn(),
}));

vi.mock('../../src/config', () => ({
  config: {
    testnetOnly: true,
    ai: { provider: 'deepseek', strategicProvider: '', tacticalProvider: '', auxiliaryProvider: '' },
    risk: { maxPositionPct: 10, maxTotalExposurePct: 30, maxLeverage: 10, maxDailyLossPct: 5, maxConcurrentPositions: 5 },
    server: { port: 3000 },
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── Import after mocks ─────────────────────────────────────────

import express from 'express';
import router from '../../src/dashboard/routes';
import { isRunning, stopLoop } from '../../src/core/loop';
import { emergencyStop, resetCircuit, getCircuitState } from '../../src/risk/circuit-breaker';
import { fetchPositions } from '../../src/exchange/account';
import { closePosition } from '../../src/exchange/executor';

// ─── Test app setup ──────────────────────────────────────────────

function createApp() {
  const app = express();
  app.use(router);
  return app;
}

async function request(app: express.Express, method: 'GET' | 'POST', path: string) {
  // Use a lightweight approach: call the route handler directly via supertest-like mechanism
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as any;
      const url = `http://127.0.0.1:${addr.port}${path}`;
      fetch(url, { method })
        .then(async (res) => {
          const body = await res.json();
          server.close();
          resolve({ status: res.status, body });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

// ─── Tests ───────────────────────────────────────────────────────

describe('Dashboard Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    loopRunning = false;
    circuitState = {
      tripped: false, reason: '', trippedAt: 0, cooldownMs: 3600000,
      consecutiveLosses: 0, consecutiveApiFailures: 0, dailyLossPct: 0,
      manualStop: false, winStreak: 0, lossStreak: 0,
    };
  });

  describe('GET /api/status', () => {
    it('returns running state, balance, positions, and circuit', async () => {
      const res = await request(app, 'GET', '/api/status');
      expect(res.status).toBe(200);
      expect(res.body.running).toBe(false);
      expect(res.body.testnet).toBe(true);
      expect(res.body.balance).toEqual(mockBalance);
      expect(res.body.positions).toHaveLength(1);
      expect(res.body.circuit).toBeDefined();
      expect(res.body.circuit.tripped).toBe(false);
      expect(res.body.aiProviders).toEqual(['deepseek']);
    });
  });

  describe('GET /api/trades', () => {
    it('returns recent trades', async () => {
      const res = await request(app, 'GET', '/api/trades');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].symbol).toBe('BTC/USDT:USDT');
    });
  });

  describe('GET /api/circuit', () => {
    it('returns circuit breaker state', async () => {
      const res = await request(app, 'GET', '/api/circuit');
      expect(res.status).toBe(200);
      expect(res.body.tripped).toBe(false);
      expect(res.body.manualStop).toBe(false);
    });
  });

  describe('POST /api/circuit/reset', () => {
    it('resets circuit breaker and returns new state', async () => {
      circuitState.tripped = true;
      circuitState.reason = 'test trip';
      const res = await request(app, 'POST', '/api/circuit/reset');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(resetCircuit).toHaveBeenCalled();
    });
  });

  describe('POST /api/start', () => {
    it('starts the trading loop when stopped and circuit is normal', async () => {
      const res = await request(app, 'POST', '/api/start');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.running).toBe(true);
      expect(res.body.message).toContain('启动');
    });

    it('rejects start when already running', async () => {
      loopRunning = true;
      const res = await request(app, 'POST', '/api/start');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.message).toContain('运行');
    });

    it('rejects start when circuit is tripped', async () => {
      circuitState.tripped = true;
      circuitState.reason = 'test';
      const res = await request(app, 'POST', '/api/start');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.message).toContain('熔断');
    });
  });

  describe('POST /api/stop', () => {
    it('stops the trading loop when running', async () => {
      loopRunning = true;
      const res = await request(app, 'POST', '/api/stop');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.running).toBe(false);
      expect(stopLoop).toHaveBeenCalled();
    });

    it('rejects stop when not running', async () => {
      const res = await request(app, 'POST', '/api/stop');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.message).toContain('未在运行');
    });
  });

  describe('POST /api/emergency-stop', () => {
    it('triggers emergency stop and closes all positions', async () => {
      loopRunning = true;
      const res = await request(app, 'POST', '/api/emergency-stop');
      expect(res.status).toBe(200);
      expect(res.body.running).toBe(false);
      expect(emergencyStop).toHaveBeenCalled();
      expect(stopLoop).toHaveBeenCalled();
      expect(closePosition).toHaveBeenCalledWith('BTC/USDT:USDT');
      expect(res.body.closedPositions).toHaveLength(1);
      expect(res.body.closedPositions[0]).toContain('已平仓');
    });

    it('reports failure when position close fails', async () => {
      loopRunning = true;
      vi.mocked(closePosition).mockRejectedValueOnce(new Error('exchange error'));
      const res = await request(app, 'POST', '/api/emergency-stop');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.closedPositions[0]).toContain('平仓失败');
    });

    it('handles fetchPositions failure gracefully', async () => {
      loopRunning = true;
      vi.mocked(fetchPositions).mockRejectedValueOnce(new Error('network error'));
      const res = await request(app, 'POST', '/api/emergency-stop');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.message).toContain('获取持仓失败');
      expect(res.body.closedPositions).toEqual([]);
    });
  });

  describe('GET /api/tickers', () => {
    it('returns ticker data array', async () => {
      const res = await request(app, 'GET', '/api/tickers');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      // Each ticker should have name, price, change
      if (res.body.length > 0) {
        expect(res.body[0]).toHaveProperty('name');
        expect(res.body[0]).toHaveProperty('price');
        expect(res.body[0]).toHaveProperty('change');
      }
    });
  });

  describe('GET /api/mode', () => {
    it('returns current mode', async () => {
      const res = await request(app, 'GET', '/api/mode');
      expect(res.status).toBe(200);
      expect(res.body.testnet).toBe(true);
    });
  });

  describe('GET /api/pairs', () => {
    it('returns trading pairs', async () => {
      const res = await request(app, 'GET', '/api/pairs');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toContain('BTC/USDT:USDT');
    });
  });

  describe('GET /api/positions/history', () => {
    it('returns position history', async () => {
      const res = await request(app, 'GET', '/api/positions/history');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('GET /api/daily-pnl', () => {
    it('returns daily PnL history', async () => {
      const res = await request(app, 'GET', '/api/daily-pnl');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });
});
