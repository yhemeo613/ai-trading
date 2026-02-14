import { TechnicalIndicators, OrderbookAnalysis, KlineData } from './indicators';

// ─── Types ───────────────────────────────────────────────────────

export interface PriceLevel {
  price: number;
  type: 'support' | 'resistance';
  source: string; // 'swing_low', 'swing_high', 'ema', 'bb', 'orderbook'
  strength: number; // 1-3
}

export interface ChartPattern {
  name: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  description: string;
}

export interface MarketNarrative {
  symbol: string;
  timestamp: number;
  htfBias: string;         // 1h bias
  mtfContext: string;       // 15m context
  ltfTrigger: string;      // 5m/1m trigger
  keyLevels: PriceLevel[];
  patterns: ChartPattern[];
  priceAction: { action: string; description: string };
  previousAction?: string;
  narrativeShift?: string;
  formatted: string;
}

// ─── Narrative Cache ─────────────────────────────────────────────

const narrativeCache: Map<string, MarketNarrative> = new Map();

export function getCachedNarrative(symbol: string): MarketNarrative | undefined {
  return narrativeCache.get(symbol);
}

// ─── Key Level Detection ─────────────────────────────────────────

function parseKlines(raw: any[][]): KlineData[] {
  return raw.map(([ts, o, h, l, c, v]) => ({
    timestamp: ts, open: +o, high: +h, low: +l, close: +c, volume: +v,
  }));
}

export function findKeyLevels(
  klines15m: any[][],
  klines1h: any[][],
  indicators: { [tf: string]: TechnicalIndicators },
  orderbook: OrderbookAnalysis,
  currentPrice: number,
): PriceLevel[] {
  const levels: PriceLevel[] = [];

  // Swing highs/lows from 1h klines
  const hourly = parseKlines(klines1h).slice(-50);
  for (let i = 2; i < hourly.length - 2; i++) {
    const k = hourly[i];
    // Swing low
    if (k.low <= hourly[i - 1].low && k.low <= hourly[i - 2].low &&
        k.low <= hourly[i + 1].low && k.low <= hourly[i + 2].low) {
      levels.push({ price: k.low, type: 'support', source: 'swing_low', strength: 2 });
    }
    // Swing high
    if (k.high >= hourly[i - 1].high && k.high >= hourly[i - 2].high &&
        k.high >= hourly[i + 1].high && k.high >= hourly[i + 2].high) {
      levels.push({ price: k.high, type: 'resistance', source: 'swing_high', strength: 2 });
    }
  }

  // Swing highs/lows from 15m klines
  const m15 = parseKlines(klines15m).slice(-50);
  for (let i = 2; i < m15.length - 2; i++) {
    const k = m15[i];
    if (k.low <= m15[i - 1].low && k.low <= m15[i - 2].low &&
        k.low <= m15[i + 1].low && k.low <= m15[i + 2].low) {
      levels.push({ price: k.low, type: 'support', source: 'swing_low', strength: 1 });
    }
    if (k.high >= m15[i - 1].high && k.high >= m15[i - 2].high &&
        k.high >= m15[i + 1].high && k.high >= m15[i + 2].high) {
      levels.push({ price: k.high, type: 'resistance', source: 'swing_high', strength: 1 });
    }
  }

  // EMA levels from 1h
  const ind1h = indicators['1h'];
  if (ind1h) {
    if (ind1h.ema21) levels.push({
      price: ind1h.ema21, type: currentPrice > ind1h.ema21 ? 'support' : 'resistance',
      source: 'ema', strength: 2,
    });
    if (ind1h.ema50) levels.push({
      price: ind1h.ema50, type: currentPrice > ind1h.ema50 ? 'support' : 'resistance',
      source: 'ema', strength: 3,
    });
  }

  // Bollinger Bands from 15m
  const ind15m = indicators['15m'];
  if (ind15m?.bollingerBands) {
    levels.push({ price: ind15m.bollingerBands.upper, type: 'resistance', source: 'bb', strength: 1 });
    levels.push({ price: ind15m.bollingerBands.lower, type: 'support', source: 'bb', strength: 1 });
  }

  // Orderbook walls
  if (orderbook.bidWall && orderbook.bidWall.amount > 0) {
    levels.push({ price: orderbook.bidWall.price, type: 'support', source: 'orderbook', strength: 2 });
  }
  if (orderbook.askWall && orderbook.askWall.amount > 0) {
    levels.push({ price: orderbook.askWall.price, type: 'resistance', source: 'orderbook', strength: 2 });
  }

  // Merge nearby levels (within 0.3%)
  return mergeLevels(levels, currentPrice);
}

