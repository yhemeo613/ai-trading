import {
  RSI, MACD, BollingerBands, EMA, SMA, ATR, ADX,
  Stochastic, OBV, VWAP, CCI, WilliamsR, MFI,
  IchimokuCloud, PSAR,
} from 'technicalindicators';

// ─── Types ───────────────────────────────────────────────────────

export interface KlineData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TechnicalIndicators {
  // 趋势指标
  ema7: number | null;
  ema21: number | null;
  ema50: number | null;
  sma20: number | null;
  emaTrend: string; // '多头排列' | '空头排列' | '交织'
  psar: number | null;
  psarTrend: string; // '多' | '空'

  // 动量指标
  rsi14: number | null;
  rsiSignal: string; // '超买' | '超卖' | '中性'
  macd: { macd: number; signal: number; histogram: number } | null;
  macdSignal: string; // '金叉' | '死叉' | '中性'
  stochK: number | null;
  stochD: number | null;
  stochSignal: string;
  williamsR: number | null;
  cci: number | null;

  // 波动率指标
  bollingerBands: { upper: number; middle: number; lower: number; width: number; percentB: number } | null;
  atr14: number | null;
  atrPercent: number | null; // ATR占价格百分比

  // 趋势强度
  adx: number | null;
  plusDI: number | null;
  minusDI: number | null;
  adxSignal: string; // '强趋势' | '弱趋势' | '无趋势'

  // 成交量指标
  obv: number | null;
  obvTrend: string; // '放量' | '缩量' | '平稳'
  mfi: number | null;
  volumeRatio: number | null; // 最近5根成交量 / 前20根平均成交量
  vwap: number | null;

  // 一目均衡表
  ichimoku: {
    tenkan: number | null;
    kijun: number | null;
    senkouA: number | null;
    senkouB: number | null;
    signal: string;
  } | null;
}

export interface OrderbookAnalysis {
  bidTotal: number;
  askTotal: number;
  bidAskRatio: number; // >1 买方强, <1 卖方强
  imbalance: string; // '买方主导' | '卖方主导' | '均衡'
  bidWall: { price: number; amount: number } | null; // 最大买单
  askWall: { price: number; amount: number } | null; // 最大卖单
  spreadPercent: number;
  microPressure: number; // 前3档买卖比
}

export interface MarketSentiment {
  fundingRateSignal: string; // '极度贪婪' | '贪婪' | '中性' | '恐惧' | '极度恐惧'
  volumeMomentum: string; // '放量上涨' | '放量下跌' | '缩量上涨' | '缩量下跌' | '平稳'
  pricePosition: string; // 价格在布林带中的位置描述
  overallBias: string; // '强多' | '偏多' | '中性' | '偏空' | '强空'
  score: number; // -100 到 100 的综合情绪分
}

export interface FullAnalysis {
  indicators: { [timeframe: string]: TechnicalIndicators };
  orderbook: OrderbookAnalysis;
  sentiment: MarketSentiment;
}

// ─── Helpers ─────────────────────────────────────────────────────

function parseKlines(raw: any[][]): KlineData[] {
  return raw.map(([ts, o, h, l, c, v]) => ({
    timestamp: ts, open: +o, high: +h, low: +l, close: +c, volume: +v,
  }));
}

function last<T>(arr: T[]): T | null {
  return arr.length > 0 ? arr[arr.length - 1] : null;
}

function lastN<T>(arr: T[], n: number): T[] {
  return arr.slice(-n);
}

// ─── Indicator Calculation ───────────────────────────────────────

