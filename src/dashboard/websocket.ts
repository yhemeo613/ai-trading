import WebSocket from 'ws';
import http from 'http';
import { logger } from '../utils/logger';
import { fetchTicker } from '../exchange/market-data';
import { fetchBalance, fetchPositions } from '../exchange/account';
import { getTradingPairs } from '../core/pair-selector';
import { getActiveKeyLevels } from '../core/key-price-level';

let wss: WebSocket.Server | null = null;
let realtimeTimer: ReturnType<typeof setInterval> | null = null;

const MAIN_TICKERS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'BNB/USDT:USDT', 'XRP/USDT:USDT', 'DOGE/USDT:USDT'];
const REALTIME_INTERVAL = 3000; // 3 seconds

export function initWebSocket(server: http.Server) {
  wss = new WebSocket.Server({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    logger.info('WebSocket 客户端已连接');
    ws.on('error', (err) => {
      logger.warn('WebSocket 客户端错误', { error: err.message });
    });
    ws.on('close', () => logger.info('WebSocket 客户端已断开'));
  });
  logger.info('WebSocket 服务已在 /ws 路径初始化');

  // Start realtime data push
  startRealtimePush();
}

export function broadcast(data: any) {
  if (!wss) return;
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function hasClients(): boolean {
  if (!wss) return false;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

let pushRunning = false;

async function pushRealtimeData() {
  // Skip if no clients connected or already running
  if (!hasClients() || pushRunning) return;
  pushRunning = true;

  try {
    // Fetch tickers and account in parallel
    const [tickerResults, balance, positions] = await Promise.all([
      Promise.allSettled(
        MAIN_TICKERS.map(async (sym) => {
          const t = await fetchTicker(sym);
          const short = sym.replace('/USDT:USDT', '');
          return { name: short, price: t.last ?? 0, change: t.percentage ?? 0 };
        })
      ),
      fetchBalance().catch(() => null),
      fetchPositions().catch(() => null),
    ]);

    // Push tickers
    const tickers = tickerResults
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .map((r) => r.value);
    if (tickers.length > 0) {
      broadcast({ type: 'tickers', data: tickers });
    }

    // Push account + positions
    if (balance && positions) {
      const unrealizedPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
      broadcast({
        type: 'account',
        data: { balance, positions, unrealizedPnl },
      });

      // Push pricewatch state (from DB, no extra API calls)
      const pairs = getTradingPairs();
      const positionSymbols = new Set(positions.map(p => p.symbol));
      const tickerMap = new Map<string, number>();
      for (const t of tickers) {
        tickerMap.set(t.name, t.price);
      }

      for (const symbol of pairs) {
        const shortName = symbol.replace('/USDT:USDT', '');
        const price = tickerMap.get(shortName) ?? 0;

        if (positionSymbols.has(symbol)) {
          broadcast({ type: 'pricewatch', data: { symbol, state: 'position_held', price } });
        } else {
          const levels = getActiveKeyLevels(symbol);
          if (levels.length > 0) {
            broadcast({
              type: 'pricewatch',
              data: {
                symbol,
                state: 'monitoring',
                price,
                keyLevels: levels.map(l => ({
                  id: l.id, price: l.price, type: l.type, direction: l.direction,
                  triggerRadius: l.triggerRadius, confidence: l.confidence,
                })),
              },
            });
          } else {
            broadcast({ type: 'pricewatch', data: { symbol, state: 'waiting', price } });
          }
        }
      }
    }
  } catch (err) {
    // Silently ignore — don't break the timer
  } finally {
    pushRunning = false;
  }
}

function startRealtimePush() {
  if (realtimeTimer) return;
  realtimeTimer = setInterval(pushRealtimeData, REALTIME_INTERVAL);
  logger.info(`实时数据推送已启动 (${REALTIME_INTERVAL}ms 间隔)`);
}

export function stopRealtimePush() {
  if (realtimeTimer) {
    clearInterval(realtimeTimer);
    realtimeTimer = null;
  }
}
