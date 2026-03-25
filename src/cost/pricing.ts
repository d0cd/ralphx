import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TokenUsage } from '../types/agent.js';

interface ModelPricing {
  inputPerMToken: number;
  outputPerMToken: number;
  cacheReadPerMToken: number;
  cacheWritePerMToken: number;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pricingCache: Record<string, ModelPricing> | null = null;

function loadPricingData(): Record<string, ModelPricing> {
  if (pricingCache) return pricingCache;
  try {
    const raw = readFileSync(join(__dirname, 'models.json'), 'utf-8');
    pricingCache = JSON.parse(raw);
    return pricingCache!;
  } catch {
    return {}; // best-effort: missing or corrupt models.json disables cost estimation
  }
}

export const DEFAULT_MODEL = 'claude-sonnet-4-6';

export function getModelPricing(model: string): ModelPricing | null {
  const data = loadPricingData();
  return data[model] ?? null;
}

let warnedModels = new Set<string>();

export function estimateCost(usage: TokenUsage, model?: string): number {
  const resolvedModel = model ?? DEFAULT_MODEL;
  let pricing = getModelPricing(resolvedModel);
  if (!pricing) {
    if (!warnedModels.has(resolvedModel)) {
      console.warn(`[ralph] Unknown model "${resolvedModel}" for cost estimation, falling back to ${DEFAULT_MODEL}`);
      warnedModels.add(resolvedModel);
    }
    pricing = getModelPricing(DEFAULT_MODEL);
  }
  if (!pricing) return 0;

  const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputPerMToken;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPerMToken;
  const cacheReadCost = (usage.cacheReadTokens / 1_000_000) * pricing.cacheReadPerMToken;
  const cacheWriteCost = (usage.cacheWriteTokens / 1_000_000) * pricing.cacheWritePerMToken;

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}