export function calcIndicators(rawKlines: any[][]): TechnicalIndicators {
  const klines = parseKlines(rawKlines);
  if (klines.length < 10) {
    return emptyIndicators();
  }

  const closes = klines.map((k) => k.close);
  const highs = klines.map((k) => k.high);
  const lows = klines.map((k) => k.low);
  const volumes = klines.map((k) => k.volume);
  const currentPrice = closes[closes.length - 1];

  // ── 趋势指标 ──
  const ema7Arr = EMA.calculate({ period: 7, values: closes });
  const ema21Arr = EMA.calculate({ period: 21, values: closes });
  const ema50Arr = EMA.calculate({ period: Math.min(50, Math.floor(closes.length * 0.8)), values: closes });
  const sma20Arr = SMA.calculate({ period: 20, values: closes });

  const ema7Val = last(ema7Arr);
  const ema21Val = last(ema21Arr);
  const ema50Val = last(ema50Arr);

  let emaTrend = '交织';
  if (ema7Val && ema21Val && ema50Val) {
    if (ema7Val > ema21Val && ema21Val > ema50Val) emaTrend = '多头排列';
    else if (ema7Val < ema21Val && ema21Val < ema50Val) emaTrend = '空头排列';
  }

  // PSAR
  let psarVal: number | null = null;
  let psarTrend = '多';
  try {
    const psarArr = PSAR.calculate({ high: highs, low: lows, step: 0.02, max: 0.2 });
    psarVal = last(psarArr);
    if (psarVal !== null) {
      psarTrend = currentPrice > psarVal ? '多' : '空';
    }
  } catch { /* not enough data */ }

  // ── 动量指标 ──
  const rsiArr = RSI.calculate({ period: 14, values: closes });
  const rsi14 = last(rsiArr);
  let rsiSignal = '中性';
  if (rsi14 !== null) {
    if (rsi14 > 70) rsiSignal = '超买';
    else if (rsi14 < 30) rsiSignal = '超卖';
  }

  const macdArr = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const macdLast = last(macdArr);
  let macdResult: TechnicalIndicators['macd'] = null;
  let macdSignal = '中性';
  if (macdLast && macdLast.MACD !== undefined && macdLast.signal !== undefined && macdLast.histogram !== undefined) {
    macdResult = { macd: macdLast.MACD, signal: macdLast.signal, histogram: macdLast.histogram };
    const prev = macdArr.length >= 2 ? macdArr[macdArr.length - 2] : null;
    if (prev && prev.histogram !== undefined && macdLast.histogram !== undefined) {
      if (prev.histogram < 0 && macdLast.histogram >= 0) macdSignal = '金叉';
      else if (prev.histogram > 0 && macdLast.histogram <= 0) macdSignal = '死叉';
    }
  }

  const stochArr = Stochastic.calculate({ high: highs, low: lows, close: closes, period: 14, signalPeriod: 3 });
  const stochLast = last(stochArr);
  let stochK: number | null = null;
  let stochD: number | null = null;
  let stochSignal = '中性';
  if (stochLast) {
    stochK = stochLast.k;
    stochD = stochLast.d;
    if (stochK > 80 && stochD > 80) stochSignal = '超买';
    else if (stochK < 20 && stochD < 20) stochSignal = '超卖';
    else if (stochK > stochD) stochSignal = '看多';
    else stochSignal = '看空';
  }

  const wrArr = WilliamsR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const williamsR = last(wrArr);

  const cciArr = CCI.calculate({ high: highs, low: lows, close: closes, period: 20 });
  const cci = last(cciArr);

  // ── 波动率指标 ──
  const bbArr = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
  const bbLast = last(bbArr);
  let bollingerBands: TechnicalIndicators['bollingerBands'] = null;
  if (bbLast) {
    const width = (bbLast.upper - bbLast.lower) / bbLast.middle;
    const percentB = (currentPrice - bbLast.lower) / (bbLast.upper - bbLast.lower);
    bollingerBands = {
      upper: bbLast.upper,
      middle: bbLast.middle,
      lower: bbLast.lower,
      width,
      percentB,
    };
  }

  const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atr14 = last(atrArr);
  const atrPercent = atr14 !== null ? (atr14 / currentPrice) * 100 : null;

  // ── 趋势强度 ──
  let adxVal: number | null = null;
  let plusDI: number | null = null;
  let minusDI: number | null = null;
  let adxSignal = '无趋势';
  try {
    const adxArr = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const adxLast = last(adxArr);
    if (adxLast) {
      adxVal = adxLast.adx;
      plusDI = adxLast.pdi;
      minusDI = adxLast.mdi;
      if (adxVal > 40) adxSignal = '强趋势';
      else if (adxVal > 20) adxSignal = '弱趋势';
    }
  } catch { /* not enough data */ }

  // ── 成交量指标 ──
  const obvArr = OBV.calculate({ close: closes, volume: volumes });
  const obvVal = last(obvArr);
  const obvRecent = lastN(obvArr, 5);
  let obvTrend = '平稳';
  if (obvRecent.length >= 5) {
    const obvChange = obvRecent[obvRecent.length - 1] - obvRecent[0];
    if (obvChange > 0) obvTrend = '放量';
    else if (obvChange < 0) obvTrend = '缩量';
  }

  let mfi: number | null = null;
  try {
    const mfiArr = MFI.calculate({ high: highs, low: lows, close: closes, volume: volumes, period: 14 });
    mfi = last(mfiArr);
  } catch { /* not enough data */ }

  // 成交量比率
  let volumeRatio: number | null = null;
  if (volumes.length >= 25) {
    const recent5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const prev20 = volumes.slice(-25, -5).reduce((a, b) => a + b, 0) / 20;
    volumeRatio = prev20 > 0 ? recent5 / prev20 : null;
  }

  // VWAP
  let vwap: number | null = null;
  try {
    const vwapArr = VWAP.calculate({ high: highs, low: lows, close: closes, volume: volumes });
    vwap = last(vwapArr);
  } catch { /* not enough data */ }

  // ── 一目均衡表 ──
  let ichimoku: TechnicalIndicators['ichimoku'] = null;
  try {
    const ichArr = IchimokuCloud.calculate({
      high: highs, low: lows,
      conversionPeriod: 9, basePeriod: 26, spanPeriod: 52, displacement: 26,
    });
    const ichLast = last(ichArr);
    if (ichLast) {
      let signal = '中性';
      if (ichLast.conversion > ichLast.base && currentPrice > (ichLast.spanA ?? 0)) signal = '看多';
      else if (ichLast.conversion < ichLast.base && currentPrice < (ichLast.spanA ?? Infinity)) signal = '看空';
      ichimoku = {
        tenkan: ichLast.conversion,
        kijun: ichLast.base,
        senkouA: ichLast.spanA ?? null,
        senkouB: ichLast.spanB ?? null,
        signal,
      };
    }
  } catch { /* not enough data for ichimoku */ }

  return {
    ema7: ema7Val ?? null, ema21: ema21Val ?? null, ema50: ema50Val ?? null,
    sma20: last(sma20Arr) ?? null, emaTrend, psar: psarVal, psarTrend,
    rsi14, rsiSignal, macd: macdResult, macdSignal,
    stochK, stochD, stochSignal, williamsR: williamsR ?? null, cci: cci ?? null,
    bollingerBands, atr14: atr14 ?? null, atrPercent,
    adx: adxVal, plusDI, minusDI, adxSignal,
    obv: obvVal ?? null, obvTrend, mfi, volumeRatio, vwap: vwap ?? null,
    ichimoku,
  };
}