function mergeLevels(levels: PriceLevel[], currentPrice: number): PriceLevel[] {
  if (levels.length === 0) return [];

  const threshold = currentPrice * 0.003; // 0.3%
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const merged: PriceLevel[] = [];

  let current = { ...sorted[0] };
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i].price - current.price) <= threshold) {
      // Merge: keep higher strength, average price
      current.price = (current.price + sorted[i].price) / 2;
      current.strength = Math.max(current.strength, sorted[i].strength);
      if (sorted[i].source !== current.source) {
        current.strength = Math.min(3, current.strength + 1); // Multi-source = stronger
      }
    } else {
      merged.push(current);
      current = { ...sorted[i] };
    }
  }
  merged.push(current);

  // Keep only levels within 5% of current price, sorted by strength
  return merged
    .filter((l) => Math.abs(l.price - currentPrice) / currentPrice < 0.05)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 10);
}

// ─── Pattern Detection ───────────────────────────────────────────

export function detectPatterns(klines15m: any[][], indicators: { [tf: string]: TechnicalIndicators }): ChartPattern[] {
  const patterns: ChartPattern[] = [];
  const k = parseKlines(klines15m).slice(-30);
  if (k.length < 10) return patterns;

  const closes = k.map((c) => c.close);
  const highs = k.map((c) => c.high);
  const lows = k.map((c) => c.low);

  // Double bottom detection
  const recentLows = findLocalExtremes(lows, 'min', 5);
  if (recentLows.length >= 2) {
    const [low1, low2] = recentLows.slice(-2);
    const diff = Math.abs(low1.value - low2.value) / low1.value;
    if (diff < 0.005 && low2.index > low1.index + 3) {
      patterns.push({
        name: '双底',
        direction: 'bullish',
        confidence: diff < 0.002 ? 0.8 : 0.6,
        description: `在 ${low1.value.toFixed(2)} 附近形成双底`,
      });
    }
  }

  // Double top detection
  const recentHighs = findLocalExtremes(highs, 'max', 5);
  if (recentHighs.length >= 2) {
    const [high1, high2] = recentHighs.slice(-2);
    const diff = Math.abs(high1.value - high2.value) / high1.value;
    if (diff < 0.005 && high2.index > high1.index + 3) {
      patterns.push({
        name: '双顶',
        direction: 'bearish',
        confidence: diff < 0.002 ? 0.8 : 0.6,
        description: `在 ${high1.value.toFixed(2)} 附近形成双顶`,
      });
    }
  }

  // Converging triangle (lower highs + higher lows)
  if (recentHighs.length >= 2 && recentLows.length >= 2) {
    const h1 = recentHighs[recentHighs.length - 2];
    const h2 = recentHighs[recentHighs.length - 1];
    const l1 = recentLows[recentLows.length - 2];
    const l2 = recentLows[recentLows.length - 1];
    if (h2.value < h1.value && l2.value > l1.value) {
      patterns.push({
        name: '收敛三角形',
        direction: 'neutral',
        confidence: 0.6,
        description: `高点递降低点递升，即将突破`,
      });
    }
  }

  // Bull/Bear flag: strong move followed by tight consolidation
  if (k.length >= 15) {
    const movePhase = k.slice(-15, -5);
    const flagPhase = k.slice(-5);
    const moveRange = Math.max(...movePhase.map((c) => c.high)) - Math.min(...movePhase.map((c) => c.low));
    const flagRange = Math.max(...flagPhase.map((c) => c.high)) - Math.min(...flagPhase.map((c) => c.low));
    const moveDir = movePhase[movePhase.length - 1].close - movePhase[0].close;

    if (flagRange < moveRange * 0.3 && Math.abs(moveDir) > flagRange * 2) {
      patterns.push({
        name: moveDir > 0 ? '牛旗' : '熊旗',
        direction: moveDir > 0 ? 'bullish' : 'bearish',
        confidence: 0.65,
        description: `${moveDir > 0 ? '上涨' : '下跌'}后窄幅整理，可能延续`,
      });
    }
  }

  // Engulfing candle (last 2 candles)
  if (k.length >= 2) {
    const prev = k[k.length - 2];
    const curr = k[k.length - 1];
    const prevBody = Math.abs(prev.close - prev.open);
    const currBody = Math.abs(curr.close - curr.open);

    if (currBody > prevBody * 1.5) {
      if (prev.close < prev.open && curr.close > curr.open && curr.close > prev.open && curr.open < prev.close) {
        patterns.push({ name: '看涨吞没', direction: 'bullish', confidence: 0.7, description: '出现看涨吞没形态' });
      } else if (prev.close > prev.open && curr.close < curr.open && curr.close < prev.open && curr.open > prev.close) {
        patterns.push({ name: '看跌吞没', direction: 'bearish', confidence: 0.7, description: '出现看跌吞没形态' });
      }
    }
  }

  return patterns;
}

