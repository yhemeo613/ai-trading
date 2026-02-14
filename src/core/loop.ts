import { logger } from '../utils/logger';
import { fetchMarketSnapshot } from '../exchange/market-data';
import { fetchBalance, fetchPositions } from '../exchange/account';
import { getTradingPairs } from './pair-selector';
import { checkHardLimits } from '../risk/hard-limits';
import { executeDecision, closePosition } from '../exchange/executor';
import { isCircuitTripped, recordTradeResult, recordApiFailure, recordApiSuccess, updateDailyLoss, getCircuitState } from '../risk/circuit-breaker';
import { computeDynamicLimits, type DynamicRiskLimits } from '../risk/dynamic-limits';
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

// Roundtable imports
import { config } from '../config';
import { runRoundtableSession } from '../roundtable/session';
import { buildMemoryContext } from '../memory/memory-context';
import { getCircuitState as getCircuitFullState, getStreakInfo } from '../risk/circuit-breaker';
import { getPositionThesis } from '../persistence/models/position';
import { getPositionOperations } from '../persistence/models/position-ops';
import type { AIDecision } from './decision';
import type { ChairmanDecision } from '../roundtable/types';
import type { RoundtableSessionInput } from '../roundtable/types';

let running = false;
let sltpMonitorRunning = false;
let sltpLock = false; // Prevent concurrent SL/TP processing
let loopAbortController: AbortController | null = null;

const LOOP_INTERVAL = 60 * 1000;
const SLTP_MONITOR_INTERVAL = 5 * 1000;
const SCAN_INTERVAL = 5 * 60 * 1000;
const MAX_CONCURRENCY = 3;
let lastScanTime = 0;
let lastDecayDate = '';

// Track previous market regime per symbol for change detection
const previousRegimes: Map<string, string> = new Map();

export function isRunning() { return running; }

export function getLoopAbortSignal(): AbortSignal | undefined {
  return loopAbortController?.signal;
}

export function clearLoopState() {
  previousRegimes.clear();
  lastScanTime = 0;
  lastDecayDate = '';
  sltpLock = false;
  loopAbortController = null;
}

export async function startLoop() {
  if (running) return;
  running = true;
  loopAbortController = new AbortController();
  logger.info(`交易循环已启动 (${config.roundtable.enabled ? '圆桌会议模式' : '双层AI模式'})`);

  // Start independent SL/TP monitor
  startSltpMonitor();

  while (running) {
    try {
      await tick();
    } catch (err) {
      if (!running) break; // Aborted during tick, exit cleanly
      logger.error('循环执行错误', { error: err instanceof Error ? err.message : String(err) });
      recordApiFailure();
    }
    if (!running) break;
    await sleep(LOOP_INTERVAL);
  }
}

export function stopLoop() {
  running = false;
  sltpMonitorRunning = false;
  // Abort all in-flight AI requests
  if (loopAbortController) {
    loopAbortController.abort();
    loopAbortController = null;
  }
  logger.info('交易循环已停止');
}

// ─── Independent SL/TP price monitor (high frequency) ───────────

function startSltpMonitor() {
  if (sltpMonitorRunning) return;
  sltpMonitorRunning = true;
  logger.info(`止盈止损监控已启动 (${SLTP_MONITOR_INTERVAL / 1000}s 间隔)`);

  (async () => {
    while (sltpMonitorRunning && running) {
      try {
        await sltpMonitorTick();
      } catch (err) {
        logger.warn('止盈止损监控错误', { error: err instanceof Error ? err.message : String(err) });
      }
      await sleep(SLTP_MONITOR_INTERVAL);
    }
    logger.info('止盈止损监控已停止');
  })();
}

