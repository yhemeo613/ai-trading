import { getExchange, getPublicExchange } from './client';
import { logger } from '../utils/logger';
import { retry } from '../utils/retry';
import { AIDecision, TradeParams } from '../core/decision';
import { AccountBalance } from './account';

export interface OrderResult {
  orderId: string;
  symbol: string;
  side: string;
  type: string;
  amount: number;
  price?: number;
  status: string;
}

export async function setLeverage(symbol: string, leverage: number): Promise<void> {
  const ex = getExchange();
  try {
    await ex.setLeverage(leverage, symbol);
    logger.info(`已设置 ${symbol} 杠杆为 ${leverage}x`);
  } catch (err: any) {
    // Some exchanges throw if leverage is already set
    if (!err.message?.includes('No need to change')) {
      throw err;
    }
  }
}

export async function executeDecision(
  decision: AIDecision,
  balance: AccountBalance
): Promise<OrderResult | null> {
  if (decision.action === 'HOLD') {
    logger.info(`${decision.symbol} 决策为持仓观望，不执行操作`);
    return null;
  }

  const ex = getExchange();
  const params = decision.params;

  if (decision.action === 'CLOSE') {
    return closePosition(decision.symbol);
  }

  if (decision.action === 'ADJUST') {
    return adjustPosition(decision.symbol, params);
  }

  if (decision.action === 'ADD') {
    return addToPosition(decision.symbol, params);
  }

  if (decision.action === 'REDUCE') {
    return reducePosition(decision.symbol, params);
  }

  if (!params) {
    logger.warn(`${decision.action} 操作缺少参数: ${decision.symbol}`);
    return null;
  }

  // LONG/SHORT 必须有完整参数
  if (!params.positionSizePercent || !params.leverage || !params.stopLossPrice || !params.takeProfitPrice) {
    logger.warn(`${decision.action} 缺少必要参数: ${decision.symbol}`, {
      positionSizePercent: params.positionSizePercent,
      leverage: params.leverage,
      stopLossPrice: params.stopLossPrice,
      takeProfitPrice: params.takeProfitPrice,
    });
    return null;
  }

  // Set leverage
  await setLeverage(decision.symbol, params.leverage);

  const side = decision.action === 'LONG' ? 'buy' : 'sell';
  const positionValue = balance.availableBalance * (params.positionSizePercent / 100);

  // Fetch current price from the matching environment (testnet or live)
  const pub = getPublicExchange();
  const ticker = await retry(() => pub.fetchTicker(decision.symbol), `fetchTicker(${decision.symbol})`);
  const price = ticker.last ?? 0;
  if (price <= 0) throw new Error(`${decision.symbol} 价格无效: ${price}`);

  const amount = (positionValue * params.leverage) / price;

  // Round to exchange precision
  const roundedAmount = ex.amountToPrecision(decision.symbol, amount);
  const numAmount = parseFloat(roundedAmount);

  if (numAmount <= 0) {
    logger.warn(`${decision.symbol} 计算数量过小`);
    return null;
  }

  // Place main order first (without SL/TP — Binance doesn't support both in one call)
  let order;
  if (params.orderType === 'MARKET') {
    order = await retry(
      () => ex.createOrder(decision.symbol, 'market', side, numAmount),
      `createMarketOrder(${decision.symbol})`
    );
  } else {
    const limitPrice = parseFloat(ex.priceToPrecision(decision.symbol, price));
    order = await retry(
      () => ex.createOrder(decision.symbol, 'limit', side, numAmount, limitPrice),
      `createLimitOrder(${decision.symbol})`
    );
  }

  logger.info(`订单已下: ${side} ${numAmount} ${decision.symbol}`, { orderId: order.id });

  return {
    orderId: order.id,
    symbol: decision.symbol,
    side,
    type: params.orderType || 'MARKET',
    amount: numAmount,
    price: order.price ?? price,
    status: order.status ?? 'created',
  };
}

/**
 * Adjust an existing position's stop loss and take profit.
 * SL/TP are now tracked in the DB and monitored by the application layer.
 */
async function adjustPosition(symbol: string, params: TradeParams | null): Promise<OrderResult | null> {
  if (!params) {
    logger.warn(`调整仓位缺少参数: ${symbol}`);
    return null;
  }

  const ex = getExchange();
  const positions = await retry(() => ex.fetchPositions([symbol]), `fetchPositions(${symbol})`);
  const pos = positions.find((p) => p.symbol === symbol && Math.abs(p.contracts ?? 0) > 0);

  if (!pos || !pos.contracts) {
    logger.info(`${symbol} 无持仓可调整`);
    return null;
  }

  const amount = Math.abs(pos.contracts);
  const closeSide = pos.side === 'long' ? 'sell' : 'buy';

  // SL/TP now tracked in DB and monitored by application layer
  return {
    orderId: 'adjust-' + Date.now(),
    symbol,
    side: closeSide,
    type: 'ADJUST',
    amount,
    price: pos.markPrice ?? 0,
    status: 'adjusted',
  };
}

