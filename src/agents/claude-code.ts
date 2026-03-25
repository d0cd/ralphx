import { query, type SDKMessage, type SDKResultSuccess, type SDKResultError } from '@anthropic-ai/claude-agent-sdk';
import { execFile } from 'node:child_process';
import type { IAgent, AgentRunResult, AgentRunOptions, TokenUsage } from '../types/agent.js';

const API_LIMIT_PATTERNS = [
  'exceeded its usage limit',
  'billing',
  'insufficient_quota',
];

const RATE_LIMIT_PATTERNS = [
  'rate_limit_error',
  'rate limit exceeded',
  'too many requests',
  '429',
];

function matchesAny(text: string, patterns: string[]): boolean {
  const lower = text.toLowerCase();
  return patterns.some(p => lower.includes(p.toLowerCase()));
}

type ProgressCallback = (event: string) => void;

export class ClaudeCodeAgent implements IAgent {
  readonly name = 'claude-code';
  readonly supportsSessionContinuity = true;
  readonly supportsStructuredOutput = true;

  private cmd: string;
  private onProgress?: ProgressCallback;

  constructor(cmd = 'claude', onProgress?: ProgressCallback) {
    this.cmd = cmd;
    this.onProgress = onProgress;
  }

  parseOutput(raw: string): AgentRunResult {
    // Keep for test compatibility with JSON fixtures
    try {
      const parsed = JSON.parse(raw);
      const output = parsed.result ?? '';
      const isError = parsed.is_error ?? false;
      let usage: TokenUsage | null = null;
      if (parsed.usage && parsed.usage.input_tokens !== undefined) {
        usage = {
          inputTokens: parsed.usage.input_tokens ?? 0,
          outputTokens: parsed.usage.output_tokens ?? 0,
          cacheReadTokens: parsed.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: parsed.usage.cache_creation_input_tokens ?? 0,
        };
      }
      return {
        output,
        exitCode: isError ? 1 : 0,
        usage,
        sessionId: parsed.session_id ?? null,
        isApiLimitHit: isError && matchesAny(output, API_LIMIT_PATTERNS),
        isRateLimitHit: isError && matchesAny(output, RATE_LIMIT_PATTERNS),
        rawJson: parsed,
        durationMs: 0,
      };
    } catch {
      return {
        output: raw,
        exitCode: 1,
        usage: null,
        sessionId: null,
        isApiLimitHit: false,
        isRateLimitHit: false,
        rawJson: null,
        durationMs: 0,
      };
    }
  }

  buildArgs(options: AgentRunOptions): string[] {
    // Keep for test compatibility
    const args: string[] = ['-p', options.prompt, '--verbose'];
    if (options.outputFormat) args.push('--output-format', options.outputFormat);
    if (options.sessionId) args.push('--resume', options.sessionId);
    if (options.allowedTools && options.allowedTools.length > 0) {
      args.push('--allowedTools', options.allowedTools.join(','));
    }
    return args;
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const startTime = Date.now();

    try {
      let resultOutput = '';
      let sessionId: string | null = null;
      let usage: TokenUsage | null = null;
      let isError = false;

      const sdkOptions: Parameters<typeof query>[0]['options'] = {
        permissionMode: 'bypassPermissions',
      };

      if (options.sessionId) {
        sdkOptions.resume = options.sessionId;
      }
      if (options.allowedTools && options.allowedTools.length > 0) {
        sdkOptions.allowedTools = options.allowedTools;
      }
      if (options.timeoutMs) {
        // Convert timeout to budget — rough estimate at $15/MTok output
        // SDK has maxBudgetUsd but not a direct timeout; use abortController
        sdkOptions.abortController = new AbortController();
        setTimeout(() => sdkOptions.abortController!.abort(), options.timeoutMs);
      }

      for await (const message of query({
        prompt: options.prompt,
        options: sdkOptions,
      })) {
        this.handleMessage(message);

        if (message.type === 'result') {
          const resultMsg = message as SDKResultSuccess | SDKResultError;
          sessionId = resultMsg.session_id;
          isError = resultMsg.is_error;

          if (resultMsg.subtype === 'success') {
            resultOutput = (resultMsg as SDKResultSuccess).result;
          } else {
            // Error result
            const errMsg = resultMsg as SDKResultError;
            resultOutput = `Agent stopped: ${errMsg.subtype}`;
            if (errMsg.errors?.length) {
              resultOutput += ` — ${errMsg.errors.join('; ')}`;
            }
          }

          if (resultMsg.usage) {
            usage = {
              inputTokens: resultMsg.usage.input_tokens ?? 0,
              outputTokens: resultMsg.usage.output_tokens ?? 0,
              cacheReadTokens: resultMsg.usage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: resultMsg.usage.cache_creation_input_tokens ?? 0,
            };
          }
        }
      }

      const durationMs = Date.now() - startTime;

      return {
        output: resultOutput,
        exitCode: isError ? 1 : 0,
        usage,
        sessionId,
        isApiLimitHit: isError && matchesAny(resultOutput, API_LIMIT_PATTERNS),
        isRateLimitHit: isError && matchesAny(resultOutput, RATE_LIMIT_PATTERNS),
        rawJson: null,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (err instanceof Error && err.name === 'AbortError') {
        return {
          output: `Agent timed out after ${Math.round(durationMs / 1000)}s`,
          exitCode: 1,
          usage: null,
          sessionId: null,
          isApiLimitHit: false,
          isRateLimitHit: false,
          rawJson: null,
          durationMs,
        };
      }

      return {
        output: errorMsg,
        exitCode: 1,
        usage: null,
        sessionId: null,
        isApiLimitHit: matchesAny(errorMsg, API_LIMIT_PATTERNS),
        isRateLimitHit: matchesAny(errorMsg, RATE_LIMIT_PATTERNS),
        rawJson: null,
        durationMs,
      };
    }
  }

  private handleMessage(message: SDKMessage): void {
    if (!this.onProgress) return;

    switch (message.type) {
      case 'assistant':
        // Extract text from the assistant's message content blocks
        if (message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === 'text') {
              this.onProgress(`[assistant] ${block.text.slice(0, 150)}`);
            } else if (block.type === 'tool_use') {
              this.onProgress(`[tool_use] ${block.name}`);
            }
          }
        }
        break;
      case 'tool_use_summary':
        this.onProgress(`[tool] ${message.summary.slice(0, 150)}`);
        break;
      case 'result':
        this.onProgress(`[result] subtype=${message.subtype}, cost=$${message.total_cost_usd?.toFixed(4) ?? '?'}`);
        break;
    }
  }

  async validateInstallation(): Promise<{ ok: boolean; version?: string; error?: string }> {
    return new Promise((resolve) => {
      execFile(this.cmd, ['--version'], { timeout: 10000 }, (error, stdout) => {
        if (error) {
          resolve({ ok: false, error: `${this.cmd} not found or not executable` });
          return;
        }
        resolve({ ok: true, version: stdout.trim() });
      });
    });
  }
}
