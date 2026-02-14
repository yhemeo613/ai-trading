import { BaseRole } from './base-role';
import type { RoundtableSessionInput } from '../types';
import { formatSentiment } from '../../analysis/indicators';

export class SentimentAnalyst extends BaseRole {
  readonly roleName = '情绪分析师';
  readonly roleId = 'sentiment-analyst';

  protected buildSystemPrompt(): string {
    return `你是交易圆桌会议中的情绪分析师。专长：市场情绪判读、资金费率分析、群体行为识别。

## 职责
评估情绪状态，识别拥挤交易和极端情绪，预警反转风险。

## 拥挤预警
资金费率>0.05%或<-0.05%、情绪极端(>80/<20)、成交量异常、多空比失衡

## 决策原则
极端情绪预示反转，情绪与价格背离是重要信号

返回JSON:
{"role":"sentiment-analyst","stance":"LONG|SHORT|HOLD|CLOSE|ADJUST|ADD|REDUCE","confidence":0.0-1.0,"reasoning":"中文","keyPoints":["论点"]}`;
  }

  protected buildRound1Prompt(input: RoundtableSessionInput): string {
    const { market, account, strategy } = input;
    const currentPos = account.positions.find((p: any) => p.symbol === market.symbol);

    const lines = [
      `交易对: ${market.symbol} | 价格: ${market.currentPrice}`,
      '',
    ];

    if (currentPos) {
      lines.push(`【持仓】${currentPos.side === 'long' ? '多' : '空'} ${currentPos.contracts}张 @${currentPos.entryPrice}`);
      if (strategy.positionThesis) lines.push(`  论点: ${strategy.positionThesis}`);
      lines.push(`  评估情绪是否仍支持该方向`);
      lines.push('');
    }

    const ind15m = market.indicators['15m'];
    lines.push(
      formatSentiment(market.sentiment),
      '',
      `资金费率: ${market.fundingRate !== null ? (market.fundingRate * 100).toFixed(4) + '%' : '暂无'}`,
      `24h涨跌: ${market.ticker.percentage?.toFixed(2)}% | 成交量: ${market.ticker.quoteVolume?.toFixed(0)}U | 成交额: ${market.ticker.volume?.toFixed(0)}`,
      '',
      `成交量指标: OBV=${ind15m?.obv ?? '?'} MFI=${ind15m?.mfi ?? '?'} 量比=${ind15m?.volumeRatio ?? '?'}`,
      `订单簿: 买卖比=${market.orderbook?.bidAskRatio?.toFixed(2) ?? '?'} ${market.orderbook?.imbalance ?? '?'}`,
      '',
      `请从情绪角度分析，是否存在拥挤交易或极端情绪，给出方向判断。`,
    );
    return lines.join('\n');
  }
}