/**
 * Add to an existing position (same direction).
 */
async function addToPosition(symbol: string, params: TradeParams | null): Promise<OrderResult | null> {
  if (!params) {
    logger.warn(`加仓缺少参数: ${symbol}`);
    return null;
  }

  const ex = getExchange();
  const positions = await retry(() => ex.fetchPositions([symbol]), `fetchPositions(${symbol})`);
  const pos = positions.find((p) => p.symbol === symbol && Math.abs(p.contracts ?? 0) > 0);

  if (!pos || !pos.contracts) {
    logger.info(`${symbol} 无持仓可加仓`);
    return null;
  }

  const currentAmount = Math.abs(pos.contracts);
  const addPct = params.addPercent ?? 50;
  const addAmount = currentAmount * (addPct / 100);

  const roundedAmount = ex.amountToPrecision(symbol, addAmount);
  const numAmount = parseFloat(roundedAmount);

  if (numAmount <= 0) {
    logger.warn(`${symbol} 加仓数量过小`);
    return null;
  }

  // Same direction as existing position
  const side = pos.side === 'long' ? 'buy' : 'sell';

  const order = await retry(
    () => ex.createOrder(symbol, 'market', side, numAmount),
    `addToPosition(${symbol})`
  );

  logger.info(`加仓已执行: ${side} ${numAmount} ${symbol}`, { orderId: order.id });

  return {
    orderId: order.id,
    symbol,
    side,
    type: 'MARKET',
    amount: numAmount,
    price: order.price ?? pos.markPrice ?? 0,
    status: 'added',
  };
}

/**
 * Reduce an existing position (opposite direction, reduceOnly).
 */
async function reducePosition(symbol: string, params: TradeParams | null): Promise<OrderResult | null> {
  if (!params) {
    logger.warn(`减仓缺少参数: ${symbol}`);
    return null;
  }

  const ex = getExchange();
  const positions = await retry(() => ex.fetchPositions([symbol]), `fetchPositions(${symbol})`);
  const pos = positions.find((p) => p.symbol === symbol && Math.abs(p.contracts ?? 0) > 0);

  if (!pos || !pos.contracts) {
    logger.info(`${symbol} 无持仓可减仓`);
    return null;
  }

  const currentAmount = Math.abs(pos.contracts);
  const reducePct = params.reducePercent ?? 30;
  const reduceAmount = currentAmount * (reducePct / 100);

  const roundedAmount = ex.amountToPrecision(symbol, reduceAmount);
  const numAmount = parseFloat(roundedAmount);

  if (numAmount <= 0) {
    logger.warn(`${symbol} 减仓数量过小`);
    return null;
  }

  // Opposite direction with reduceOnly
  const side = pos.side === 'long' ? 'sell' : 'buy';

  const order = await retry(
    () => ex.createOrder(symbol, 'market', side, numAmount, undefined, { reduceOnly: true }),
    `reducePosition(${symbol})`
  );

  logger.info(`减仓已执行: ${side} ${numAmount} ${symbol}`, { orderId: order.id });

  return {
    orderId: order.id,
    symbol,
    side,
    type: 'MARKET',
    amount: numAmount,
    price: order.price ?? pos.markPrice ?? 0,
    status: 'reduced',
  };
}

export async function closePosition(symbol: string): Promise<OrderResult | null> {
  const ex = getExchange();

  const positions = await retry(() => ex.fetchPositions([symbol]), `fetchPositions(${symbol})`);
  const pos = positions.find((p) => p.symbol === symbol && Math.abs(p.contracts ?? 0) > 0);

  if (!pos || !pos.contracts) {
    logger.info(`${symbol} 无持仓可平`);
    return null;
  }

  const side = pos.side === 'long' ? 'sell' : 'buy';
  const rawAmount = Math.abs(pos.contracts);

  // Round to exchange precision to avoid order rejection
  const roundedAmount = ex.amountToPrecision(symbol, rawAmount);
  const amount = parseFloat(roundedAmount);

  if (amount <= 0) {
    logger.warn(`${symbol} 平仓数量过小`);
    return null;
  }

  const order = await retry(
    () => ex.createOrder(symbol, 'market', side, amount, undefined, { reduceOnly: true }),
    `closePosition(${symbol})`
  );

  logger.info(`仓位已平: ${symbol}`, { orderId: order.id });

  return {
    orderId: order.id,
    symbol,
    side,
    type: 'MARKET',
    amount,
    price: order.price ?? 0,
    status: 'closed',
  };
}
