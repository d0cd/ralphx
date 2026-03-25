import { z } from 'zod';

export const RalphConfigSchema = z.object({
  agentCmd: z.string().optional(),
  agentModel: z.string().optional(),

  contextMode: z.enum(['continue', 'fresh']).default('continue'),

  loopMode: z.enum(['backlog', 'convergent']).default('convergent'),
  timeoutMinutes: z.number().min(1).max(120).default(20),
  maxRounds: z.number().optional(),
  maxIterations: z.number().optional(),

  maxCostUsd: z.number().optional(),
  warnCostUsd: z.number().optional(),
  maxTokensSession: z.number().optional(),
  costPerIterationThreshold: z.number().optional(),

  cbNoProgressThreshold: z.number().default(3),
  cbSameErrorThreshold: z.number().default(4),
  cbCooldownMinutes: z.number().default(15),

  storyMaxConsecutiveFailures: z.number().default(3),

  protectedPaths: z.array(z.string()).optional(),
  allowedTools: z.array(z.string()).optional(),

  verbose: z.boolean().default(false),
});

export type RalphConfig = z.infer<typeof RalphConfigSchema>;
