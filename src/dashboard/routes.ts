import { Router } from 'express';
import { fetchBalance, fetchPositions } from '../exchange/account';
import { getRecentTrades } from '../persistence/models/trade';
import { getRecentDecisions } from '../persistence/models/decision';
import { getRecentSnapshots, getDailyPnlHistory } from '../persistence/models/snapshot';
import { getCircuitState, resetCircuit, emergencyStop } from '../risk/circuit-breaker';
import { isRunning, startLoop, stopLoop } from '../core/loop';
import { getAvailableProviders, getProviderStats } from '../ai/router';
import { logger } from '../utils/logger';

const router = Router();

router.get('/api/status', async (_req, res) => {
  try {
    const balance = await fetchBalance();
    const positions = await fetchPositions();
    const circuit = getCircuitState();
    res.json({
      running: isRunning(),
      balance,
      positions,
      circuit,
      aiProviders: getAvailableProviders(),
      providerStats: getProviderStats(),
    });
  } catch (err: any) {
    logger.error('Status API error', { error: err.message });
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
  res.json({ ok: true, message: 'Emergency stop activated' });
});

router.post('/api/start', (_req, res) => {
  if (isRunning()) {
    res.json({ ok: false, message: 'Already running' });
    return;
  }
  startLoop();
  res.json({ ok: true, message: 'Trading loop started' });
});

router.post('/api/stop', (_req, res) => {
  stopLoop();
  res.json({ ok: true, message: 'Trading loop stopped' });
});

export default router;
