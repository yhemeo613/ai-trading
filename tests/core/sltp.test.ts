import { describe, it, expect } from 'vitest';

/**
 * Tests for SL/TP (Stop Loss / Take Profit) trigger logic.
 *
 * The actual checkStopLossAndTakeProfit function is deeply coupled to exchange
 * calls and DB operations, so we extract and test the pure trigger logic here.
 * This mirrors the conditions in loop.ts lines 247-254.
 */

type Side = 'long' | 'short';

interface SltpTriggerInput {
  side: Side;
  markPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
}

/**
 * Pure function that replicates the SL/TP trigger logic from loop.ts.
 * Returns 'sl', 'tp', or null.
 */
function checkSltpTrigger(input: SltpTriggerInput): 'sl' | 'tp' | null {
  const { side, markPrice, stopLoss: sl, takeProfit: tp } = input;

  if (markPrice <= 0) return null;
  if (!sl && !tp) return null;

  if (side === 'long') {
    if (sl && markPrice <= sl) return 'sl';
    if (tp && markPrice >= tp) return 'tp';
  } else {
    // short
    if (sl && markPrice >= sl) return 'sl';
    if (tp && markPrice <= tp) return 'tp';
  }

  return null;
}

describe('SL/TP Trigger Logic', () => {
  describe('Long position - Stop Loss', () => {
    it('should trigger SL when mark price drops below stop loss', () => {
      expect(checkSltpTrigger({
        side: 'long', markPrice: 94000, stopLoss: 95000, takeProfit: 100000,
      })).toBe('sl');
    });

    it('should trigger SL when mark price equals stop loss', () => {
      expect(checkSltpTrigger({
        side: 'long', markPrice: 95000, stopLoss: 95000, takeProfit: 100000,
      })).toBe('sl');
    });

    it('should NOT trigger SL when mark price is above stop loss', () => {
      expect(checkSltpTrigger({
        side: 'long', markPrice: 96000, stopLoss: 95000, takeProfit: 100000,
      })).toBeNull();
    });

    it('should NOT trigger SL when mark price is just above stop loss', () => {
      expect(checkSltpTrigger({
        side: 'long', markPrice: 95000.01, stopLoss: 95000, takeProfit: 100000,
      })).toBeNull();
    });
  });

  describe('Long position - Take Profit', () => {
    it('should trigger TP when mark price rises above take profit', () => {
      expect(checkSltpTrigger({
        side: 'long', markPrice: 101000, stopLoss: 95000, takeProfit: 100000,
      })).toBe('tp');
    });

    it('should trigger TP when mark price equals take profit', () => {
      expect(checkSltpTrigger({
        side: 'long', markPrice: 100000, stopLoss: 95000, takeProfit: 100000,
      })).toBe('tp');
    });

    it('should NOT trigger TP when mark price is below take profit', () => {
      expect(checkSltpTrigger({
        side: 'long', markPrice: 99000, stopLoss: 95000, takeProfit: 100000,
      })).toBeNull();
    });
  });

  describe('Short position - Stop Loss', () => {
    it('should trigger SL when mark price rises above stop loss', () => {
      expect(checkSltpTrigger({
        side: 'short', markPrice: 101000, stopLoss: 100000, takeProfit: 90000,
      })).toBe('sl');
    });

    it('should trigger SL when mark price equals stop loss', () => {
      expect(checkSltpTrigger({
        side: 'short', markPrice: 100000, stopLoss: 100000, takeProfit: 90000,
      })).toBe('sl');
    });

    it('should NOT trigger SL when mark price is below stop loss', () => {
      expect(checkSltpTrigger({
        side: 'short', markPrice: 99000, stopLoss: 100000, takeProfit: 90000,
      })).toBeNull();
    });

    it('should NOT trigger SL when mark price is just below stop loss', () => {
      expect(checkSltpTrigger({
        side: 'short', markPrice: 99999.99, stopLoss: 100000, takeProfit: 90000,
      })).toBeNull();
    });
  });

  describe('Short position - Take Profit', () => {
    it('should trigger TP when mark price drops below take profit', () => {
      expect(checkSltpTrigger({
        side: 'short', markPrice: 89000, stopLoss: 100000, takeProfit: 90000,
      })).toBe('tp');
    });

    it('should trigger TP when mark price equals take profit', () => {
      expect(checkSltpTrigger({
        side: 'short', markPrice: 90000, stopLoss: 100000, takeProfit: 90000,
      })).toBe('tp');
    });

    it('should NOT trigger TP when mark price is above take profit', () => {
      expect(checkSltpTrigger({
        side: 'short', markPrice: 91000, stopLoss: 100000, takeProfit: 90000,
      })).toBeNull();
    });
  });

  describe('Edge cases', () => {
    it('should return null when mark price is 0', () => {
      expect(checkSltpTrigger({
        side: 'long', markPrice: 0, stopLoss: 95000, takeProfit: 100000,
      })).toBeNull();
    });

    it('should return null when mark price is negative', () => {
      expect(checkSltpTrigger({
        side: 'long', markPrice: -1, stopLoss: 95000, takeProfit: 100000,
      })).toBeNull();
    });

    it('should return null when no SL or TP is set', () => {
      expect(checkSltpTrigger({
        side: 'long', markPrice: 96000, stopLoss: null, takeProfit: null,
      })).toBeNull();
    });

    it('should check only SL when TP is null (long)', () => {
      expect(checkSltpTrigger({
        side: 'long', markPrice: 94000, stopLoss: 95000, takeProfit: null,
      })).toBe('sl');

      expect(checkSltpTrigger({
        side: 'long', markPrice: 96000, stopLoss: 95000, takeProfit: null,
      })).toBeNull();
    });

    it('should check only TP when SL is null (long)', () => {
      expect(checkSltpTrigger({
        side: 'long', markPrice: 101000, stopLoss: null, takeProfit: 100000,
      })).toBe('tp');

      expect(checkSltpTrigger({
        side: 'long', markPrice: 99000, stopLoss: null, takeProfit: 100000,
      })).toBeNull();
    });

    it('should check only SL when TP is null (short)', () => {
      expect(checkSltpTrigger({
        side: 'short', markPrice: 101000, stopLoss: 100000, takeProfit: null,
      })).toBe('sl');

      expect(checkSltpTrigger({
        side: 'short', markPrice: 99000, stopLoss: 100000, takeProfit: null,
      })).toBeNull();
    });

    it('should check only TP when SL is null (short)', () => {
      expect(checkSltpTrigger({
        side: 'short', markPrice: 89000, stopLoss: null, takeProfit: 90000,
      })).toBe('tp');

      expect(checkSltpTrigger({
        side: 'short', markPrice: 91000, stopLoss: null, takeProfit: 90000,
      })).toBeNull();
    });

    it('SL takes priority over TP when both would trigger (long - impossible in practice)', () => {
      // If SL >= TP for a long, both could trigger. SL is checked first.
      expect(checkSltpTrigger({
        side: 'long', markPrice: 95000, stopLoss: 95000, takeProfit: 95000,
      })).toBe('sl');
    });

    it('SL takes priority over TP when both would trigger (short - impossible in practice)', () => {
      // If SL <= TP for a short, both could trigger. SL is checked first.
      expect(checkSltpTrigger({
        side: 'short', markPrice: 95000, stopLoss: 95000, takeProfit: 95000,
      })).toBe('sl');
    });

    it('should handle very small price differences correctly', () => {
      // Long: price just barely at SL
      expect(checkSltpTrigger({
        side: 'long', markPrice: 94999.999999, stopLoss: 95000, takeProfit: 100000,
      })).toBe('sl');

      // Short: price just barely at SL
      expect(checkSltpTrigger({
        side: 'short', markPrice: 100000.000001, stopLoss: 100000, takeProfit: 90000,
      })).toBe('sl');
    });
  });
});
