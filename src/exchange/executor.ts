import { getExchange } from './client';
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

  if (!params) {
    logger.warn(`${decision.action} 操作缺少参数: ${decision.symbol}`);
    return null;
  }

  // Set leverage
  await setLeverage(decision.symbol, params.leverage);

  const side = decision.action === 'LONG' ? 'buy' : 'sell';
  const positionValue = balance.availableBalance * (params.positionSizePercent / 100);

  // Fetch current price to calculate amount
  const ticker = await retry(() => ex.fetchTicker(decision.symbol), `fetchTicker(${decision.symbol})`);
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

  // Set stop loss
  try {
    const slSide = side === 'buy' ? 'sell' : 'buy';
    const slPrice = parseFloat(ex.priceToPrecision(decision.symbol, params.stopLossPrice));
    await ex.createOrder(decision.symbol, 'stop_market', slSide, numAmount, undefined, {
      stopPrice: slPrice,
      reduceOnly: true,
    });
    logger.info(`${decision.symbol} 止损已设置: ${slPrice}`);
  } catch (err: any) {
    logger.warn(`${decision.symbol} 止损设置失败: ${err.message}`);
  }

  // Set take profit
  try {
    const tpSide = side === 'buy' ? 'sell' : 'buy';
    const tpPrice = parseFloat(ex.priceToPrecision(decision.symbol, params.takeProfitPrice));
    await ex.createOrder(decision.symbol, 'take_profit_market', tpSide, numAmount, undefined, {
      stopPrice: tpPrice,
      reduceOnly: true,
    });
    logger.info(`${decision.symbol} 止盈已设置: ${tpPrice}`);
  } catch (err: any) {
    logger.warn(`${decision.symbol} 止盈设置失败: ${err.message}`);
  }

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

  // Cancel existing orders for this symbol
  try {
    await ex.cancelAllOrders(symbol);
    logger.info(`${symbol} 调整前已取消现有订单`);
  } catch (err: any) {
    logger.warn(`${symbol} 取消订单失败: ${err.message}`);
  }

  const amount = Math.abs(pos.contracts);
  const closeSide = pos.side === 'long' ? 'sell' : 'buy';

  // Set new stop loss
  try {
    const slPrice = parseFloat(ex.priceToPrecision(symbol, params.stopLossPrice));
    await ex.createOrder(symbol, 'stop_market', closeSide, amount, undefined, {
      stopPrice: slPrice,
      reduceOnly: true,
    });
    logger.info(`${symbol} 止损已调整为 ${slPrice}`);
  } catch (err: any) {
    logger.warn(`${symbol} 调整止损失败: ${err.message}`);
  }

  // Set new take profit
  try {
    const tpPrice = parseFloat(ex.priceToPrecision(symbol, params.takeProfitPrice));
    await ex.createOrder(symbol, 'take_profit_market', closeSide, amount, undefined, {
      stopPrice: tpPrice,
      reduceOnly: true,
    });
    logger.info(`${symbol} 止盈已调整为 ${tpPrice}`);
  } catch (err: any) {
    logger.warn(`${symbol} 调整止盈失败: ${err.message}`);
  }

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
