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

  // Place separate SL/TP orders
  const closeSide = side === 'buy' ? 'sell' : 'buy';
  await placeSLTP(decision.symbol, closeSide, numAmount, params.stopLossPrice, params.takeProfitPrice);

  return {
    orderId: order.id,
    symbol: decision.symbol,
    side,
    type: params.orderType,
    amount: numAmount,
    price: order.price ?? price,
    status: order.status ?? 'created',
  };
}

/**
 * Place separate stop-loss and take-profit orders for a position.
 * Binance doesn't support SL+TP in a single order, so we place them individually.
 */
async function placeSLTP(
  symbol: string,
  closeSide: string,
  amount: number,
  stopLossPrice: number,
  takeProfitPrice: number,
): Promise<void> {
  const ex = getExchange();
  const roundedAmount = parseFloat(ex.amountToPrecision(symbol, amount));

  try {
    const slPrice = parseFloat(ex.priceToPrecision(symbol, stopLossPrice));
    await retry(
      () => ex.createOrder(symbol, 'market', closeSide, roundedAmount, slPrice, {
        stopLossPrice: slPrice,
        reduceOnly: true,
      }),
      `placeSL(${symbol})`
    );
    logger.info(`${symbol} 止损已设置: ${slPrice}`);
  } catch (err: any) {
    logger.warn(`${symbol} 止损设置失败: ${err.message}`);
  }

  try {
    const tpPrice = parseFloat(ex.priceToPrecision(symbol, takeProfitPrice));
    await retry(
      () => ex.createOrder(symbol, 'market', closeSide, roundedAmount, tpPrice, {
        takeProfitPrice: tpPrice,
        reduceOnly: true,
      }),
      `placeTP(${symbol})`
    );
    logger.info(`${symbol} 止盈已设置: ${tpPrice}`);
  } catch (err: any) {
    logger.warn(`${symbol} 止盈设置失败: ${err.message}`);
  }
}

/**
 * Adjust an existing position's stop loss and take profit orders.
 * Cancels existing orders and places new ones.
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

  // Cancel existing conditional orders for this symbol
  try {
    await ex.cancelAllOrders(symbol);
    logger.info(`${symbol} 调整前已取消现有订单`);
  } catch (err: any) {
    logger.warn(`${symbol} 取消订单失败: ${err.message}`);
  }

  const amount = Math.abs(pos.contracts);
  const closeSide = pos.side === 'long' ? 'sell' : 'buy';

  await placeSLTP(symbol, closeSide, amount, params.stopLossPrice, params.takeProfitPrice);

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
 * Cancels old SL/TP and sets new ones based on updated position size.
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

  // Cancel old SL/TP and set new ones for total position
  try {
    await ex.cancelAllOrders(symbol);
    logger.info(`${symbol} 加仓后已取消旧订单`);
  } catch (err: any) {
    logger.warn(`${symbol} 取消旧订单失败: ${err.message}`);
  }

  const newTotalAmount = currentAmount + numAmount;
  const closeSide = side === 'buy' ? 'sell' : 'buy';

  await placeSLTP(symbol, closeSide, newTotalAmount, params.stopLossPrice, params.takeProfitPrice);

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
  const amount = Math.abs(pos.contracts);

  const order = await retry(
    () => ex.createOrder(symbol, 'market', side, amount, undefined, { reduceOnly: true }),
    `closePosition(${symbol})`
  );

  logger.info(`仓位已平: ${symbol}`, { orderId: order.id });

  // Cancel remaining orders for this symbol
  try {
    await ex.cancelAllOrders(symbol);
    logger.info(`${symbol} 剩余订单已取消`);
  } catch (err: any) {
    logger.warn(`${symbol} 取消剩余订单失败: ${err.message}`);
  }

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
