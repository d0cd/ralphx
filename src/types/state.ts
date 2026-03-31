interface TokenUsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  estimatedCostUsd: number;
}

export interface IterationRecord {
  iteration: number;
  round: number;
  storyId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  validationPassed: boolean;
  summary?: string;
}

export interface ValidationResult {
  passed: boolean;
  commandResults: Array<{
    name: string;
    passed: boolean;
    exitCode: number;
    outputSummary?: string;
  }>;
  protectedPathsViolated: string[];
  warnings: string[];
  reasons: string[];
}

export type ExitReason =
  | 'converged'
  | 'no_progress'
  | 'max_iterations'
  | 'max_rounds'
  | 'budget_exceeded'
  | 'circuit_breaker_terminal'
  | 'interrupted'
  | 'validation_failed_repeatedly';

export type RunStatus = 'running' | 'paused' | 'complete' | 'interrupted' | 'crashed';

export interface RunState {
  runId: string;
  projectDir: string;
  startedAt: string;
  updatedAt: string;
  pid: number;

  agent: string;
  model?: string;
  status: RunStatus;

  iteration: number;
  round: number;
  maxIterations?: number;

  currentStoryId?: string;
  currentStoryTitle?: string;

  lastAgentOutputSummary?: string;
  lastValidationResult?: ValidationResult;
  lastError?: string;
  exitReason?: ExitReason;

  sessionId?: string;
  contextMode: 'continue' | 'fresh';

  cost: TokenUsageSummary;
  perIteration: IterationRecord[];
}