function findLocalExtremes(values: number[], type: 'min' | 'max', window: number): { index: number; value: number }[] {
  const results: { index: number; value: number }[] = [];
  for (let i = window; i < values.length - window; i++) {
    const slice = values.slice(i - window, i + window + 1);
    const extreme = type === 'min' ? Math.min(...slice) : Math.max(...slice);
    if (values[i] === extreme) {
      results.push({ index: i, value: values[i] });
    }
  }
  return results;
}

// ─── Price Action Classification ─────────────────────────────────

export function classifyPriceAction(
  currentPrice: number,
  keyLevels: PriceLevel[],
  indicators: { [tf: string]: TechnicalIndicators },
): { action: string; description: string } {
  const ind15m = indicators['15m'];
  const ind1h = indicators['1h'];

  // Find nearest support and resistance
  const supports = keyLevels.filter((l) => l.type === 'support' && l.price < currentPrice);
  const resistances = keyLevels.filter((l) => l.type === 'resistance' && l.price > currentPrice);
  const nearestSupport = supports.length > 0 ? supports.reduce((a, b) => a.price > b.price ? a : b) : null;
  const nearestResistance = resistances.length > 0 ? resistances.reduce((a, b) => a.price < b.price ? a : b) : null;

  // Distance to nearest levels
  const distToSupport = nearestSupport ? (currentPrice - nearestSupport.price) / currentPrice : Infinity;
  const distToResistance = nearestResistance ? (nearestResistance.price - currentPrice) / currentPrice : Infinity;

  // Strong trend check
  const strongTrend = ind1h && ind1h.adx !== null && ind1h.adx > 30;
  const bullTrend = ind1h?.emaTrend === '多头排列';
  const bearTrend = ind1h?.emaTrend === '空头排列';

  if (strongTrend && bullTrend) {
    return { action: 'strong_uptrend', description: '强势上升趋势中' };
  }
  if (strongTrend && bearTrend) {
    return { action: 'strong_downtrend', description: '强势下降趋势中' };
  }

  // Testing support
  if (distToSupport < 0.005) {
    const rsiOversold = ind15m?.rsi14 !== null && (ind15m?.rsi14 ?? 50) < 35;
    return {
      action: 'testing_support',
      description: `测试支撑位 ${nearestSupport!.price.toFixed(2)}${rsiOversold ? '，RSI超卖' : ''}`,
    };
  }

  // Testing resistance
  if (distToResistance < 0.005) {
    const rsiOverbought = ind15m?.rsi14 !== null && (ind15m?.rsi14 ?? 50) > 65;
    return {
      action: 'testing_resistance',
      description: `测试阻力位 ${nearestResistance!.price.toFixed(2)}${rsiOverbought ? '，RSI超买' : ''}`,
    };
  }

  // Consolidation
  if (ind15m && ind15m.adx !== null && ind15m.adx < 20 && ind15m.atrPercent !== null && ind15m.atrPercent < 0.8) {
    return { action: 'consolidating', description: '窄幅盘整中，等待方向选择' };
  }

  // Pullback in uptrend
  if (bullTrend && ind15m?.rsi14 !== null && (ind15m?.rsi14 ?? 50) < 45) {
    return { action: 'pullback_in_uptrend', description: '上升趋势中的回调' };
  }

  // Bounce in downtrend
  if (bearTrend && ind15m?.rsi14 !== null && (ind15m?.rsi14 ?? 50) > 55) {
    return { action: 'bounce_in_downtrend', description: '下降趋势中的反弹' };
  }

  // Default
  return { action: 'neutral', description: '无明显方向，观望中' };
}

// ─── HTF/MTF/LTF Bias ───────────────────────────────────────────

function describeHTFBias(ind: TechnicalIndicators | undefined): string {
  if (!ind) return '数据不足';
  const parts: string[] = [];

  if (ind.emaTrend === '多头排列') parts.push('EMA多头排列');
  else if (ind.emaTrend === '空头排列') parts.push('EMA空头排列');
  else parts.push('EMA交织');

  if (ind.adx !== null) {
    parts.push(ind.adx > 25 ? `ADX=${ind.adx.toFixed(0)}(趋势强)` : `ADX=${ind.adx.toFixed(0)}(趋势弱)`);
  }
  if (ind.rsi14 !== null) parts.push(`RSI=${ind.rsi14.toFixed(0)}`);
  if (ind.macdSignal !== '中性') parts.push(`MACD${ind.macdSignal}`);

  return parts.join('，');
}

