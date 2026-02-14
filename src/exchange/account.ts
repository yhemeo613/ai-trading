import { getExchange } from './client';
import { retry } from '../utils/retry';
import { getOpenPositionBySymbol } from '../persistence/models/position';

export interface AccountBalance {
  totalBalance: number;
  availableBalance: number;
  usedMargin: number;
}

export interface PositionInfo {
  symbol: string;
  side: 'long' | 'short';
  contracts: number;
  notional: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  marginMode: string;
  percentage: number;
}

export async function fetchBalance(): Promise<AccountBalance> {
  const ex = getExchange();
  const balance = await retry(() => ex.fetchBalance(), 'fetchBalance');
  const usdt = (balance as any).total?.['USDT'] ?? 0;
  const free = (balance as any).free?.['USDT'] ?? 0;
  const used = (balance as any).used?.['USDT'] ?? 0;
  return {
    totalBalance: usdt,
    availableBalance: free,
    usedMargin: used,
  };
}

export async function fetchPositions(): Promise<PositionInfo[]> {
  const ex = getExchange();
  const positions = await retry(() => ex.fetchPositions(), 'fetchPositions');
  return positions
    .filter((p) => Math.abs(p.contracts ?? 0) > 0)
    .map((p) => {
      // Use DB-stored leverage (ccxt may return inaccurate values, especially on testnet)
      const dbPos = getOpenPositionBySymbol(p.symbol);
      const leverage = dbPos?.leverage ?? p.leverage ?? 1;
      return {
        symbol: p.symbol,
        side: (p.side as 'long' | 'short') || (p.contracts! > 0 ? 'long' : 'short'),
        contracts: Math.abs(p.contracts ?? 0),
        notional: Math.abs(p.notional ?? 0),
        entryPrice: p.entryPrice ?? 0,
        markPrice: p.markPrice ?? 0,
        unrealizedPnl: p.unrealizedPnl ?? 0,
        leverage,
        marginMode: p.marginMode ?? 'cross',
        percentage: p.percentage ?? 0,
      };
    });
}
