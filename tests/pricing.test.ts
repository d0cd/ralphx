import { describe, it, expect } from 'vitest';
import { estimateCost, getModelPricing } from '../src/cost/pricing.js';

describe('Cost Pricing', () => {
  describe('getModelPricing', () => {
    it('returns pricing for known model', () => {
      const pricing = getModelPricing('claude-sonnet-4-6');
      expect(pricing).toBeDefined();
      expect(pricing!.inputPerMToken).toBe(3.0);
      expect(pricing!.outputPerMToken).toBe(15.0);
    });

    it('returns null for unknown model', () => {
      expect(getModelPricing('gpt-99')).toBeNull();
    });

    it('returns pricing for all known models', () => {
      for (const model of ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5', 'claude-sonnet-4-5']) {
        expect(getModelPricing(model)).not.toBeNull();
      }
    });
  });

  describe('estimateCost', () => {
    it('calculates correct cost for known token counts', () => {
      // 1000 input tokens at $3/M = $0.003
      // 500 output tokens at $15/M = $0.0075
      // total = $0.0105
      const cost = estimateCost({
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }, 'claude-sonnet-4-6');
      expect(cost).toBeCloseTo(0.0105, 6);
    });

    it('includes cache token costs', () => {
      const cost = estimateCost({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 10000,
        cacheWriteTokens: 5000,
      }, 'claude-sonnet-4-6');
      // 10000 cache read at $0.30/M = $0.003
      // 5000 cache write at $3.75/M = $0.01875
      expect(cost).toBeCloseTo(0.02175, 6);
    });

    it('uses default model when model is undefined', () => {
      const cost = estimateCost({
        inputTokens: 1000000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      // Default is claude-sonnet-4-6, $3/M input
      expect(cost).toBeCloseTo(3.0, 2);
    });

    it('uses default model for unknown model string', () => {
      const cost = estimateCost({
        inputTokens: 1000000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }, 'unknown-model');
      // Falls back to default
      expect(cost).toBeCloseTo(3.0, 2);
    });

    it('returns 0 for zero tokens', () => {
      expect(estimateCost({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      })).toBe(0);
    });

    it('returns 0 for null usage', () => {
      expect(estimateCost(null)).toBe(0);
    });

    it('returns 0 for undefined usage', () => {
      expect(estimateCost(undefined)).toBe(0);
    });

    it('clamps negative token counts to zero', () => {
      const cost = estimateCost({
        inputTokens: -1000,
        outputTokens: 500,
        cacheReadTokens: -100,
        cacheWriteTokens: 0,
      }, 'claude-sonnet-4-6');
      // Only output tokens contribute: 500 at $15/M = $0.0075
      expect(cost).toBeCloseTo(0.0075, 6);
      expect(cost).toBeGreaterThanOrEqual(0);
    });
  });
});
