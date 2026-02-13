import { getExchange } from './client';
import { logger } from '../utils/logger';
import { retry } from '../utils/retry';
import { AIDecision } from '../core/decision';
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
    logger.info(`Set leverage for ${symbol} to ${leverage}x`);
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
    logger.info(`HOLD decision for ${decision.symbol}, no action`);
    return null;
  }

  const ex = getExchange();
  const params = decision.params;

  if (decision.action === 'CLOSE') {
    return closePosition(decision.symbol);
  }

  if (!params) {
    logger.warn(`No params for ${decision.action} on ${decision.symbol}`);
    return null;
  }

  // Set leverage
  await setLeverage(decision.symbol, params.leverage);

  const side = decision.action === 'LONG' ? 'buy' : 'sell';
  const positionValue = balance.availableBalance * (params.positionSizePercent / 100);

  // Fetch current price to calculate amount
  const ticker = await retry(() => ex.fetchTicker(decision.symbol), `fetchTicker(${decision.symbol})`);
  const price = ticker.last ?? 0;
  if (price <= 0) throw new Error(`Invalid price for ${decision.symbol}: ${price}`);

  const amount = (positionValue * params.leverage) / price;

  // Round to exchange precision
  const market = ex.market(decision.symbol);
  const roundedAmount = ex.amountToPrecision(decision.symbol, amount);
  const numAmount = parseFloat(roundedAmount);

  if (numAmount <= 0) {
    logger.warn(`Calculated amount too small for ${decision.symbol}`);
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

  logger.info(`Order placed: ${side} ${numAmount} ${decision.symbol}`, { orderId: order.id });

  // Set stop loss
  try {
    const slSide = side === 'buy' ? 'sell' : 'buy';
    const slPrice = parseFloat(ex.priceToPrecision(decision.symbol, params.stopLossPrice));
    await ex.createOrder(decision.symbol, 'stop_market', slSide, numAmount, undefined, {
      stopPrice: slPrice,
      reduceOnly: true,
    });
    logger.info(`Stop loss set at ${slPrice} for ${decision.symbol}`);
  } catch (err: any) {
    logger.warn(`Failed to set stop loss for ${decision.symbol}: ${err.message}`);
  }

  // Set take profit
  try {
    const tpSide = side === 'buy' ? 'sell' : 'buy';
    const tpPrice = parseFloat(ex.priceToPrecision(decision.symbol, params.takeProfitPrice));
    await ex.createOrder(decision.symbol, 'take_profit_market', tpSide, numAmount, undefined, {
      stopPrice: tpPrice,
      reduceOnly: true,
    });
    logger.info(`Take profit set at ${tpPrice} for ${decision.symbol}`);
  } catch (err: any) {
    logger.warn(`Failed to set take profit for ${decision.symbol}: ${err.message}`);
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

export async function closePosition(symbol: string): Promise<OrderResult | null> {
  const ex = getExchange();
  const positions = await retry(() => ex.fetchPositions([symbol]), `fetchPositions(${symbol})`);
  const pos = positions.find((p) => p.symbol === symbol && Math.abs(p.contracts ?? 0) > 0);

  if (!pos || !pos.contracts) {
    logger.info(`No open position to close for ${symbol}`);
    return null;
  }

  const side = pos.side === 'long' ? 'sell' : 'buy';
  const amount = Math.abs(pos.contracts);

  const order = await retry(
    () => ex.createOrder(symbol, 'market', side, amount, undefined, { reduceOnly: true }),
    `closePosition(${symbol})`
  );

  logger.info(`Position closed: ${symbol}`, { orderId: order.id });

  // Cancel remaining orders for this symbol
  try {
    await ex.cancelAllOrders(symbol);
    logger.info(`Cancelled remaining orders for ${symbol}`);
  } catch (err: any) {
    logger.warn(`Failed to cancel orders for ${symbol}: ${err.message}`);
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
