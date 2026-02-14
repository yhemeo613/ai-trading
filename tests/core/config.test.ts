import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Tests for src/config.ts
 *
 * Since config.ts calls dotenv.config() at import time, we mock dotenv
 * to prevent the real .env file from polluting test state. Then we
 * control process.env directly before each fresh import.
 */

// Helper: import config fresh with only the given env vars set.
// Mocks dotenv so the real .env file is never loaded.
async function importConfigWith(envVars: Record<string, string>) {
  vi.resetModules();

  // Mock dotenv to be a no-op (prevent reading .env file)
  vi.doMock('dotenv', () => ({
    default: { config: vi.fn() },
    config: vi.fn(),
  }));

  // Wipe all relevant env vars first
  const keysToClean = [
    'BINANCE_API_KEY', 'BINANCE_SECRET_KEY',
    'BINANCE_LIVE_API_KEY', 'BINANCE_LIVE_SECRET_KEY',
    'BINANCE_FUTURES_TESTNET_URL', 'BINANCE_LIVE_FUTURES_URL',
    'TESTNET_ONLY', 'PORT',
    'HTTP_PROXY', 'HTTPS_PROXY',
    'AI_PROVIDER', 'AI_STRATEGIC_PROVIDER', 'AI_TACTICAL_PROVIDER', 'AI_AUXILIARY_PROVIDER',
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL',
    'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
    'GEMINI_API_KEY', 'GEMINI_MODEL',
    'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL',
    'QWEN_API_KEY', 'QWEN_BASE_URL', 'QWEN_MODEL',
  ];
  for (const k of keysToClean) {
    delete process.env[k];
  }

  // Set only the vars we want
  for (const [k, v] of Object.entries(envVars)) {
    process.env[k] = v;
  }

  const mod = await import('../../src/config');
  return mod.config;
}

