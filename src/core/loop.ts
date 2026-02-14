import { logger } from '../utils/logger';
import { fetchMarketSnapshot } from '../exchange/market-data';
import { fetchBalance, fetchPositions } from '../exchange/account';
import { getTradingPairs } from './pair-selector';
import { checkHardLimits } from '../risk/hard-limits';
import { executeDecision } from '../exchange/executor';
import { getExchange } from '../exchange/client';
import { isCircuitTripped, recordTradeResult, recordApiFailure, recordApiSuccess, updateDailyLoss, getCircuitState } from '../risk/circuit-breaker';
import { insertTrade } from '../persistence/models/trade';
import { insertDecision, updateDecisionExecuted } from '../persistence/models/decision';
import { insertSnapshot, updateDailyPnl } from '../persistence/models/snapshot';
import { insertPosition, closePosition as closePositionRecord, updatePositionSLTP, getOpenPositionBySymbol, updatePositionAdd, updatePositionReduce, updatePositionThesis, getOpenPositions } from '../persistence/models/position';
import { insertPositionOperation, calcNewAvgEntry, calcReducePnl } from '../persistence/models/position-ops';
import { insertMemory, updateSymbolStats, decayMemories } from '../memory/memory-store';
import { shouldRunReview, runStrategyReview } from '../optimization/strategy-review';
import { getDb } from '../persistence/db';
import { broadcast } from '../dashboard/websocket';

// New imports for the upgraded system
import { calcIndicators, analyzeOrderbook, calcSentiment } from '../analysis/indicators';
import { detectMarketRegime } from '../memory/memory-context';
import { buildNarrative, MarketNarrative, getCachedNarrative } from '../analysis/narrative';
import { addSessionEvent } from '../memory/session-context';
import { expireOldPlans, getActivePlan, getPendingPlans, createPlan, activatePlan, invalidatePlan, completePlan, evaluatePlanEntry, evaluatePlanValidity, TradingPlan } from './trading-plan';
import { runStrategicAnalysis, shouldRunStrategicAnalysis, getCachedStrategicContext, StrategicContext } from './strategic-session';
import { runTacticalExecution } from './tactical-session';
import { insertMarketObservation } from '../memory/memory-store';
import type { TechnicalIndicators, OrderbookAnalysis, MarketSentiment } from '../analysis/indicators';

let running = false;

const LOOP_INTERVAL = 60 * 1000;
const SCAN_INTERVAL = 5 * 60 * 1000;
const MAX_CONCURRENCY = 3;
let lastScanTime = 0;
let lastDecayDate = '';

// Track previous market regime per symbol for change detection
const previousRegimes: Map<string, string> = new Map();

export function isRunning() { return running; }