async function sltpMonitorTick() {
  // Only check if there are open positions with SL/TP in DB
  const dbOpenPositions = getOpenPositions() as any[];
  const hasSltp = dbOpenPositions.some((p) => p.stop_loss || p.take_profit);
  if (!hasSltp) return;

  const positions = await fetchPositions();
  recordApiSuccess();

  const balance = await fetchBalance();
  await checkStopLossAndTakeProfit(positions, balance);
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

  const dynamicLimits = computeDynamicLimits(balance);

  const positionSymbols = positions.map((p) => p.symbol).filter((s) => !basePairs.includes(s));

  // Clean up orphaned positions: if DB says position is open but exchange has no position,
  // close the DB record
  try {
    const dbOpenPositions = getOpenPositions() as any[];
    const exchangeSymbols = new Set(positions.map((p) => p.symbol));
    for (const dbPos of dbOpenPositions) {
      if (!exchangeSymbols.has(dbPos.symbol)) {
        logger.info(`检测到孤立仓位 ${dbPos.symbol}，正在关闭数据库记录...`);
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
    logger.warn('孤立仓位清理失败', { error: err.message });
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
    if (lossPct > 0) updateDailyLoss(lossPct, dynamicLimits.maxDailyLossPct);
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

  // Check SL/TP triggers before processing symbols
  const closedBySltp = await checkStopLossAndTakeProfit(positions, balance);

  // Roundtable mode processes symbols sequentially (each session already has 6 parallel AI calls)
  const batchSize = config.roundtable.enabled ? 1 : MAX_CONCURRENCY;

  // Process pairs in parallel batches
  for (let i = 0; i < allPairs.length; i += batchSize) {
    if (!running || isCircuitTripped()) break;

    const batch = allPairs.slice(i, i + batchSize);
    const filteredBatch = batch.filter((symbol) => !closedBySltp.has(symbol));
    const results = await Promise.allSettled(
      filteredBatch.map((symbol) => processSymbol(symbol, balance, positions, dynamicLimits))
    );

    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'fulfilled') {
        recordApiSuccess();
      } else {
        const err = (results[j] as PromiseRejectedResult).reason;
        // Don't count abort errors as API failures
        if (!running || (err instanceof Error && err.message === 'AI 请求已取消')) continue;
        logger.error(`处理 ${filteredBatch[j]} 时出错`, { error: err instanceof Error ? err.message : String(err) });
        recordApiFailure();
      }
    }
  }
}

// ─── Application-layer SL/TP monitoring ──────────────────────────

async function checkStopLossAndTakeProfit(
  positions: Awaited<ReturnType<typeof fetchPositions>>,
  balance: Awaited<ReturnType<typeof fetchBalance>>,
): Promise<Set<string>> {
  const closedSymbols = new Set<string>();

  // Prevent concurrent SL/TP processing (race between main loop and monitor)
  if (sltpLock) return closedSymbols;
  sltpLock = true;

  try {
  for (const pos of positions) {
    const dbPos = getOpenPositionBySymbol(pos.symbol) as any;
    if (!dbPos) continue;

    const sl = dbPos.stop_loss as number | null;
    const tp = dbPos.take_profit as number | null;
    if (!sl && !tp) continue;

    const mark = pos.markPrice ?? 0;
    if (mark <= 0) continue;

    let triggered: 'sl' | 'tp' | null = null;

    if (pos.side === 'long') {
      if (sl && mark <= sl) triggered = 'sl';
      else if (tp && mark >= tp) triggered = 'tp';
    } else {
      // short
      if (sl && mark >= sl) triggered = 'sl';
      else if (tp && mark <= tp) triggered = 'tp';
    }

    if (!triggered) continue;

    const label = triggered === 'sl' ? '止损' : '止盈';
    const triggerPrice = triggered === 'sl' ? sl : tp;
    logger.info(`${pos.symbol} 触发${label}: 标记价 ${mark}, ${label}价 ${triggerPrice}`);

    try {
      const result = await closePosition(pos.symbol);
      if (result) {
        closedSymbols.add(pos.symbol);

        const pnl = pos.unrealizedPnl ?? 0;

        // Record position operation BEFORE closing DB record (closePositionRecord sets status='closed')
        insertPositionOperation({
          positionId: dbPos.id,
          operation: 'CLOSE',
          side: result.side,
          amount: result.amount,
          price: result.price ?? mark,
          pnlRealized: pnl,
          totalAmountAfter: 0,
        });

        closePositionRecord({
          symbol: pos.symbol,
          exitPrice: result.price ?? mark,
          pnl,
          exitOrderId: result.orderId,
        });

        insertTrade({
          symbol: pos.symbol,
          action: 'CLOSE',
          side: result.side,
          amount: result.amount,
          price: result.price ?? mark,
          stopLoss: sl ?? undefined,
          takeProfit: tp ?? undefined,
          orderId: result.orderId,
          confidence: 1,
          reasoning: `应用层${label}触发 (标记价 ${mark})`,
          aiProvider: 'system',
          pnl,
        });

        // Complete active plan
        const plan = getActivePlan(pos.symbol);
        if (plan?.id) {
          completePlan(plan.id);
        }

        // Record trade memory
        try {
          const pnlPct = pos.notional > 0
            ? (pnl / (pos.notional / pos.leverage)) * 100
            : 0;
          const outcome = pnl > 0 ? 'win' : 'loss';
          const posThesis = dbPos.thesis ?? '';

          insertMemory({
            symbol: pos.symbol,
            memoryType: 'trade_result',
            content: `${pos.symbol} ${pos.side} ${label}平仓: ${outcome === 'win' ? '盈利' : '亏损'} ${pnlPct.toFixed(2)}%. 论点: ${posThesis}. 原因: ${label}触发 (标记价 ${mark})`,
            marketCondition: 'unknown',
            outcome,
            pnlPercent: pnlPct,
            relevanceScore: Math.abs(pnlPct) > 5 ? 1.5 : 1.0,
            tags: `${outcome},${label}`,
          });
          updateSymbolStats(pos.symbol);
        } catch (err) {
          logger.warn('存储交易记忆失败', { error: err instanceof Error ? err.message : String(err) });
        }

        // Circuit breaker tracking
        const pnlPct = pos.notional > 0
          ? (pnl / (pos.notional / pos.leverage)) * 100
          : 0;
        if (pnlPct !== 0) recordTradeResult(pnlPct);
        const today = new Date().toISOString().slice(0, 10);
        updateDailyPnl(today, balance.totalBalance, pnl, 1);

        broadcast({ type: 'trade', data: {
          decision: { symbol: pos.symbol, action: 'CLOSE', confidence: 1, reasoning: `${label}触发` },
          result,
        }});
        logger.info(`${pos.symbol} ${label}平仓完成: PnL ${pnl.toFixed(2)}`);
      }
    } catch (err: any) {
      logger.error(`${pos.symbol} ${label}平仓失败: ${err.message}`);
    }
  }

  } finally {
    sltpLock = false;
  }

  return closedSymbols;
}

async function processSymbol(
  symbol: string,
  balance: ReturnType<typeof import('../exchange/account').fetchBalance> extends Promise<infer T> ? T : never,
  positions: ReturnType<typeof import('../exchange/account').fetchPositions> extends Promise<infer T> ? T : never,
  dynamicLimits: DynamicRiskLimits,
) {
  logger.info(`正在处理 ${symbol}`);
  const useRoundtable = config.roundtable.enabled;

  // Abort early if loop was stopped
  if (!running) return;

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

  // ─── Price-Watch Gateway (roundtable mode only) ─────────────────
  // Skip expensive AI roundtable calls when price is not near any entry zone.
  // Flow: no position & no plan → run init roundtable to generate plans
  //       has pending plan & price outside zone → skip AI, just monitor
  //       has pending plan & price in zone → run confirmation roundtable
  //       has position → skip (SL/TP monitor handles it), unless regime/narrative shift
  //       all plans expired → regenerate
  if (useRoundtable) {
    const currentPosition = positions.find((p) => p.symbol === symbol);
    const pendingPlans = getPendingPlans(symbol);
    const activePlanNow = getActivePlan(symbol);
    const hasPosition = !!currentPosition;
    const hasPendingPlans = pendingPlans.length > 0;
    const hasActivePlan = !!activePlanNow;
    const significantShift = !!narrative.narrativeShift || regimeChanged;

    // State 1: Has position → skip roundtable (SL/TP monitor covers it)
    //          Exception: significant narrative/regime shift triggers a review
    if (hasPosition) {
      if (!significantShift) {
        logger.info(`${symbol} 价格监控中 [持仓中，SL/TP监控覆盖]`);
        broadcast({ type: 'pricewatch', data: { symbol, state: 'position_held', price: currentPrice } });
        return;
      }
      // significantShift → fall through to run roundtable for position review
      logger.info(`${symbol} 持仓中但检测到市场剧变，触发圆桌审查`);
    }

    // State 2: No position, no pending plans, no active plan → need initial roundtable
    if (!hasPosition && !hasPendingPlans && !hasActivePlan) {
      // Fall through to run roundtable — it will generate plans
      // But rate-limit: if we already generated plans this session and they all expired,
      // still fall through (the roundtable will produce new ones)
      logger.info(`${symbol} 无计划无持仓，运行初始化圆桌产出交易计划`);
      // Mark that we'll generate plans (reset after plans are created)
    }

    // State 3: Has pending plans, price NOT in any entry zone → skip AI
    if (!hasPosition && hasPendingPlans) {
      const triggered = pendingPlans.find((p) => evaluatePlanEntry(p, currentPrice));
      if (!triggered) {
        // Price not near any entry zone — pure monitoring, zero AI
        const zones = pendingPlans.map((p) =>
          `${p.direction} [${p.entryZone.low.toFixed(2)}-${p.entryZone.high.toFixed(2)}]`
        ).join(', ');
        logger.info(`${symbol} 价格监控中: ${currentPrice.toFixed(2)} | 等待入场区间: ${zones}`);
        broadcast({
          type: 'pricewatch',
          data: {
            symbol,
            state: 'monitoring',
            price: currentPrice,
            plans: pendingPlans.map((p) => ({
              id: p.id,
              direction: p.direction,
              entryZone: p.entryZone,
              confidence: p.confidence,
            })),
          },
        });
        return;
      }

      // State 4: Price entered entry zone → run confirmation roundtable
      logger.info(`${symbol} 价格 ${currentPrice.toFixed(2)} 进入 ${triggered.direction} 入场区间 [${triggered.entryZone.low.toFixed(2)}-${triggered.entryZone.high.toFixed(2)}]，触发确认圆桌`);
      broadcast({
        type: 'pricewatch',
        data: {
          symbol,
          state: 'entry_triggered',
          price: currentPrice,
          triggeredPlan: { id: triggered.id, direction: triggered.direction, entryZone: triggered.entryZone },
        },
      });
      // Fall through to run roundtable for confirmation
    }

    // States that fall through: 2 (no plans), 4 (price in zone), 1+shift (position review)
    // All proceed to the roundtable below
  }

  // 6. Strategic analysis (every 5 min or on significant change)
  //    In roundtable mode, skip separate strategic AI call — the Chief Strategist role handles it.
  let strategicContext: StrategicContext;

  if (useRoundtable) {
    // Use cached context or lightweight fallback; roundtable's Chief Strategist provides the real analysis
    const cached = getCachedStrategicContext(symbol);
    if (cached) {
      strategicContext = { ...cached, narrative };
    } else {
      strategicContext = {
        symbol,
        marketRegime,
        bias: 'neutral',
        reasoning: '圆桌模式：首席策略师将在会议中提供战略分析',
        thinking: '',
        narrative,
        fetchedAt: Date.now(),
        aiProvider: 'roundtable',
        aiModel: 'deferred',
      };
    }
  } else {
  const needsStrategic = shouldRunStrategicAnalysis(symbol, narrative.narrativeShift, regimeChanged);

  if (needsStrategic) {
    try {
      strategicContext = await runStrategicAnalysis(symbol, narrative, allIndicators, currentPrice, loopAbortController?.signal);
      if (!running) return; // Loop stopped during AI call, abort immediately
      logger.info(`${symbol} 战略分析完成: ${strategicContext.bias}, 计划: ${strategicContext.plan?.action ?? 'N/A'}`);

      // Process strategic plan output
      if (strategicContext.plan) {
        await processStrategicPlan(symbol, strategicContext, narrative, marketRegime, currentPrice);
      }

      broadcast({ type: 'strategic', data: { symbol, regime: strategicContext.marketRegime, bias: strategicContext.bias } });
    } catch (err) {
      if (!running) return; // Aborted, don't fall back to cache
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
          thinking: '',
          narrative,
          fetchedAt: Date.now(),
          aiProvider: 'fallback',
          aiModel: 'none',
        };
      }
    }
  } else {
    const cached = getCachedStrategicContext(symbol);
    if (cached) {
      // Update narrative reference in cached context
      strategicContext = { ...cached, narrative };
    } else {
      // Defensive fallback: cache miss despite shouldRunStrategicAnalysis returning false
      strategicContext = {
        symbol,
        marketRegime,
        bias: 'neutral',
        reasoning: '缓存未命中，使用默认中性偏好',
        thinking: '',
        narrative,
        fetchedAt: Date.now(),
        aiProvider: 'fallback',
        aiModel: 'none',
      };
    }
  }
  } // end non-roundtable strategic analysis

  // 7. Tactical execution / Roundtable (every tick)
  let decision: AIDecision;
  let aiProvider: string;
  let aiModel: string;
  let tacticalThinking: string;
  let indicatorsJson: string;
  let orderbookJson: string;
  let sentimentJson: string;

  if (useRoundtable) {
    // ─── Roundtable Mode ──────────────────────────────────────
    try {
      const roundtableInput: RoundtableSessionInput = {
        market: {
          symbol,
          currentPrice,
          indicators: allIndicators,
          orderbook: orderbookAnalysis,
          sentiment,
          narrative,
          fundingRate: snapshot.fundingRate,
          ticker: {
            last: snapshot.ticker.last,
            percentage: snapshot.ticker.percentage,
            volume: snapshot.ticker.volume,
            quoteVolume: snapshot.ticker.quoteVolume,
          },
        },
        account: {
          balance,
          positions,
          circuitBreakerState: getCircuitFullState(),
          streakInfo: getStreakInfo(),
          dynamicLimits,
        },
        strategy: {
          strategicContext,
          memoryContext: buildMemoryContext(symbol, marketRegime),
          activePlan: getActivePlan(symbol),
          positionOps: (() => {
            try {
              const dbPos = getOpenPositionBySymbol(symbol);
              return dbPos ? getPositionOperations(dbPos.id) : [];
            } catch { return []; }
          })(),
          positionThesis: getPositionThesis(symbol) ?? null,
        },
      };

      const rtResult = await runRoundtableSession(roundtableInput, loopAbortController?.signal);
      if (!running) return;

      // Convert ChairmanDecision → AIDecision
      decision = chairmanToAIDecision(rtResult.chairmanDecision);
      aiProvider = `roundtable(${rtResult.depth})`;
      aiModel = `consensus:${rtResult.consensusLevel}`;
      tacticalThinking = rtResult.chairmanDecision.reasoning;
      indicatorsJson = JSON.stringify(allIndicators);
      orderbookJson = JSON.stringify(orderbookAnalysis);
      sentimentJson = JSON.stringify(sentiment);
    } catch (err) {
      if (!running) return;
      logger.error(`${symbol} 圆桌会议失败`, { error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  } else {
    // ─── Legacy Tactical Mode ─────────────────────────────────
    try {
      const tacticalResult = await runTacticalExecution(
        snapshot, balance, positions, strategicContext,
        allIndicators, orderbookAnalysis, sentiment,
        loopAbortController?.signal,
        dynamicLimits,
      );
      if (!running) return;
      decision = tacticalResult.decision;
      aiProvider = tacticalResult.aiProvider;
      aiModel = tacticalResult.aiModel;
      tacticalThinking = tacticalResult.thinking;
      indicatorsJson = tacticalResult.indicatorsJson;
      orderbookJson = tacticalResult.orderbookJson;
      sentimentJson = tacticalResult.sentimentJson;
    } catch (err) {
      if (!running) return;
      logger.error(`${symbol} 战术执行失败`, { error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  logger.info(`${symbol} AI 决策: ${decision.action} (置信度: ${decision.confidence}, 市场环境: ${marketRegime})`, {
    reasoning: decision.reasoning,
  });

  // 8. Risk check + execute (same as before)
  const riskCheck = checkHardLimits(decision, balance, positions, dynamicLimits);

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
    tacticalThinking,
    strategicThinking: strategicContext.thinking,
    paramsJson: decision.params ? JSON.stringify(decision.params) : undefined,
  });
  const decisionId = Number(decisionResult.lastInsertRowid);

  broadcast({ type: 'decision', data: {
    decision, riskCheck, aiProvider, aiModel,
    tacticalThinking,
    strategicProvider: strategicContext.aiProvider,
    strategicModel: strategicContext.aiModel,
    strategicThinking: strategicContext.thinking,
  } });

  if (!riskCheck.passed) {
    logger.warn(`${symbol} 风控检查未通过: ${riskCheck.reason}`);
    return;
  }

  if (decision.action === 'HOLD') {
    return;
  }

  // Final check: abort if loop was stopped while we were processing
  if (!running) {
    logger.info(`${symbol} 交易循环已停止，跳过执行 ${decision.action}`);
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

      // Fetch DB position BEFORE closing (closePositionRecord sets status='closed')
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

      closePositionRecord({
        symbol: decision.symbol,
        exitPrice: result.price ?? 0,
        pnl,
        exitOrderId: result.orderId,
      });

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

// ─── Roundtable → AIDecision Adapter ─────────────────────────────

function chairmanToAIDecision(cd: ChairmanDecision): AIDecision {
  return {
    action: cd.action,
    symbol: cd.symbol,
    confidence: cd.confidence,
    reasoning: cd.reasoning,
    params: cd.params ? {
      positionSizePercent: cd.params.positionSizePercent ?? undefined,
      leverage: cd.params.leverage ?? undefined,
      stopLossPrice: cd.params.stopLossPrice ?? undefined,
      takeProfitPrice: cd.params.takeProfitPrice ?? undefined,
      orderType: cd.params.orderType ?? undefined,
    } : null,
    marketRegime: cd.marketRegime,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