// ─── Orderbook Analysis ──────────────────────────────────────────

export function analyzeOrderbook(
  bids: [number, number][],
  asks: [number, number][]
): OrderbookAnalysis {
  const bidTotal = bids.reduce((s, [, q]) => s + q, 0);
  const askTotal = asks.reduce((s, [, q]) => s + q, 0);
  const bidAskRatio = askTotal > 0 ? bidTotal / askTotal : 1;

  let imbalance = '均衡';
  if (bidAskRatio > 1.5) imbalance = '买方主导';
  else if (bidAskRatio < 0.67) imbalance = '卖方主导';

  const bidWall = bids.length > 0
    ? bids.reduce((max, [p, q]) => q > max.amount ? { price: p, amount: q } : max, { price: 0, amount: 0 })
    : null;
  const askWall = asks.length > 0
    ? asks.reduce((max, [p, q]) => q > max.amount ? { price: p, amount: q } : max, { price: 0, amount: 0 })
    : null;

  const spreadPercent = bids.length > 0 && asks.length > 0
    ? ((asks[0][0] - bids[0][0]) / bids[0][0]) * 100
    : 0;

  // 前3档微观压力
  const top3Bid = bids.slice(0, 3).reduce((s, [, q]) => s + q, 0);
  const top3Ask = asks.slice(0, 3).reduce((s, [, q]) => s + q, 0);
  const microPressure = top3Ask > 0 ? top3Bid / top3Ask : 1;

  return { bidTotal, askTotal, bidAskRatio, imbalance, bidWall, askWall, spreadPercent, microPressure };
}

// ─── Market Sentiment ────────────────────────────────────────────

