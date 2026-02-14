// Global test setup — runs before all test files.
// Sets minimal env vars so that `src/config.ts` doesn't throw on import.

process.env.BINANCE_API_KEY = 'test-api-key';
process.env.BINANCE_SECRET_KEY = 'test-secret-key';
process.env.TESTNET_ONLY = 'true';
process.env.AI_PROVIDER = 'deepseek';
process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
