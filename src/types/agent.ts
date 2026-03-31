export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AgentRunResult {
  output: string;
  exitCode: number;
  usage: TokenUsage | null;
  sessionId: string | null;
  isApiLimitHit: boolean;
  isRateLimitHit: boolean;
  rawJson: unknown | null;
  durationMs: number;
}

export interface AgentRunOptions {
  prompt: string;
  allowedTools?: string[];
  sessionId?: string;
  timeoutMs?: number;
}

export interface IAgent {
  readonly name: string;
  readonly supportsSessionContinuity: boolean;
  readonly supportsStructuredOutput: boolean;

  run(options: AgentRunOptions): Promise<AgentRunResult>;
  validateInstallation(): Promise<{ ok: boolean; version?: string; error?: string }>;
}
