import { z } from 'zod';

/** z.number() that rejects NaN — prevents silent limit bypass from bad CLI input. */
const safeNumber = () => z.number().refine(n => !Number.isNaN(n), { message: 'Expected a valid number, received NaN' });

export const RalphConfigSchema = z.object({
  agentCmd: z.string().optional(),
  agentModel: z.string().optional(),

  contextMode: z.enum(['continue', 'fresh']).default('continue'),

  loopMode: z.enum(['backlog', 'convergent']).default('convergent'),
  timeoutMinutes: safeNumber().min(1).max(120).default(20),
  maxRounds: safeNumber().optional(),
  maxIterations: safeNumber().optional(),

  maxCostUsd: safeNumber().optional(),
  warnCostUsd: safeNumber().optional(),
  maxTokensSession: safeNumber().optional(),
  costPerIterationThreshold: safeNumber().optional(),

  cbNoProgressThreshold: safeNumber().default(3),
  cbSameErrorThreshold: safeNumber().default(4),
  cbCooldownMinutes: safeNumber().default(15),

  storyMaxConsecutiveFailures: safeNumber().default(3),
  convergenceThreshold: safeNumber().min(1).default(1),

  protectedPaths: z.array(z.string()).optional(),
  allowedTools: z.array(z.string()).optional(),

  verbose: z.boolean().default(false),
});

export type RalphConfig = z.infer<typeof RalphConfigSchema>;
