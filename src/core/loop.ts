import { logger } from '../utils/logger';
import { fetchMarketSnapshot } from '../exchange/market-data';
import { fetchBalance, fetchPositions } from '../exchange/account';
import { runTradingSession } from './session';
import { selectTradingPairs } from './pair-selector';
import { checkHardLimits } from '../risk/hard-limits';
import { executeDecision } from '../exchange/executor';
import { isCircuitTripped, recordTradeResult, recordApiFailure, recordApiSuccess, updateDailyLoss, getCircuitState } from '../risk/circuit-breaker';
import { insertTrade } from '../persistence/models/trade';
import { insertDecision, updateDecisionExecuted } from '../persistence/models/decision';
import { insertSnapshot, updateDailyPnl } from '../persistence/models/snapshot';
import { getDb } from '../persistence/db';
import { broadcast } from '../dashboard/websocket';

let activePairs: string[] = [];
let lastPairSelection = 0;
let lastPortfolioReview = 0;
let running = false;

const PAIR_SELECTION_INTERVAL = 60 * 60 * 1000; // 1 hour
const PORTFOLIO_REVIEW_INTERVAL = 15 * 60 * 1000; // 15 minutes
const LOOP_INTERVAL = 60 * 1000; // 1 minute

export function isRunning() { return running; }

export async function startLoop() {
  if (running) return;
  running = true;
  logger.info('交易循环已启动');

  while (running) {
    try {
      await tick();
    } catch (err) {
      logger.error('循环执行错误', { error: err instanceof Error ? err.message : String(err) });
      recordApiFailure();
    }
    await sleep(LOOP_INTERVAL);
  }
}

export function stopLoop() {
  running = false;
  logger.info('交易循环已停止');
}

async function tick() {
  // Check circuit breaker
  if (isCircuitTripped()) {
    const state = getCircuitState();
    logger.warn(`熔断器已激活: ${state.reason}`);
    broadcast({ type: 'circuit', data: state });
    return;
  }

  const now = Date.now();

  // Pair selection (hourly)
  if (now - lastPairSelection > PAIR_SELECTION_INTERVAL || activePairs.length === 0) {
    try {
      activePairs = await selectTradingPairs();
      lastPairSelection = now;
      recordApiSuccess();
      broadcast({ type: 'pairs', data: activePairs });
    } catch (err) {
      logger.error('交易对选择失败', { error: err instanceof Error ? err.message : String(err) });
      recordApiFailure();
      if (activePairs.length === 0) return;
    }
  }

  // Fetch account state
  const balance = await fetchBalance();
  const positions = await fetchPositions();
  recordApiSuccess();

  // Snapshot
  const unrealizedPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
  insertSnapshot({
    totalBalance: balance.totalBalance,
    availableBalance: balance.availableBalance,
    unrealizedPnl,
    positionCount: positions.length,
    positionsJson: JSON.stringify(positions),
  });

  // Daily PnL tracking
  const today = new Date().toISOString().slice(0, 10);
  updateDailyPnl(today, balance.totalBalance, 0, 0);

  // Check daily loss
  const dailyRow = getDb().prepare('SELECT * FROM daily_pnl WHERE date = ?').get(today) as any;
  if (dailyRow && dailyRow.starting_balance > 0) {
    const lossPct = ((dailyRow.starting_balance - balance.totalBalance) / dailyRow.starting_balance) * 100;
    if (lossPct > 0) updateDailyLoss(lossPct);
  }

  broadcast({
    type: 'account',
    data: { balance, positions, unrealizedPnl },
  });

  // Process each active pair
  for (const symbol of activePairs) {
    if (!running || isCircuitTripped()) break;

    try {
      await processSymbol(symbol, balance, positions);
      recordApiSuccess();
    } catch (err) {
      logger.error(`处理 ${symbol} 时出错`, { error: err instanceof Error ? err.message : String(err) });
      recordApiFailure();
    }

    // Small delay between symbols
    await sleep(2000);
  }
}

async function processSymbol(
  symbol: string,
  balance: ReturnType<typeof import('../exchange/account').fetchBalance> extends Promise<infer T> ? T : never,
  positions: ReturnType<typeof import('../exchange/account').fetchPositions> extends Promise<infer T> ? T : never
) {
  logger.info(`正在处理 ${symbol}`);

  // Fetch market data
  const snapshot = await fetchMarketSnapshot(symbol);

  // Run AI session
  const decision = await runTradingSession(snapshot, balance, positions);
  logger.info(`${symbol} AI 决策: ${decision.action} (置信度: ${decision.confidence})`, {
    reasoning: decision.reasoning,
  });

  // Risk check
  const riskCheck = checkHardLimits(decision, balance, positions);

  // Persist decision
  const decisionResult = insertDecision({
    symbol: decision.symbol,
    action: decision.action,
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    aiProvider: 'auto',
    riskPassed: riskCheck.passed,
    riskReason: riskCheck.reason,
    executed: false,
  });
  const decisionId = Number(decisionResult.lastInsertRowid);

  broadcast({ type: 'decision', data: { decision, riskCheck } });

  if (!riskCheck.passed) {
    logger.warn(`${symbol} 风控检查未通过: ${riskCheck.reason}`);
    return;
  }

  if (decision.action === 'HOLD') {
    return;
  }

  // Execute
  const result = await executeDecision(decision, balance);
  if (result) {
    // Mark decision as executed
    updateDecisionExecuted(decisionId);

    insertTrade({
      symbol: decision.symbol,
      action: decision.action,
      side: result.side,
      amount: result.amount,
      price: result.price,
      leverage: decision.params?.leverage,
      stopLoss: decision.params?.stopLossPrice,
      takeProfit: decision.params?.takeProfitPrice,
      orderId: result.orderId,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
    });

    // Track trade result for circuit breaker (use 0 for now, actual PnL tracked on close)
    if (decision.action === 'CLOSE') {
      // For close actions, estimate PnL from the position being closed
      const closedPos = positions.find((p) => p.symbol === decision.symbol);
      if (closedPos) {
        const pnlPct = closedPos.unrealizedPnl / (closedPos.notional / closedPos.leverage) * 100;
        recordTradeResult(pnlPct);
        // Update daily PnL with realized PnL
        const today = new Date().toISOString().slice(0, 10);
        updateDailyPnl(today, balance.totalBalance, closedPos.unrealizedPnl, 1);
      } else {
        const today = new Date().toISOString().slice(0, 10);
        updateDailyPnl(today, balance.totalBalance, 0, 1);
      }
    } else {
      // Update daily PnL trade count
      const today = new Date().toISOString().slice(0, 10);
      updateDailyPnl(today, balance.totalBalance, 0, 1);
    }

    broadcast({ type: 'trade', data: { decision, result } });
    logger.info(`交易已执行: ${result.side} ${result.amount} ${symbol} @ ${result.price}`);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
