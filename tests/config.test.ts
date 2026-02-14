import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Config module tests.
 *
 * Because src/config.ts evaluates at import time and calls dotenv.config(),
 * we mock dotenv to prevent it from loading the real .env file, then use
 * vi.resetModules() + dynamic import() to get a fresh config per test.
 */

// Mock dotenv so the real .env file doesn't interfere with test env vars
vi.mock('dotenv', () => ({
  default: { config: vi.fn() },
  config: vi.fn(),
}));

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  vi.resetModules();
  // Re-apply dotenv mock after resetModules
  vi.mock('dotenv', () => ({
    default: { config: vi.fn() },
    config: vi.fn(),
  }));
});

afterEach(() => {
  process.env = savedEnv;
});

function setMinimalEnv() {
  process.env.BINANCE_API_KEY = 'test-api-key';
  process.env.BINANCE_SECRET_KEY = 'test-secret-key';
  process.env.TESTNET_ONLY = 'true';
  // Clear any real .env values that might leak in
  delete process.env.BINANCE_LIVE_API_KEY;
  delete process.env.BINANCE_LIVE_SECRET_KEY;
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.PORT;
  delete process.env.AI_PROVIDER;
  delete process.env.DEEPSEEK_BASE_URL;
  delete process.env.QWEN_BASE_URL;
  delete process.env.BINANCE_FUTURES_TESTNET_URL;
  delete process.env.BINANCE_LIVE_FUTURES_URL;
}

async function loadConfig() {
  const mod = await import('../src/config');
  return mod.config;
}

