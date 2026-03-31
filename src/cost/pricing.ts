import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TokenUsage } from '../types/agent.js';
import { readJsonFile } from '../sync/atomic-write.js';
import { log } from '../core/logger.js';

interface ModelPricing {
  inputPerMToken: number;
  outputPerMToken: number;
  cacheReadPerMToken: number;
  cacheWritePerMToken: number;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

let pricingCache: Record<string, ModelPricing> | null = null;

function loadPricingData(): Record<string, ModelPricing> {
  if (pricingCache) return pricingCache;
  try {
    const data = readJsonFile<Record<string, ModelPricing>>(join(__dirname, 'models.json'));
    // Guard against empty/null data being cached as truthy — an empty
    // object would permanently disable cost estimation with no retry.
    if (data && Object.keys(data).length > 0) {
      pricingCache = data;
      return pricingCache;
    }
    log.warn('models.json is empty — cost estimation disabled until valid data is available');
    return {};
  } catch (e) {
    // Return empty but do NOT cache — a transient disk error (e.g., EIO,
    // EMFILE) should not permanently disable cost estimation for the
    // entire process lifetime. The next call will retry the read.
    log.warn(`Failed to load pricing data — cost estimation unavailable this iteration: ${(e instanceof Error ? e.message : String(e))}`);
    return {};
  }
}

const DEFAULT_MODEL = 'claude-sonnet-4-6';

export function getModelPricing(model: string): ModelPricing | null {
  const data = loadPricingData();
  return data[model] ?? null;
}

const warnedModels = new Set<string>();

export function estimateCost(usage: TokenUsage | null | undefined, model?: string): number {
  if (!usage) return 0;
  const resolvedModel = model ?? DEFAULT_MODEL;
  let pricing = getModelPricing(resolvedModel);
  if (!pricing) {
    if (!warnedModels.has(resolvedModel)) {
      log.warn(`Unknown model "${resolvedModel}" for cost estimation, falling back to ${DEFAULT_MODEL}`);
      warnedModels.add(resolvedModel);
    }
    pricing = getModelPricing(DEFAULT_MODEL);
  }
  if (!pricing) return 0;

  // Clamp to zero: negative token counts (from malformed API responses)
  // must not produce negative costs that silently reduce the running total.
  const inputCost = (Math.max(0, usage.inputTokens ?? 0) / 1_000_000) * pricing.inputPerMToken;
  const outputCost = (Math.max(0, usage.outputTokens ?? 0) / 1_000_000) * pricing.outputPerMToken;
  const cacheReadCost = (Math.max(0, usage.cacheReadTokens ?? 0) / 1_000_000) * pricing.cacheReadPerMToken;
  const cacheWriteCost = (Math.max(0, usage.cacheWriteTokens ?? 0) / 1_000_000) * pricing.cacheWritePerMToken;

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}