export function calcSentiment(
  indicators: { [tf: string]: TechnicalIndicators },
  orderbook: OrderbookAnalysis,
  fundingRate: number | null,
  priceChange24h: number
): MarketSentiment {
  let score = 0;

  // 资金费率信号
  let fundingRateSignal = '中性';
  if (fundingRate !== null) {
    if (fundingRate > 0.001) { fundingRateSignal = '极度贪婪'; score -= 10; }
    else if (fundingRate > 0.0005) { fundingRateSignal = '贪婪'; score -= 5; }
    else if (fundingRate < -0.001) { fundingRateSignal = '极度恐惧'; score += 10; }
    else if (fundingRate < -0.0005) { fundingRateSignal = '恐惧'; score += 5; }
  }

  // 各周期指标综合评分
  for (const tf of Object.keys(indicators)) {
    const ind = indicators[tf];
    const weight = tf === '1m' ? 1 : tf === '5m' ? 2 : tf === '15m' ? 3 : 1;

    // RSI
    if (ind.rsi14 !== null) {
      if (ind.rsi14 > 70) score -= 3 * weight;
      else if (ind.rsi14 > 60) score += 1 * weight;
      else if (ind.rsi14 < 30) score += 3 * weight;
      else if (ind.rsi14 < 40) score -= 1 * weight;
    }

    // MACD
    if (ind.macdSignal === '金叉') score += 3 * weight;
    else if (ind.macdSignal === '死叉') score -= 3 * weight;

    // EMA排列
    if (ind.emaTrend === '多头排列') score += 2 * weight;
    else if (ind.emaTrend === '空头排列') score -= 2 * weight;

    // Stochastic
    if (ind.stochSignal === '超卖') score += 2 * weight;
    else if (ind.stochSignal === '超买') score -= 2 * weight;

    // ADX趋势强度加权
    if (ind.adxSignal === '强趋势' && ind.plusDI !== null && ind.minusDI !== null) {
      if (ind.plusDI > ind.minusDI) score += 3 * weight;
      else score -= 3 * weight;
    }

    // PSAR
    if (ind.psarTrend === '多') score += 1 * weight;
    else score -= 1 * weight;
  }

  // 订单簿
  if (orderbook.bidAskRatio > 1.5) score += 5;
  else if (orderbook.bidAskRatio < 0.67) score -= 5;
  if (orderbook.microPressure > 2) score += 3;
  else if (orderbook.microPressure < 0.5) score -= 3;

  // 24h涨跌
  if (priceChange24h > 5) score += 3;
  else if (priceChange24h < -5) score -= 3;

  // 成交量动量
  const mainTf = indicators['5m'] || indicators['15m'] || Object.values(indicators)[0];
  let volumeMomentum = '平稳';
  if (mainTf) {
    const volUp = mainTf.volumeRatio !== null && mainTf.volumeRatio > 1.5;
    const priceUp = priceChange24h > 0;
    if (volUp && priceUp) volumeMomentum = '放量上涨';
    else if (volUp && !priceUp) volumeMomentum = '放量下跌';
    else if (!volUp && priceUp) volumeMomentum = '缩量上涨';
    else if (!volUp && !priceUp) volumeMomentum = '缩量下跌';
  }

  // 价格在布林带位置
  let pricePosition = '中轨附近';
  if (mainTf?.bollingerBands) {
    const pb = mainTf.bollingerBands.percentB;
    if (pb > 1) pricePosition = '突破上轨';
    else if (pb > 0.8) pricePosition = '接近上轨';
    else if (pb < 0) pricePosition = '跌破下轨';
    else if (pb < 0.2) pricePosition = '接近下轨';
  }

  // 限制分数范围
  score = Math.max(-100, Math.min(100, score));

  let overallBias = '中性';
  if (score > 30) overallBias = '强多';
  else if (score > 10) overallBias = '偏多';
  else if (score < -30) overallBias = '强空';
  else if (score < -10) overallBias = '偏空';

  return { fundingRateSignal, volumeMomentum, pricePosition, overallBias, score };
}

// ─── Format for AI Prompt ────────────────────────────────────────

