import { getDb } from '../persistence/db';
import { insertMemory } from '../memory/memory-store';
import { aiChat } from '../ai/router';
import { AIMessage } from '../ai/provider';
import { logger } from '../utils/logger';

let lastReviewTradeCount = 0;
let lastReviewDate = '';
let lastReviewTime = 0;
const REVIEW_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours minimum between reviews
const REVIEW_TRADE_THRESHOLD = 20; // every 20 closed trades

/**
 * Check if a strategy review should run.
 * Triggers every 20 closed trades or every 4 hours.
 */
export function shouldRunReview(): boolean {
  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM positions WHERE status = 'closed'"
  ).get() as { cnt: number };

  const now = Date.now();

  // Minimum interval check
  if (now - lastReviewTime < REVIEW_INTERVAL) return false;

  if (row.cnt >= 5 && row.cnt - lastReviewTradeCount >= REVIEW_TRADE_THRESHOLD) {
    return true;
  }

  // Also trigger if enough time has passed and we have enough data
  if (row.cnt >= 10 && now - lastReviewTime >= REVIEW_INTERVAL) {
    return true;
  }

  return false;
}

/**
 * Analyze trade history grouped by symbol, condition, and operation type.
 */
function analyzeTradeHistory(): any {
  const db = getDb();

  const bySymbol = db.prepare(`
    SELECT symbol,
      COUNT(*) as total,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
      SUM(pnl) as total_pnl,
      AVG(CASE WHEN pnl > 0 THEN pnl END) as avg_win,
      AVG(CASE WHEN pnl < 0 THEN pnl END) as avg_loss
    FROM positions WHERE status = 'closed' AND pnl IS NOT NULL
    GROUP BY symbol ORDER BY total DESC
  `).all();

  const recentTrades = db.prepare(`
    SELECT symbol, side, pnl, entry_price, exit_price, leverage,
      add_count, reduce_count, t_trade_savings, opened_at, closed_at
    FROM positions WHERE status = 'closed' AND pnl IS NOT NULL
    ORDER BY closed_at DESC LIMIT 50
  `).all();

  const overallStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
      SUM(pnl) as total_pnl,
      AVG(pnl) as avg_pnl,
      MAX(pnl) as best,
      MIN(pnl) as worst
    FROM positions WHERE status = 'closed' AND pnl IS NOT NULL
  `).get();

  return { bySymbol, recentTrades, overallStats };
}

/**
 * Call AI to generate insights from trade data.
 */
async function generateInsights(analysis: any): Promise<{ insights: string[]; recommendations: string[] }> {
  const prompt = `你是一位交易策略分析师。请分析以下交易数据，生成经验教训和策略优化建议。

交易统计:
${JSON.stringify(analysis.overallStats, null, 2)}

按币种统计:
${JSON.stringify(analysis.bySymbol, null, 2)}

最近50笔交易:
${JSON.stringify(analysis.recentTrades.slice(0, 20), null, 2)}

请返回严格JSON格式:
{
  "insights": ["经验教训1", "经验教训2", ...],
  "recommendations": ["策略建议1", "策略建议2", ...]
}`;

  try {
    const messages: AIMessage[] = [
      { role: 'system', content: '你是交易策略分析师，专注于从历史交易数据中提取经验教训。返回严格JSON。' },
      { role: 'user', content: prompt },
    ];

    const response = await aiChat(messages);
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        insights: Array.isArray(parsed.insights) ? parsed.insights : [],
        recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
      };
    }
  } catch (err) {
    logger.warn('策略审查 AI 分析失败', { error: err instanceof Error ? err.message : String(err) });
  }

  return { insights: [], recommendations: [] };
}

/**
 * Persist insights into strategy_memory and strategy_reviews tables.
 */
function persistInsights(
  analysis: any,
  insights: string[],
  recommendations: string[],
) {
  const db = getDb();
  const overall = analysis.overallStats as any;
  const winRate = overall?.total > 0 ? overall.wins / overall.total : 0;

  // Insert strategy review record
  db.prepare(`
    INSERT INTO strategy_reviews (review_type, trade_count_analyzed, win_rate, insights_json, recommendations_json, market_regime)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'periodic',
    overall?.total ?? 0,
    winRate,
    JSON.stringify(insights),
    JSON.stringify(recommendations),
    null,
  );

  // Store each insight as a memory
  for (const insight of insights) {
    insertMemory({
      symbol: '*',
      memoryType: 'insight',
      content: insight,
      outcome: 'neutral',
      relevanceScore: 1.0,
      tags: 'strategy_review',
    });
  }

  for (const rec of recommendations) {
    insertMemory({
      symbol: '*',
      memoryType: 'recommendation',
      content: rec,
      outcome: 'neutral',
      relevanceScore: 1.2,
      tags: 'strategy_review',
    });
  }
}

/**
 * Run a full strategy review cycle.
 */
export async function runStrategyReview() {
  logger.info('开始策略自我审查...');

  const analysis = analyzeTradeHistory();
  const overall = analysis.overallStats as any;

  if (!overall || overall.total < 5) {
    logger.info('交易数据不足，跳过策略审查');
    return;
  }

  const { insights, recommendations } = await generateInsights(analysis);

  if (insights.length > 0 || recommendations.length > 0) {
    persistInsights(analysis, insights, recommendations);
    logger.info(`策略审查完成: ${insights.length} 条洞察, ${recommendations.length} 条建议`);
  } else {
    logger.info('策略审查未生成新洞察');
  }

  // Update tracking
  lastReviewTradeCount = overall.total;
  lastReviewDate = new Date().toISOString().slice(0, 10);
  lastReviewTime = Date.now();
}

/**
 * Lightweight mini-review triggered after 3 consecutive losses.
 * Only analyzes the last 10 trades.
 */
export async function runMiniReview() {
  logger.info('触发轻量策略审查（连续亏损）...');

  const db = getDb();
  const recentTrades = db.prepare(`
    SELECT symbol, side, pnl, entry_price, exit_price, leverage,
      add_count, reduce_count, opened_at, closed_at
    FROM positions WHERE status = 'closed' AND pnl IS NOT NULL
    ORDER BY closed_at DESC LIMIT 10
  `).all();

  if (recentTrades.length < 3) return;

  const analysis = {
    overallStats: {
      total: recentTrades.length,
      wins: (recentTrades as any[]).filter((t: any) => t.pnl > 0).length,
      total_pnl: (recentTrades as any[]).reduce((s: number, t: any) => s + t.pnl, 0),
    },
    recentTrades,
    bySymbol: [],
  };

  const { insights, recommendations } = await generateInsights(analysis);

  if (insights.length > 0 || recommendations.length > 0) {
    // Store as high-relevance memories
    for (const insight of insights) {
      insertMemory({
        symbol: '*',
        memoryType: 'mini_review_insight',
        content: `[紧急复盘] ${insight}`,
        outcome: 'neutral',
        relevanceScore: 1.5,
        tags: 'mini_review,urgent',
      });
    }
    logger.info(`轻量审查完成: ${insights.length} 条洞察`);
  }
}
