import { getRelevantMemories, getAllSymbolStats, getSymbolStats } from './memory-store';
import { getSessionEvents } from './session-context';
import { TechnicalIndicators } from '../analysis/indicators';
import { MarketRegime } from '../core/decision';
import { getDb } from '../persistence/db';

/**
 * Detect market regime from technical indicators.
 */
export function detectMarketRegime(indicators: { [tf: string]: TechnicalIndicators }): MarketRegime {
  const tf15 = indicators['15m'];
  const tf1h = indicators['1h'];
  const primary = tf15 || tf1h || Object.values(indicators)[0];

  if (!primary) return 'quiet';

  // Check volatility first
  if (primary.atrPercent !== null && primary.atrPercent > 2.0) {
    return 'volatile';
  }

  // Check trend strength
  const strongTrend = primary.adx !== null && primary.adx > 25;
  const bullish = primary.emaTrend === '多头排列';
  const bearish = primary.emaTrend === '空头排列';

  if (strongTrend && bullish) return 'trending_up';
  if (strongTrend && bearish) return 'trending_down';

  // Check if ranging
  if (primary.adx !== null && primary.adx < 20) {
    if (primary.atrPercent !== null && primary.atrPercent < 0.5) {
      return 'quiet';
    }
    return 'ranging';
  }

  // Default: check RSI and MACD for direction
  if (primary.rsi14 !== null) {
    if (primary.rsi14 > 55 && primary.macdSignal === '金叉') return 'trending_up';
    if (primary.rsi14 < 45 && primary.macdSignal === '死叉') return 'trending_down';
  }

  return 'ranging';
}

/**
 * Build memory context string for AI prompt injection.
 */
export function buildMemoryContext(symbol: string, marketCondition?: string): string {
  const lines: string[] = ['【策略记忆与历史经验】'];

  // 1. Symbol-specific stats
  const stats = getSymbolStats(symbol);
  if (stats) {
    lines.push(`[${symbol} 历史] 共${stats.totalTrades}笔, 胜率${(stats.winRate * 100).toFixed(1)}%, 盈亏比${stats.profitFactor.toFixed(2)}, 累计${stats.totalPnl.toFixed(2)}U, 均盈${stats.avgWinPnl.toFixed(2)}/均亏${stats.avgLossPnl.toFixed(2)}`);
  }

  // 2. Relevant memories (lessons learned, includes failures)
  const memories = getRelevantMemories(symbol, marketCondition, 5);
  if (memories.length > 0) {
    lines.push('[相关经验]');
    for (const m of memories) {
      const outcomeStr = m.outcome ? ` [${m.outcome}]` : '';
      const pnlStr = m.pnl_percent != null ? ` (${m.pnl_percent > 0 ? '+' : ''}${m.pnl_percent.toFixed(2)}%)` : '';
      lines.push(`  - ${m.content}${outcomeStr}${pnlStr}`);
    }
  }

  // 3. All symbol win rates ranking (top 5)
  const allStats = getAllSymbolStats();
  if (allStats.length > 0) {
    lines.push('[胜率排名]');
    for (const s of allStats.slice(0, 5)) {
      const bar = s.winRate >= 0.5 ? '✓' : '✗';
      lines.push(`  ${bar} ${s.symbol}: ${(s.winRate * 100).toFixed(0)}%, 盈亏比${s.profitFactor.toFixed(2)}, ${s.totalTrades}笔`);
    }
  }

  // 4. Recent market observations
  try {
    const db = getDb();
    const observations = db.prepare(`
      SELECT content, created_at FROM strategy_memory
      WHERE (symbol = ? OR symbol = '*')
        AND (memory_type LIKE 'observation_%' OR memory_type LIKE 'session_%')
        AND created_at > datetime('now', '-4 hours')
      ORDER BY created_at DESC LIMIT 3
    `).all(symbol) as any[];
    if (observations.length > 0) {
      lines.push('[近期观察]');
      for (const obs of observations) {
        const time = obs.created_at?.slice(11, 16) ?? '';
        lines.push(`  [${time}] ${obs.content}`);
      }
    }
  } catch { /* ignore */ }

  return lines.join('\n');
}