function describeMTFContext(ind: TechnicalIndicators | undefined, priceAction: { action: string; description: string }): string {
  if (!ind) return '数据不足';
  const parts: string[] = [priceAction.description];

  if (ind.bollingerBands) {
    const pb = ind.bollingerBands.percentB;
    if (pb > 0.8) parts.push('接近布林上轨');
    else if (pb < 0.2) parts.push('接近布林下轨');
  }
  if (ind.stochSignal !== '中性') parts.push(`随机指标${ind.stochSignal}`);

  return parts.join('，');
}

function describeLTFTrigger(ind5m: TechnicalIndicators | undefined, ind1m: TechnicalIndicators | undefined): string {
  const parts: string[] = [];
  const primary = ind5m || ind1m;
  if (!primary) return '无短周期信号';

  if (primary.rsiSignal === '超卖') parts.push('RSI超卖');
  else if (primary.rsiSignal === '超买') parts.push('RSI超买');

  if (primary.macdSignal === '金叉') parts.push('MACD金叉');
  else if (primary.macdSignal === '死叉') parts.push('MACD死叉');

  if (primary.volumeRatio !== null && primary.volumeRatio > 1.5) parts.push('放量');

  if (primary.psarTrend === '多') parts.push('PSAR看多');
  else parts.push('PSAR看空');

  return parts.length > 0 ? parts.join('，') : '无明显触发信号';
}

// ─── Main Entry Point ────────────────────────────────────────────

export function buildNarrative(
  symbol: string,
  klines: { [tf: string]: any[][] },
  indicators: { [tf: string]: TechnicalIndicators },
  orderbook: OrderbookAnalysis,
  currentPrice: number,
): MarketNarrative {
  const previous = narrativeCache.get(symbol);

  // Key levels
  const keyLevels = findKeyLevels(
    klines['15m'] ?? [], klines['1h'] ?? [],
    indicators, orderbook, currentPrice,
  );

  // Patterns
  const patterns = detectPatterns(klines['15m'] ?? [], indicators);

  // Price action
  const priceAction = classifyPriceAction(currentPrice, keyLevels, indicators);

  // Multi-timeframe bias
  const htfBias = describeHTFBias(indicators['1h']);
  const mtfContext = describeMTFContext(indicators['15m'], priceAction);
  const ltfTrigger = describeLTFTrigger(indicators['5m'], indicators['1m']);

  // Detect narrative shift
  let narrativeShift: string | undefined;
  if (previous) {
    if (previous.priceAction.action !== priceAction.action) {
      narrativeShift = `从"${previous.priceAction.description}"变为"${priceAction.description}"`;
    }
  }

  // Format for prompt
  const formatted = formatNarrative(symbol, htfBias, mtfContext, ltfTrigger, keyLevels, patterns, priceAction, narrativeShift);

  const narrative: MarketNarrative = {
    symbol,
    timestamp: Date.now(),
    htfBias,
    mtfContext,
    ltfTrigger,
    keyLevels,
    patterns,
    priceAction,
    previousAction: previous?.priceAction.action,
    narrativeShift,
    formatted,
  };

  narrativeCache.set(symbol, narrative);
  return narrative;
}

function formatNarrative(
  symbol: string,
  htfBias: string,
  mtfContext: string,
  ltfTrigger: string,
  keyLevels: PriceLevel[],
  patterns: ChartPattern[],
  priceAction: { action: string; description: string },
  narrativeShift?: string,
): string {
  const lines: string[] = ['═══════════════════════════════════════', `【${symbol} 市场叙事】`];

  lines.push(`\n[大周期(1h)] ${htfBias}`);
  lines.push(`[中周期(15m)] ${mtfContext}`);
  lines.push(`[小周期(5m/1m)] ${ltfTrigger}`);

  if (narrativeShift) {
    lines.push(`\n⚡ 叙事变化: ${narrativeShift}`);
  }

  // Key levels
  const supports = keyLevels.filter((l) => l.type === 'support').slice(0, 3);
  const resistances = keyLevels.filter((l) => l.type === 'resistance').slice(0, 3);
  lines.push('\n[关键价位]');
  if (resistances.length > 0) {
    lines.push(`  阻力: ${resistances.map((l) => `${l.price.toFixed(2)}(${l.source},强度${l.strength})`).join(', ')}`);
  }
  if (supports.length > 0) {
    lines.push(`  支撑: ${supports.map((l) => `${l.price.toFixed(2)}(${l.source},强度${l.strength})`).join(', ')}`);
  }

  // Patterns
  if (patterns.length > 0) {
    lines.push('\n[图表形态]');
    for (const p of patterns) {
      lines.push(`  ${p.name} (${p.direction}, 置信度${(p.confidence * 100).toFixed(0)}%): ${p.description}`);
    }
  }

  lines.push(`\n[价格行为] ${priceAction.description}`);
  lines.push('═══════════════════════════════════════');

  return lines.join('\n');
}