export async function startLoop() {
  if (running) return;
  running = true;
  logger.info('交易循环已启动 (双层AI模式)');

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
  if (isCircuitTripped()) {
    const state = getCircuitState();
    logger.warn(`熔断器已激活: ${state.reason}`);
    broadcast({ type: 'circuit', data: state });
    return;
  }

  const basePairs = getTradingPairs();
  const balance = await fetchBalance();
  const positions = await fetchPositions();
  recordApiSuccess();

  const positionSymbols = positions.map((p) => p.symbol).filter((s) => !basePairs.includes(s));

  // Clean up orphaned SL/TP orders: if DB says position is open but exchange has no position,
  // cancel remaining conditional orders and close the DB record
  try {
    const dbOpenPositions = getOpenPositions() as any[];
    const exchangeSymbols = new Set(positions.map((p) => p.symbol));
    for (const dbPos of dbOpenPositions) {
      if (!exchangeSymbols.has(dbPos.symbol)) {
        logger.info(`检测到孤立仓位 ${dbPos.symbol}，正在清理残留订单...`);
        try {
          const ex = getExchange();
          await ex.cancelAllOrders(dbPos.symbol);
          logger.info(`${dbPos.symbol} 残留条件单已取消`);
        } catch (err: any) {
          logger.warn(`${dbPos.symbol} 取消残留订单失败: ${err.message}`);
        }
        // Close the DB position record
        closePositionRecord({
          symbol: dbPos.symbol,
          exitPrice: 0,
          pnl: 0,
          exitOrderId: 'auto-cleanup',
        });
        logger.info(`${dbPos.symbol} 数据库仓位记录已关闭（交易所已无持仓）`);
      }
    }
  } catch (err: any) {
    logger.warn('孤立订单清理失败', { error: err.message });
  }

  const now = Date.now();
  const shouldScan = now - lastScanTime > SCAN_INTERVAL;
  if (shouldScan) lastScanTime = now;

  const heldSymbols = positions.map((p) => p.symbol);
  const scanSymbols = shouldScan ? basePairs.filter((s) => !heldSymbols.includes(s)) : [];
  const allPairs = [...new Set([...heldSymbols, ...positionSymbols, ...scanSymbols])];

  broadcast({ type: 'pairs', data: allPairs });

  // Snapshot
  const unrealizedPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
  insertSnapshot({
    totalBalance: balance.totalBalance,
    availableBalance: balance.availableBalance,
    unrealizedPnl,
    positionCount: positions.length,
    positionsJson: JSON.stringify(positions),
  });

  const today = new Date().toISOString().slice(0, 10);
  updateDailyPnl(today, balance.totalBalance, 0, 0);

  const dailyRow = getDb().prepare('SELECT * FROM daily_pnl WHERE date = ?').get(today) as any;
  if (dailyRow && dailyRow.starting_balance > 0) {
    const lossPct = ((dailyRow.starting_balance - balance.totalBalance) / dailyRow.starting_balance) * 100;
    if (lossPct > 0) updateDailyLoss(lossPct);
  }

  broadcast({
    type: 'account',
    data: { balance, positions, unrealizedPnl },
  });

  // Daily memory decay
  if (today !== lastDecayDate) {
    lastDecayDate = today;
    try { decayMemories(); } catch (err) {
      logger.warn('记忆衰减失败', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Strategy review
  try {
    if (shouldRunReview()) {
      await runStrategyReview();
    }
  } catch (err) {
    logger.warn('策略审查失败', { error: err instanceof Error ? err.message : String(err) });
  }

  // Expire old plans
  try { expireOldPlans(); } catch (err) {
    logger.warn('计划过期清理失败', { error: err instanceof Error ? err.message : String(err) });
  }

  // Process pairs in parallel batches
  for (let i = 0; i < allPairs.length; i += MAX_CONCURRENCY) {
    if (!running || isCircuitTripped()) break;

    const batch = allPairs.slice(i, i + MAX_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((symbol) => processSymbol(symbol, balance, positions))
    );

    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'fulfilled') {
        recordApiSuccess();
      } else {
        const err = (results[j] as PromiseRejectedResult).reason;
        logger.error(`处理 ${batch[j]} 时出错`, { error: err instanceof Error ? err.message : String(err) });
        recordApiFailure();
      }
    }
  }
}

async function processSymbol(
  symbol: string,
  balance: ReturnType<typeof import('../exchange/account').fetchBalance> extends Promise<infer T> ? T : never,
  positions: ReturnType<typeof import('../exchange/account').fetchPositions> extends Promise<infer T> ? T : never
) {
  logger.info(`正在处理 ${symbol}`);

  // 1. Fetch market data
  const snapshot = await fetchMarketSnapshot(symbol);
  const currentPrice = snapshot.ticker.last ?? 0;

  // 2. Calculate indicators + orderbook analysis
  const allIndicators: { [tf: string]: TechnicalIndicators } = {};
  for (const tf of ['1m', '5m', '15m', '1h'] as const) {
    allIndicators[tf] = calcIndicators(snapshot.klines[tf]);
  }
  const orderbookAnalysis = analyzeOrderbook(snapshot.orderbook.bids, snapshot.orderbook.asks);
  const sentiment = calcSentiment(allIndicators, orderbookAnalysis, snapshot.fundingRate, snapshot.ticker.percentage);
  const marketRegime = detectMarketRegime(allIndicators);

  logger.info(`${symbol} 情绪分: ${sentiment.score} (${sentiment.overallBias}), 市场环境: ${marketRegime}`);

  // 3. Build narrative
  const narrative = buildNarrative(symbol, snapshot.klines, allIndicators, orderbookAnalysis, currentPrice);

  // 4. Detect narrative changes → record session events
  if (narrative.narrativeShift) {
    addSessionEvent({
      type: 'narrative_shift',
      symbol,
      timestamp: Date.now(),
      description: narrative.narrativeShift,
      price: currentPrice,
      metadata: { regime: marketRegime },
    });
    logger.info(`${symbol} 叙事变化: ${narrative.narrativeShift}`);
  }

  // Detect regime change
  const prevRegime = previousRegimes.get(symbol);
  const regimeChanged = prevRegime !== undefined && prevRegime !== marketRegime;
  if (regimeChanged) {
    addSessionEvent({
      type: 'regime_change',
      symbol,
      timestamp: Date.now(),
      description: `市场环境从 ${prevRegime} 变为 ${marketRegime}`,
      price: currentPrice,
      metadata: { from: prevRegime, to: marketRegime },
    });
    logger.info(`${symbol} 市场环境变化: ${prevRegime} → ${marketRegime}`);
  }
  previousRegimes.set(symbol, marketRegime);

  // Broadcast narrative
  broadcast({ type: 'narrative', data: { symbol, narrative: narrative.formatted, regime: marketRegime, bias: narrative.htfBias } });

  // 5. Check plan validity (hard price invalidation)
  const activePlan = getActivePlan(symbol);
  if (activePlan && activePlan.id) {
    const validity = evaluatePlanValidity(activePlan, currentPrice);
    if (!validity.valid) {
      invalidatePlan(activePlan.id, validity.reason);
      logger.info(`${symbol} 计划自动失效: ${validity.reason}`);
      broadcast({ type: 'plan', data: { symbol, action: 'invalidated', reason: validity.reason } });
    }
  }

  // Also check pending plans
  for (const pp of getPendingPlans(symbol)) {
    if (pp.id) {
      const validity = evaluatePlanValidity(pp, currentPrice);
      if (!validity.valid) {
        invalidatePlan(pp.id, validity.reason);
      }
    }
  }

  // 6. Strategic analysis (every 5 min or on significant change)
  let strategicContext: StrategicContext;
  const needsStrategic = shouldRunStrategicAnalysis(symbol, narrative.narrativeShift, regimeChanged);

  if (needsStrategic) {
    try {
      strategicContext = await runStrategicAnalysis(symbol, narrative, allIndicators, currentPrice);
      logger.info(`${symbol} 战略分析完成: ${strategicContext.bias}, 计划: ${strategicContext.plan?.action ?? 'N/A'}`);

      // Process strategic plan output
      if (strategicContext.plan) {
        await processStrategicPlan(symbol, strategicContext, narrative, marketRegime, currentPrice);
      }

      broadcast({ type: 'strategic', data: { symbol, regime: strategicContext.marketRegime, bias: strategicContext.bias } });
    } catch (err) {
      logger.warn(`${symbol} 战略分析失败，使用缓存`, { error: err instanceof Error ? err.message : String(err) });
      const cached = getCachedStrategicContext(symbol);
      if (cached) {
        strategicContext = cached;
      } else {
        // Fallback: create minimal strategic context
        strategicContext = {
          symbol,
          marketRegime,
          bias: 'neutral',
          reasoning: '战略分析失败，使用默认中性偏好',
          narrative,
          fetchedAt: Date.now(),
          aiProvider: 'fallback',
          aiModel: 'none',
        };
      }
    }
  } else {
    strategicContext = getCachedStrategicContext(symbol)!;
    // Update narrative reference in cached context
    strategicContext = { ...strategicContext, narrative };
  }

  // 7. Tactical execution (every tick)
  let decision;
  let aiProvider: string;
  let aiModel: string;
  let indicatorsJson: string;
  let orderbookJson: string;
  let sentimentJson: string;

  try {
    const tacticalResult = await runTacticalExecution(
      snapshot, balance, positions, strategicContext,
      allIndicators, orderbookAnalysis, sentiment,
    );
    decision = tacticalResult.decision;
    aiProvider = tacticalResult.aiProvider;
    aiModel = tacticalResult.aiModel;
    indicatorsJson = tacticalResult.indicatorsJson;
    orderbookJson = tacticalResult.orderbookJson;
    sentimentJson = tacticalResult.sentimentJson;
  } catch (err) {
    logger.error(`${symbol} 战术执行失败`, { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }

  logger.info(`${symbol} AI 决策: ${decision.action} (置信度: ${decision.confidence}, 市场环境: ${marketRegime})`, {
    reasoning: decision.reasoning,
  });

  // 8. Risk check + execute (same as before)
  const riskCheck = checkHardLimits(decision, balance, positions);

  const decisionResult = insertDecision({
    symbol: decision.symbol,
    action: decision.action,
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    aiProvider,
    aiModel,
    riskPassed: riskCheck.passed,
    riskReason: riskCheck.reason,
    executed: false,
    indicatorsJson,
    orderbookJson,
    sentimentJson,
  });
  const decisionId = Number(decisionResult.lastInsertRowid);

  broadcast({ type: 'decision', data: {
    decision, riskCheck, aiProvider, aiModel,
    strategicProvider: strategicContext.aiProvider,
    strategicModel: strategicContext.aiModel,
  } });

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
      aiProvider,
    });

    // 9. Position lifecycle with thesis support
    if (decision.action === 'LONG' || decision.action === 'SHORT') {
      // Build thesis from strategic context + plan
      const currentActivePlan = getActivePlan(symbol);
      const thesis = currentActivePlan?.thesis ?? strategicContext.reasoning;
      const strategicContextSnapshot = JSON.stringify({
        regime: strategicContext.marketRegime,
        bias: strategicContext.bias,
        reasoning: strategicContext.reasoning,
      });

      const posResult = insertPosition({
        symbol: decision.symbol,
        side: result.side,
        amount: result.amount,
        entryPrice: result.price,
        leverage: decision.params?.leverage,
        stopLoss: decision.params?.stopLossPrice,
        takeProfit: decision.params?.takeProfitPrice,
        entryOrderId: result.orderId,
        thesis,
        strategicContext: strategicContextSnapshot,
      });

      const posId = Number(posResult.lastInsertRowid);
      insertPositionOperation({
        positionId: posId,
        operation: 'OPEN',
        side: result.side,
        amount: result.amount,
        price: result.price ?? 0,
        avgEntryAfter: result.price,
        totalAmountAfter: result.amount,
      });

      // If there's a pending plan matching this trade, activate it
      for (const pp of getPendingPlans(symbol)) {
        if (pp.id && pp.direction === decision.action) {
          activatePlan(pp.id);
          break;
        }
      }

      logger.info(`${symbol} 开仓，论点: ${thesis}`);
    } else if (decision.action === 'ADD') {
      const dbPos = getOpenPositionBySymbol(decision.symbol);
      if (dbPos) {
        const oldAvg = dbPos.avg_entry_price ?? dbPos.entry_price ?? 0;
        const oldAmount = dbPos.amount ?? 0;
        const newAvg = calcNewAvgEntry(oldAvg, oldAmount, result.price ?? 0, result.amount);
        const newTotal = oldAmount + result.amount;
        updatePositionAdd(decision.symbol, newAvg, newTotal);
        insertPositionOperation({
          positionId: dbPos.id,
          operation: 'ADD',
          side: result.side,
          amount: result.amount,
          price: result.price ?? 0,
          avgEntryAfter: newAvg,
          totalAmountAfter: newTotal,
        });
        if (decision.params?.stopLossPrice || decision.params?.takeProfitPrice) {
          updatePositionSLTP(decision.symbol, decision.params?.stopLossPrice, decision.params?.takeProfitPrice);
        }
        logger.info(`${symbol} 加仓完成: 新均价 ${newAvg.toFixed(2)}, 总量 ${newTotal.toFixed(4)}`);
      }
    } else if (decision.action === 'REDUCE') {
      const dbPos = getOpenPositionBySymbol(decision.symbol);
      if (dbPos) {
        const avgEntry = dbPos.avg_entry_price ?? dbPos.entry_price ?? 0;
        const oldAmount = dbPos.amount ?? 0;
        const pnlRealized = calcReducePnl(dbPos.side, avgEntry, result.price ?? 0, result.amount);
        const newTotal = oldAmount - result.amount;
        updatePositionReduce(decision.symbol, newTotal, pnlRealized);
        insertPositionOperation({
          positionId: dbPos.id,
          operation: 'REDUCE',
          side: result.side,
          amount: result.amount,
          price: result.price ?? 0,
          pnlRealized,
          avgEntryAfter: avgEntry,
          totalAmountAfter: newTotal,
        });
        logger.info(`${symbol} 减仓完成: 实现盈亏 ${pnlRealized.toFixed(2)}, 剩余 ${newTotal.toFixed(4)}`);
      }
    } else if (decision.action === 'CLOSE') {
      const closedPos = positions.find((p) => p.symbol === decision.symbol);
      const pnl = closedPos?.unrealizedPnl ?? 0;
      closePositionRecord({
        symbol: decision.symbol,
        exitPrice: result.price ?? 0,
        pnl,
        exitOrderId: result.orderId,
      });

      const dbPos = getOpenPositionBySymbol(decision.symbol);
      if (dbPos) {
        insertPositionOperation({
          positionId: dbPos.id,
          operation: 'CLOSE',
          side: result.side,
          amount: result.amount,
          price: result.price ?? 0,
          pnlRealized: pnl,
          totalAmountAfter: 0,
        });
      }

      // Complete active plan on close
      const plan = getActivePlan(decision.symbol);
      if (plan?.id) {
        completePlan(plan.id);
      }

      // 10. Enhanced memory on close — include thesis and narrative
      try {
        const pnlPct = closedPos && closedPos.notional > 0
          ? (closedPos.unrealizedPnl / (closedPos.notional / closedPos.leverage)) * 100
          : 0;
        const outcome = pnl > 0 ? 'win' : 'loss';
        const regime = marketRegime;
        const posThesis = dbPos?.thesis ?? '';
        const narrativeStr = narrative.priceAction.description;

        insertMemory({
          symbol: decision.symbol,
          memoryType: 'trade_result',
          content: `${decision.symbol} ${closedPos?.side ?? ''} 平仓: ${outcome === 'win' ? '盈利' : '亏损'} ${pnlPct.toFixed(2)}%. 论点: ${posThesis}. 市场状态: ${narrativeStr}. 原因: ${decision.reasoning}`,
          marketCondition: regime,
          outcome,
          pnlPercent: pnlPct,
          relevanceScore: Math.abs(pnlPct) > 5 ? 1.5 : 1.0,
          tags: `${outcome},${regime}`,
        });
        updateSymbolStats(decision.symbol);
      } catch (err) {
        logger.warn('存储交易记忆失败', { error: err instanceof Error ? err.message : String(err) });
      }
    } else if (decision.action === 'ADJUST') {
      updatePositionSLTP(decision.symbol, decision.params?.stopLossPrice, decision.params?.takeProfitPrice);
    }

    // Track trade result for circuit breaker
    if (decision.action === 'CLOSE') {
      const closedPos = positions.find((p) => p.symbol === decision.symbol);
      if (closedPos) {
        const pnlPct = closedPos.unrealizedPnl / (closedPos.notional / closedPos.leverage) * 100;
        recordTradeResult(pnlPct);
        const today = new Date().toISOString().slice(0, 10);
        updateDailyPnl(today, balance.totalBalance, closedPos.unrealizedPnl, 1);
      } else {
        const today = new Date().toISOString().slice(0, 10);
        updateDailyPnl(today, balance.totalBalance, 0, 1);
      }
    } else {
      const today = new Date().toISOString().slice(0, 10);
      updateDailyPnl(today, balance.totalBalance, 0, 1);
    }

    broadcast({ type: 'trade', data: { decision, result } });
    logger.info(`交易已执行: ${result.side} ${result.amount} ${symbol} @ ${result.price}`);
  }
}

