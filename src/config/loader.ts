import { join } from 'node:path';
import { RalphConfigSchema, type RalphConfig } from '../types/config.js';
import { readJsonFile } from '../sync/atomic-write.js';

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
  RALPH_VERBOSE: { key: 'verbose', type: 'boolean' },
  RALPH_STORY_MAX_CONSECUTIVE_FAILURES: { key: 'storyMaxConsecutiveFailures', type: 'number' },
  RALPH_MAX_ROUNDS: { key: 'maxRounds', type: 'number' },
  RALPH_LOOP_MODE: { key: 'loopMode', type: 'string' },
  RALPH_CONVERGENCE_THRESHOLD: { key: 'convergenceThreshold', type: 'number' },
};

function parseEnvValue(value: string, type: 'string' | 'number' | 'boolean'): unknown {
  switch (type) {
    case 'number': {
      const n = Number(value);
      if (Number.isNaN(n)) {
        throw new Error(`Invalid numeric value "${value}" in environment variable`);
      }
      return n;
    }
    case 'boolean': return value === 'true' || value === '1';
    case 'string': return value;
  }
}

function loadFromFile(projectDir: string): Record<string, unknown> {
  return readJsonFile<Record<string, unknown>>(join(projectDir, '.ralphxrc'), {});
}

function loadFromEnv(env: Record<string, string | undefined>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [envKey, mapping] of Object.entries(ENV_MAP)) {
    const value = env[envKey];
    if (value !== undefined) {
      try {
        result[mapping.key] = parseEnvValue(value, mapping.type);
      } catch (e) {
        throw new Error(`${envKey}="${value}": ${(e instanceof Error ? e.message : String(e))}`);
      }
    }
  }
  return result;
}

interface LoadConfigOptions {
  projectDir: string;
  env?: Record<string, string | undefined>;
  flags?: Partial<RalphConfig>;
}

/** Strip keys whose value is undefined so they don't shadow lower-priority sources in the merge. */
function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export function loadConfig(options: LoadConfigOptions): RalphConfig {
  const fileConfig = loadFromFile(options.projectDir);
  const envConfig = loadFromEnv(options.env ?? process.env);
  const flags = options.flags ?? {};

  // Resolution: flags > env > file > defaults (zod handles defaults).
  // stripUndefined prevents an explicit `undefined` in a higher-priority
  // source from shadowing a real value in a lower-priority source.
  const merged = { ...stripUndefined(fileConfig), ...stripUndefined(envConfig), ...stripUndefined(flags as Record<string, unknown>) };

  return RalphConfigSchema.parse(merged);
}
