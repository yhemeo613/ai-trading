import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`缺少环境变量: ${key}`);
  return val;
}

export const config = {
  testnetOnly: env('TESTNET_ONLY', 'True').toLowerCase() === 'true',

  binance: {
    apiKey: env('BINANCE_API_KEY'),
    secret: env('BINANCE_SECRET_KEY'),
    futuresUrl: env('BINANCE_FUTURES_TESTNET_URL', 'https://testnet.binancefuture.com'),
  },

  binanceLive: {
    apiKey: env('BINANCE_LIVE_API_KEY', ''),
    secret: env('BINANCE_LIVE_SECRET_KEY', ''),
    futuresUrl: env('BINANCE_LIVE_FUTURES_URL', 'https://fapi.binance.com'),
  },

  proxy: {
    http: process.env.HTTP_PROXY || '',
    https: process.env.HTTPS_PROXY || '',
  },

  ai: {
    openaiKey: process.env.OPENAI_API_KEY || '',
    openaiBaseUrl: process.env.OPENAI_BASE_URL || '',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o',
    anthropicKey: process.env.ANTHROPIC_API_KEY || '',
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
    geminiKey: process.env.GEMINI_API_KEY || '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    deepseekKey: process.env.DEEPSEEK_API_KEY || '',
    deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    qwenKey: process.env.QWEN_API_KEY || '',
    qwenBaseUrl: process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    qwenModel: process.env.QWEN_MODEL || 'qwen-plus',
    provider: process.env.AI_PROVIDER || 'deepseek',
  },

  server: {
    port: parseInt(env('PORT', '3000'), 10),
  },

  risk: {
    maxPositionPct: 10,
    maxTotalExposurePct: 30,
    maxLeverage: 10,
    maxDailyLossPct: 5,
    maxConcurrentPositions: 5,
  },
} as const;
