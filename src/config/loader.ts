import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { RalphConfigSchema, type RalphConfig } from '../types/config.js';

const ENV_MAP: Record<string, { key: keyof RalphConfig; type: 'string' | 'number' | 'boolean' }> = {
  RALPH_AGENT_CMD: { key: 'agentCmd', type: 'string' },
  RALPH_AGENT_MODEL: { key: 'agentModel', type: 'string' },
  RALPH_CONTEXT_MODE: { key: 'contextMode', type: 'string' },
  RALPH_TIMEOUT_MINUTES: { key: 'timeoutMinutes', type: 'number' },
  RALPH_MAX_ITERATIONS: { key: 'maxIterations', type: 'number' },
  RALPH_MAX_COST_USD: { key: 'maxCostUsd', type: 'number' },
  RALPH_WARN_COST_USD: { key: 'warnCostUsd', type: 'number' },
  RALPH_MAX_TOKENS_SESSION: { key: 'maxTokensSession', type: 'number' },
  RALPH_COST_PER_ITERATION_THRESHOLD: { key: 'costPerIterationThreshold', type: 'number' },
  RALPH_CB_NO_PROGRESS_THRESHOLD: { key: 'cbNoProgressThreshold', type: 'number' },
  RALPH_CB_SAME_ERROR_THRESHOLD: { key: 'cbSameErrorThreshold', type: 'number' },
  RALPH_CB_COOLDOWN_MINUTES: { key: 'cbCooldownMinutes', type: 'number' },
  RALPH_CLAIM_TTL_MINUTES: { key: 'claimTtlMinutes', type: 'number' },
  RALPH_VERBOSE: { key: 'verbose', type: 'boolean' },
  RALPH_STORY_MAX_CONSECUTIVE_FAILURES: { key: 'storyMaxConsecutiveFailures', type: 'number' },
};

function parseEnvValue(value: string, type: 'string' | 'number' | 'boolean'): unknown {
  switch (type) {
    case 'number': return Number(value);
    case 'boolean': return value === 'true' || value === '1';
    case 'string': return value;
  }
}

function loadFromFile(projectDir: string): Record<string, unknown> {
  const rcPath = join(projectDir, '.ralph', '.ralphrc');
  if (!existsSync(rcPath)) return {};
  try {
    const raw = readFileSync(rcPath, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Failed to load config from ${rcPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function loadFromEnv(env: Record<string, string | undefined>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [envKey, mapping] of Object.entries(ENV_MAP)) {
    const value = env[envKey];
    if (value !== undefined) {
      result[mapping.key] = parseEnvValue(value, mapping.type);
    }
  }
  return result;
}

interface LoadConfigOptions {
  projectDir: string;
  env?: Record<string, string | undefined>;
  flags?: Partial<RalphConfig>;
}

export function loadConfig(options: LoadConfigOptions): RalphConfig {
  const fileConfig = loadFromFile(options.projectDir);
  const envConfig = loadFromEnv(options.env ?? process.env);
  const flags = options.flags ?? {};

  // Resolution: flags > env > file > defaults (zod handles defaults)
  const merged = { ...fileConfig, ...envConfig, ...flags };

  return RalphConfigSchema.parse(merged);
}