export function formatIndicators(tf: string, ind: TechnicalIndicators): string {
  const lines: string[] = [`【${tf} 技术指标】`];

  // 趋势
  lines.push(`  趋势: EMA排列=${ind.emaTrend}, EMA7=${n(ind.ema7)} EMA21=${n(ind.ema21)} EMA50=${n(ind.ema50)} SMA20=${n(ind.sma20)}`);
  lines.push(`  PSAR=${n(ind.psar)} (${ind.psarTrend})`);

  // 动量
  lines.push(`  RSI(14)=${n(ind.rsi14)} [${ind.rsiSignal}]`);
  if (ind.macd) {
    lines.push(`  MACD=${n(ind.macd.macd)} Signal=${n(ind.macd.signal)} Hist=${n(ind.macd.histogram)} [${ind.macdSignal}]`);
  }
  lines.push(`  Stoch K=${n(ind.stochK)} D=${n(ind.stochD)} [${ind.stochSignal}]`);
  lines.push(`  WilliamsR=${n(ind.williamsR)}, CCI=${n(ind.cci)}`);

  // 波动率
  if (ind.bollingerBands) {
    const bb = ind.bollingerBands;
    lines.push(`  布林带: 上=${n(bb.upper)} 中=${n(bb.middle)} 下=${n(bb.lower)} 宽度=${(bb.width * 100).toFixed(2)}% %B=${bb.percentB.toFixed(2)}`);
  }
  lines.push(`  ATR(14)=${n(ind.atr14)} (${n(ind.atrPercent)}%)`);

  // 趋势强度
  lines.push(`  ADX=${n(ind.adx)} +DI=${n(ind.plusDI)} -DI=${n(ind.minusDI)} [${ind.adxSignal}]`);

  // 成交量
  lines.push(`  OBV趋势=${ind.obvTrend}, MFI=${n(ind.mfi)}, 量比=${n(ind.volumeRatio)}, VWAP=${n(ind.vwap)}`);

  // 一目均衡表
  if (ind.ichimoku) {
    lines.push(`  一目均衡: 转换=${n(ind.ichimoku.tenkan)} 基准=${n(ind.ichimoku.kijun)} 先行A=${n(ind.ichimoku.senkouA)} 先行B=${n(ind.ichimoku.senkouB)} [${ind.ichimoku.signal}]`);
  }

  return lines.join('\n');
}

export function formatOrderbook(ob: OrderbookAnalysis): string {
  const lines = ['【订单簿深度分析】'];
  lines.push(`  买盘总量: ${ob.bidTotal.toFixed(2)}, 卖盘总量: ${ob.askTotal.toFixed(2)}`);
  lines.push(`  买卖比: ${ob.bidAskRatio.toFixed(2)} [${ob.imbalance}]`);
  lines.push(`  前3档微观压力: ${ob.microPressure.toFixed(2)}`);
  lines.push(`  价差: ${ob.spreadPercent.toFixed(4)}%`);
  if (ob.bidWall) lines.push(`  买方大单: ${ob.bidWall.price} @ ${ob.bidWall.amount.toFixed(2)}`);
  if (ob.askWall) lines.push(`  卖方大单: ${ob.askWall.price} @ ${ob.askWall.amount.toFixed(2)}`);
  return lines.join('\n');
}

export function formatSentiment(s: MarketSentiment): string {
  const lines = ['【市场情绪综合】'];
  lines.push(`  情绪分数: ${s.score} (${s.overallBias})`);
  lines.push(`  资金费率信号: ${s.fundingRateSignal}`);
  lines.push(`  成交量动量: ${s.volumeMomentum}`);
  lines.push(`  价格位置: ${s.pricePosition}`);
  return lines.join('\n');
}

// ─── Helpers ─────────────────────────────────────────────────────

function n(val: number | null | undefined): string {
  if (val === null || val === undefined) return 'N/A';
  return Number.isInteger(val) ? val.toString() : val.toFixed(4);
}

function emptyIndicators(): TechnicalIndicators {
  return {
    ema7: null, ema21: null, ema50: null, sma20: null, emaTrend: '交织',
    psar: null, psarTrend: '多',
    rsi14: null, rsiSignal: '中性', macd: null, macdSignal: '中性',
    stochK: null, stochD: null, stochSignal: '中性', williamsR: null, cci: null,
    bollingerBands: null, atr14: null, atrPercent: null,
    adx: null, plusDI: null, minusDI: null, adxSignal: '无趋势',
    obv: null, obvTrend: '平稳', mfi: null, volumeRatio: null, vwap: null,
    ichimoku: null,
  };
}