describe('config', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    // Restore original env after each test
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    for (const [key, val] of Object.entries(savedEnv)) {
      process.env[key] = val;
    }
    vi.restoreAllMocks();
  });

  describe('env() — required variables', () => {
    it('throws when BINANCE_API_KEY is missing', async () => {
      await expect(
        importConfigWith({
          BINANCE_SECRET_KEY: 'test-secret',
          TESTNET_ONLY: 'true',
        })
      ).rejects.toThrow('缺少环境变量: BINANCE_API_KEY');
    });

    it('throws when BINANCE_SECRET_KEY is missing', async () => {
      await expect(
        importConfigWith({
          BINANCE_API_KEY: 'test-key',
          TESTNET_ONLY: 'true',
        })
      ).rejects.toThrow('缺少环境变量: BINANCE_SECRET_KEY');
    });
  });

  describe('testnetOnly toggle', () => {
    it('defaults to true when TESTNET_ONLY is not set', async () => {
      const config = await importConfigWith({
        BINANCE_API_KEY: 'k',
        BINANCE_SECRET_KEY: 's',
      });
      // Default fallback is 'True' → true
      expect(config.testnetOnly).toBe(true);
    });

    it('is true when TESTNET_ONLY=True', async () => {
      const config = await importConfigWith({
        BINANCE_API_KEY: 'k',
        BINANCE_SECRET_KEY: 's',
        TESTNET_ONLY: 'True',
      });
      expect(config.testnetOnly).toBe(true);
    });

    it('is true when TESTNET_ONLY=true (lowercase)', async () => {
      const config = await importConfigWith({
        BINANCE_API_KEY: 'k',
        BINANCE_SECRET_KEY: 's',
        TESTNET_ONLY: 'true',
      });
      expect(config.testnetOnly).toBe(true);
    });

    it('is false when TESTNET_ONLY=false (with live keys)', async () => {
      const config = await importConfigWith({
        BINANCE_API_KEY: 'k',
        BINANCE_SECRET_KEY: 's',
        TESTNET_ONLY: 'false',
        BINANCE_LIVE_API_KEY: 'live-key',
        BINANCE_LIVE_SECRET_KEY: 'live-secret',
      });
      expect(config.testnetOnly).toBe(false);
    });

    it('is false for any non-true string', async () => {
      const config = await importConfigWith({
        BINANCE_API_KEY: 'k',
        BINANCE_SECRET_KEY: 's',
        TESTNET_ONLY: 'yes',
        BINANCE_LIVE_API_KEY: 'live-key',
        BINANCE_LIVE_SECRET_KEY: 'live-secret',
      });
      expect(config.testnetOnly).toBe(false);
    });
  });

  describe('live mode validation', () => {
    it('throws when live mode enabled without live API keys', async () => {
      await expect(
        importConfigWith({
          BINANCE_API_KEY: 'k',
          BINANCE_SECRET_KEY: 's',
          TESTNET_ONLY: 'false',
        })
      ).rejects.toThrow('BINANCE_LIVE_API_KEY');
    });

    it('throws when live mode enabled with empty live API key', async () => {
      await expect(
        importConfigWith({
          BINANCE_API_KEY: 'k',
          BINANCE_SECRET_KEY: 's',
          TESTNET_ONLY: 'false',
          BINANCE_LIVE_API_KEY: '',
          BINANCE_LIVE_SECRET_KEY: '',
        })
      ).rejects.toThrow('BINANCE_LIVE_API_KEY');
    });
  });

  describe('envInt() — PORT parsing', () => {
    it('defaults PORT to 3000', async () => {
      const config = await importConfigWith({
        BINANCE_API_KEY: 'k',
        BINANCE_SECRET_KEY: 's',
        TESTNET_ONLY: 'true',
      });
      expect(config.server.port).toBe(3000);
    });

    it('parses custom PORT', async () => {
      const config = await importConfigWith({
        BINANCE_API_KEY: 'k',
        BINANCE_SECRET_KEY: 's',
        TESTNET_ONLY: 'true',
        PORT: '8080',
      });
      expect(config.server.port).toBe(8080);
    });

    it('throws on non-integer PORT', async () => {
      await expect(
        importConfigWith({
          BINANCE_API_KEY: 'k',
          BINANCE_SECRET_KEY: 's',
          TESTNET_ONLY: 'true',
          PORT: 'abc',
        })
      ).rejects.toThrow('必须是整数');
    });
  });

  describe('AI provider defaults', () => {
    it('defaults AI provider to deepseek', async () => {
      const config = await importConfigWith({
        BINANCE_API_KEY: 'k',
        BINANCE_SECRET_KEY: 's',
        TESTNET_ONLY: 'true',
      });
      expect(config.ai.provider).toBe('deepseek');
    });

    it('uses custom AI_PROVIDER', async () => {
      const config = await importConfigWith({
        BINANCE_API_KEY: 'k',
        BINANCE_SECRET_KEY: 's',
        TESTNET_ONLY: 'true',
        AI_PROVIDER: 'openai',
      });
      expect(config.ai.provider).toBe('openai');
    });

    it('defaults strategic/tactical/auxiliary providers to empty string', async () => {
      const config = await importConfigWith({
        BINANCE_API_KEY: 'k',
        BINANCE_SECRET_KEY: 's',
        TESTNET_ONLY: 'true',
      });
      expect(config.ai.strategicProvider).toBe('');
      expect(config.ai.tacticalProvider).toBe('');
      expect(config.ai.auxiliaryProvider).toBe('');
    });
  });

  describe('risk defaults', () => {
    it('has correct hardcoded risk limits', async () => {
      const config = await importConfigWith({
        BINANCE_API_KEY: 'k',
        BINANCE_SECRET_KEY: 's',
        TESTNET_ONLY: 'true',
      });
      expect(config.risk.maxLeverage).toBe(10);
      expect(config.risk.maxPositionPct).toBe(10);
      expect(config.risk.maxTotalExposurePct).toBe(30);
      expect(config.risk.maxDailyLossPct).toBe(5);
      expect(config.risk.maxConcurrentPositions).toBe(5);
    });
  });

  describe('binance config', () => {
    it('loads testnet API keys', async () => {
      const config = await importConfigWith({
        BINANCE_API_KEY: 'my-test-key',
        BINANCE_SECRET_KEY: 'my-test-secret',
        TESTNET_ONLY: 'true',
      });
      expect(config.binance.apiKey).toBe('my-test-key');
      expect(config.binance.secret).toBe('my-test-secret');
    });

    it('defaults testnet futures URL', async () => {
      const config = await importConfigWith({
        BINANCE_API_KEY: 'k',
        BINANCE_SECRET_KEY: 's',
        TESTNET_ONLY: 'true',
      });
      expect(config.binance.futuresUrl).toBe('https://testnet.binancefuture.com');
    });

    it('defaults live futures URL', async () => {
      const config = await importConfigWith({
        BINANCE_API_KEY: 'k',
        BINANCE_SECRET_KEY: 's',
        TESTNET_ONLY: 'true',
      });
      expect(config.binanceLive.futuresUrl).toBe('https://fapi.binance.com');
    });
  });

  describe('proxy config', () => {
    it('defaults proxy to empty strings', async () => {
      const config = await importConfigWith({
        BINANCE_API_KEY: 'k',
        BINANCE_SECRET_KEY: 's',
        TESTNET_ONLY: 'true',
      });
      expect(config.proxy.http).toBe('');
      expect(config.proxy.https).toBe('');
    });

    it('reads proxy from env', async () => {
      const config = await importConfigWith({
        BINANCE_API_KEY: 'k',
        BINANCE_SECRET_KEY: 's',
        TESTNET_ONLY: 'true',
        HTTP_PROXY: 'http://proxy:8080',
        HTTPS_PROXY: 'http://proxy:8443',
      });
      expect(config.proxy.http).toBe('http://proxy:8080');
      expect(config.proxy.https).toBe('http://proxy:8443');
    });
  });
});
