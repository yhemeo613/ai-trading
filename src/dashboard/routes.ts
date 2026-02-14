import { Router } from 'express';
import { fetchBalance, fetchPositions } from '../exchange/account';
import { getRecentTrades } from '../persistence/models/trade';
import { getRecentDecisions } from '../persistence/models/decision';
import { getRecentSnapshots, getDailyPnlHistory } from '../persistence/models/snapshot';
import { getOpenPositions, getPositionHistory } from '../persistence/models/position';
import { getCircuitState, resetCircuit, emergencyStop } from '../risk/circuit-breaker';
import { isRunning, startLoop, stopLoop } from '../core/loop';
import { getTradingPairs } from '../core/pair-selector';
import { getAvailableProviders, getProviderStats } from '../ai/router';
import { logger } from '../utils/logger';
import { config } from '../config';
import { resetExchange, getExchange, getPublicExchange } from '../exchange/client';

import { fetchTicker } from '../exchange/market-data';
import { getAllActivePlans, getActivePlan, getPendingPlans } from '../core/trading-plan';
import { getCachedNarrative } from '../analysis/narrative';

const router = Router();

const MAIN_TICKERS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'BNB/USDT:USDT', 'XRP/USDT:USDT', 'DOGE/USDT:USDT'];

router.get('/api/tickers', async (_req, res) => {
  try {
    const results = await Promise.allSettled(
      MAIN_TICKERS.map(async (sym) => {
        const t = await fetchTicker(sym);
        const short = sym.replace('/USDT:USDT', '');
        return { name: short, price: t.last ?? 0, change: t.percentage ?? 0 };
      })
    );
    const tickers = results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .map(r => r.value);
    res.json(tickers);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/status', async (_req, res) => {
  try {
    const balance = await fetchBalance();
    const positions = await fetchPositions();
    const circuit = getCircuitState();
    res.json({
      running: isRunning(),
      testnet: config.testnetOnly,
      balance,
      positions,
      circuit,
      aiProviders: getAvailableProviders(),
      providerStats: getProviderStats(),
      aiConfig: {
        strategicProvider: config.ai.strategicProvider || config.ai.provider,
        tacticalProvider: config.ai.tacticalProvider || config.ai.provider,
      },
    });
  } catch (err: any) {
    logger.error('状态接口错误', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/trades', (_req, res) => {
  try {
    const trades = getRecentTrades(100);
    res.json(trades);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/decisions', (_req, res) => {
  try {
    const decisions = getRecentDecisions(100);
    res.json(decisions);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/snapshots', (_req, res) => {
  try {
    const snapshots = getRecentSnapshots(200);
    res.json(snapshots);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/daily-pnl', (_req, res) => {
  try {
    const pnl = getDailyPnlHistory(30);
    res.json(pnl);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/circuit', (_req, res) => {
  res.json(getCircuitState());
});

router.post('/api/circuit/reset', (_req, res) => {
  resetCircuit();
  res.json({ ok: true, state: getCircuitState() });
});

router.post('/api/emergency-stop', (_req, res) => {
  emergencyStop();
  stopLoop();
  res.json({ ok: true, message: '紧急停止已激活' });
});

router.post('/api/start', (_req, res) => {
  if (isRunning()) {
    res.json({ ok: false, message: '已在运行中' });
    return;
  }
  startLoop().catch((err) => {
    logger.error('交易循环错误', { error: err.message });
  });
  res.json({ ok: true, message: '交易循环已启动' });
});

router.post('/api/stop', (_req, res) => {
  stopLoop();
  res.json({ ok: true, message: '交易循环已停止' });
});

router.get('/api/pairs', (_req, res) => {
  res.json(getTradingPairs());
});

router.get('/api/positions/history', (_req, res) => {
  try {
    res.json(getPositionHistory(100));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/positions/open', (_req, res) => {
  try {
    res.json(getOpenPositions());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── New: Plans & Narrative APIs ─────────────────────────────────

router.get('/api/plans', (_req, res) => {
  try {
    res.json(getAllActivePlans());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/plans/:symbol', (req, res) => {
  try {
    const symbol = decodeURIComponent(req.params.symbol);
    const active = getActivePlan(symbol);
    const pending = getPendingPlans(symbol);
    res.json({ active, pending });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/narrative/:symbol', (req, res) => {
  try {
    const symbol = decodeURIComponent(req.params.symbol);
    const narrative = getCachedNarrative(symbol);
    if (narrative) {
      res.json(narrative);
    } else {
      res.json({ message: '暂无叙事数据，等待下一个tick' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/mode', (_req, res) => {
  res.json({ testnet: config.testnetOnly });
});

router.post('/api/mode/toggle', async (_req, res) => {
  if (isRunning()) {
    res.status(400).json({ ok: false, message: '请先停止交易循环再切换模式' });
    return;
  }

  const wasTestnet = config.testnetOnly;
  (config as any).testnetOnly = !wasTestnet;

  // Reset exchange clients so they reinitialize with new config
  resetExchange();

  // Reinitialize exchange connectivity
  try {
    const pub = getPublicExchange();
    await pub.loadMarkets();
    const ex = getExchange();
    ex.markets = pub.markets;
    (ex as any).markets_by_id = (pub as any).markets_by_id;
    (ex as any).symbols = (pub as any).symbols;
  } catch (err: any) {
    logger.error('切换模式后交易所连接失败', { error: err.message });
  }

  const newMode = config.testnetOnly ? '测试网' : '实盘';
  logger.info(`模式已切换为: ${newMode}`);
  res.json({ ok: true, testnet: config.testnetOnly, message: `已切换到${newMode}` });
});

export default router;
