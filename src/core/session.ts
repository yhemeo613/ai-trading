import { aiChat } from '../ai/router';
import { AIMessage } from '../ai/provider';
import { AIDecision, parseAIDecision } from './decision';
import { MarketSnapshot } from '../exchange/market-data';
import { AccountBalance, PositionInfo } from '../exchange/account';
import { logger } from '../utils/logger';

function formatKlines(klines: any[][], label: string): string {
  if (!klines.length) return `${label}: no data`;
  const recent = klines.slice(-10);
  const lines = recent.map((k) => {
    const [ts, open, high, low, close, vol] = k;
    const date = new Date(ts).toISOString().slice(0, 16);
    return `  ${date} O:${open} H:${high} L:${low} C:${close} V:${vol}`;
  });
  return `${label} (last ${recent.length} candles):\n${lines.join('\n')}`;
}

function buildSystemPrompt(): string {
  return `You are an expert cryptocurrency futures trader AI. You analyze market data and make trading decisions.

RULES:
- You trade USDT-margined perpetual futures on Binance
- Return ONLY valid JSON matching the required schema, no other text
- Be conservative: only trade when you have high confidence (>0.6)
- Always set stop loss and take profit
- Position size: 1-10% of available balance
- Leverage: 1-10x (prefer lower leverage)
- Consider multiple timeframes, orderbook depth, funding rate, and existing positions
- If unsure, return HOLD

RESPONSE FORMAT (strict JSON):
{
  "action": "LONG" | "SHORT" | "CLOSE" | "HOLD" | "ADJUST",
  "symbol": "BTC/USDT",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation",
  "params": {
    "positionSizePercent": 1-10,
    "leverage": 1-10,
    "stopLossPrice": number,
    "takeProfitPrice": number,
    "orderType": "MARKET" | "LIMIT"
  } or null (for HOLD)
}`;
}

function buildUserPrompt(
  snapshot: MarketSnapshot,
  balance: AccountBalance,
  positions: PositionInfo[]
): string {
  const posStr = positions.length
    ? positions.map((p) =>
        `  ${p.symbol} ${p.side} ${p.contracts} contracts @ ${p.entryPrice}, mark: ${p.markPrice}, PnL: ${p.unrealizedPnl.toFixed(2)} USDT, leverage: ${p.leverage}x`
      ).join('\n')
    : '  None';

  return `ANALYZE THIS MARKET DATA AND MAKE A TRADING DECISION:

Symbol: ${snapshot.symbol}

ACCOUNT:
  Total Balance: ${balance.totalBalance.toFixed(2)} USDT
  Available: ${balance.availableBalance.toFixed(2)} USDT
  Used Margin: ${balance.usedMargin.toFixed(2)} USDT

CURRENT POSITIONS:
${posStr}

TICKER:
  Last: ${snapshot.ticker.last}
  Bid: ${snapshot.ticker.bid}
  Ask: ${snapshot.ticker.ask}
  24h Volume: ${snapshot.ticker.quoteVolume.toFixed(0)} USDT
  24h Change: ${snapshot.ticker.percentage?.toFixed(2)}%

FUNDING RATE: ${snapshot.fundingRate !== null ? (snapshot.fundingRate * 100).toFixed(4) + '%' : 'N/A'}

ORDERBOOK (top 10):
  Bids: ${snapshot.orderbook.bids.slice(0, 5).map(([p, q]) => `${p}@${q}`).join(', ')}
  Asks: ${snapshot.orderbook.asks.slice(0, 5).map(([p, q]) => `${p}@${q}`).join(', ')}

${formatKlines(snapshot.klines['1h'], '1H KLINES')}

${formatKlines(snapshot.klines['4h'], '4H KLINES')}

${formatKlines(snapshot.klines['1d'], '1D KLINES')}

Return your trading decision as JSON:`;
}

export async function runTradingSession(
  snapshot: MarketSnapshot,
  balance: AccountBalance,
  positions: PositionInfo[]
): Promise<AIDecision> {
  const messages: AIMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserPrompt(snapshot, balance, positions) },
  ];

  // First attempt
  try {
    const response = await aiChat(messages);
    logger.info(`AI response from ${response.provider}/${response.model}`, {
      usage: response.usage,
    });
    return parseAIDecision(response.content);
  } catch (firstErr) {
    logger.warn('First AI attempt failed, retrying once', {
      error: firstErr instanceof Error ? firstErr.message : String(firstErr),
    });

    // Retry once
    const response = await aiChat(messages);
    return parseAIDecision(response.content);
  }
}