describe('config', () => {
  describe('testnet mode (default)', () => {
    it('loads successfully with minimal env vars', async () => {
      setMinimalEnv();
      const config = await loadConfig();
      expect(config.testnetOnly).toBe(true);
      expect(config.binance.apiKey).toBe('test-api-key');
      expect(config.binance.secret).toBe('test-secret-key');
    });

    it('defaults TESTNET_ONLY to true when set to "True"', async () => {
      setMinimalEnv();
      process.env.TESTNET_ONLY = 'True';
      const config = await loadConfig();
      expect(config.testnetOnly).toBe(true);
    });

    it('treats TESTNET_ONLY case-insensitively', async () => {
      setMinimalEnv();
      process.env.TESTNET_ONLY = 'TRUE';
      const config = await loadConfig();
      expect(config.testnetOnly).toBe(true);
    });

    it('sets testnetOnly to false for non-true values', async () => {
      setMinimalEnv();
      process.env.TESTNET_ONLY = 'false';
      process.env.BINANCE_LIVE_API_KEY = 'live-key';
      process.env.BINANCE_LIVE_SECRET_KEY = 'live-secret';
      const config = await loadConfig();
      expect(config.testnetOnly).toBe(false);
    });

    it('does not require live API keys in testnet mode', async () => {
      setMinimalEnv();
      const config = await loadConfig();
      expect(config.binanceLive.apiKey).toBe('');
      expect(config.binanceLive.secret).toBe('');
    });
  });

  describe('live mode', () => {
    it('throws when live API keys are missing', async () => {
      setMinimalEnv();
      process.env.TESTNET_ONLY = 'false';
      await expect(loadConfig()).rejects.toThrow('实盘模式需要设置 BINANCE_LIVE_API_KEY 和 BINANCE_LIVE_SECRET_KEY');
    });

    it('throws when only live API key is set but secret is missing', async () => {
      setMinimalEnv();
      process.env.TESTNET_ONLY = 'false';
      process.env.BINANCE_LIVE_API_KEY = 'live-key';
      await expect(loadConfig()).rejects.toThrow('实盘模式需要设置 BINANCE_LIVE_API_KEY 和 BINANCE_LIVE_SECRET_KEY');
    });

    it('throws when only live secret is set but key is missing', async () => {
      setMinimalEnv();
      process.env.TESTNET_ONLY = 'false';
      process.env.BINANCE_LIVE_SECRET_KEY = 'live-secret';
      await expect(loadConfig()).rejects.toThrow('实盘模式需要设置 BINANCE_LIVE_API_KEY 和 BINANCE_LIVE_SECRET_KEY');
    });

    it('loads successfully with live API keys', async () => {
      setMinimalEnv();
      process.env.TESTNET_ONLY = 'false';
      process.env.BINANCE_LIVE_API_KEY = 'live-key';
      process.env.BINANCE_LIVE_SECRET_KEY = 'live-secret';
      const config = await loadConfig();
      expect(config.testnetOnly).toBe(false);
      expect(config.binanceLive.apiKey).toBe('live-key');
      expect(config.binanceLive.secret).toBe('live-secret');
    });
  });

  describe('required env vars', () => {
    it('throws when BINANCE_API_KEY is missing', async () => {
      setMinimalEnv();
      delete process.env.BINANCE_API_KEY;
      await expect(loadConfig()).rejects.toThrow('缺少环境变量: BINANCE_API_KEY');
    });

    it('throws when BINANCE_SECRET_KEY is missing', async () => {
      setMinimalEnv();
      delete process.env.BINANCE_SECRET_KEY;
      await expect(loadConfig()).rejects.toThrow('缺少环境变量: BINANCE_SECRET_KEY');
    });
  });

  describe('PORT parsing', () => {
    it('defaults to 3000', async () => {
      setMinimalEnv();
      const config = await loadConfig();
      expect(config.server.port).toBe(3000);
    });

    it('parses a valid PORT', async () => {
      setMinimalEnv();
      process.env.PORT = '8080';
      const config = await loadConfig();
      expect(config.server.port).toBe(8080);
    });

    it('throws on non-numeric PORT', async () => {
      setMinimalEnv();
      process.env.PORT = 'abc';
      await expect(loadConfig()).rejects.toThrow('环境变量 PORT 必须是整数');
    });

    it('throws on empty PORT', async () => {
      setMinimalEnv();
      process.env.PORT = '';
      await expect(loadConfig()).rejects.toThrow('环境变量 PORT 必须是整数');
    });
  });

  describe('AI provider defaults', () => {
    it('defaults AI_PROVIDER to deepseek', async () => {
      setMinimalEnv();
      const config = await loadConfig();
      expect(config.ai.provider).toBe('deepseek');
    });

    it('reads AI_PROVIDER from env', async () => {
      setMinimalEnv();
      process.env.AI_PROVIDER = 'openai';
      const config = await loadConfig();
      expect(config.ai.provider).toBe('openai');
    });

    it('defaults deepseek base URL', async () => {
      setMinimalEnv();
      const config = await loadConfig();
      expect(config.ai.deepseekBaseUrl).toBe('https://api.deepseek.com');
    });

    it('defaults qwen base URL', async () => {
      setMinimalEnv();
      const config = await loadConfig();
      expect(config.ai.qwenBaseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    });
  });

  describe('proxy config', () => {
    it('defaults to empty strings when no proxy env vars', async () => {
      setMinimalEnv();
      const config = await loadConfig();
      expect(config.proxy.http).toBe('');
      expect(config.proxy.https).toBe('');
    });

    it('reads proxy from env', async () => {
      setMinimalEnv();
      process.env.HTTP_PROXY = 'http://proxy:8080';
      process.env.HTTPS_PROXY = 'https://proxy:8443';
      const config = await loadConfig();
      expect(config.proxy.http).toBe('http://proxy:8080');
      expect(config.proxy.https).toBe('https://proxy:8443');
    });
  });

  describe('risk defaults', () => {
    it('has sensible hardcoded risk limits', async () => {
      setMinimalEnv();
      const config = await loadConfig();
      expect(config.risk.maxPositionPct).toBe(10);
      expect(config.risk.maxTotalExposurePct).toBe(30);
      expect(config.risk.maxLeverage).toBe(10);
      expect(config.risk.maxDailyLossPct).toBe(5);
      expect(config.risk.maxConcurrentPositions).toBe(5);
    });
  });

  describe('testnet URL defaults', () => {
    it('defaults binance futures testnet URL', async () => {
      setMinimalEnv();
      const config = await loadConfig();
      expect(config.binance.futuresUrl).toBe('https://testnet.binancefuture.com');
    });

    it('defaults binance live futures URL', async () => {
      setMinimalEnv();
      const config = await loadConfig();
      expect(config.binanceLive.futuresUrl).toBe('https://fapi.binance.com');
    });
  });
});