// ─── Strategic Plan Processing ───────────────────────────────────

async function processStrategicPlan(
  symbol: string,
  context: StrategicContext,
  narrative: MarketNarrative,
  marketRegime: string,
  currentPrice: number,
) {
  const plan = context.plan;
  if (!plan) return;

  if (plan.action === 'CREATE' && plan.direction && plan.thesis) {
    // Create a new trading plan
    const expiresAt = new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString(); // 1 hour
    const planId = createPlan({
      symbol,
      direction: plan.direction,
      entryCondition: plan.entryCondition ?? '',
      entryZone: { low: plan.entryZoneLow ?? currentPrice * 0.99, high: plan.entryZoneHigh ?? currentPrice * 1.01 },
      targets: plan.targets ?? [{ price: currentPrice * (plan.direction === 'LONG' ? 1.03 : 0.97), percent: 100 }],
      stopLoss: plan.stopLoss ?? currentPrice * (plan.direction === 'LONG' ? 0.97 : 1.03),
      invalidation: plan.invalidation ?? '',
      invalidationPrice: plan.invalidationPrice,
      thesis: plan.thesis,
      confidence: plan.confidence ?? 0.5,
      marketRegime,
      narrativeSnapshot: narrative.formatted,
      expiresAt,
    });

    broadcast({ type: 'plan', data: { symbol, action: 'created', planId, direction: plan.direction, thesis: plan.thesis } });
  } else if (plan.action === 'INVALIDATE') {
    const active = getActivePlan(symbol);
    if (active?.id) {
      invalidatePlan(active.id, context.reasoning);
      broadcast({ type: 'plan', data: { symbol, action: 'invalidated', reason: context.reasoning } });
    }
    // Also invalidate pending plans
    for (const pp of getPendingPlans(symbol)) {
      if (pp.id) invalidatePlan(pp.id, context.reasoning);
    }
  }
  // MAINTAIN and NONE require no action
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
