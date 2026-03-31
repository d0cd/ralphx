import { query, type SDKMessage, type SDKResultSuccess, type SDKResultError } from '@anthropic-ai/claude-agent-sdk';
import { execFile } from 'node:child_process';
import type { IAgent, AgentRunOptions, TokenUsage } from '../types/agent.js';


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
  return patterns.some(p => lower.includes(p));
}

type ProgressCallback = (event: string) => void;

function buildResult(fields: {
  output: string;
  exitCode: number;
  usage: TokenUsage | null;
  sessionId: string | null;
  durationMs: number;
}): import('../types/agent.js').AgentRunResult {
  const isError = fields.exitCode !== 0;
  return {
    output: fields.output,
    exitCode: fields.exitCode,
    usage: fields.usage,
    sessionId: fields.sessionId,
    isApiLimitHit: isError && matchesAny(fields.output, API_LIMIT_PATTERNS),
    isRateLimitHit: isError && matchesAny(fields.output, RATE_LIMIT_PATTERNS),
    rawJson: null,
    durationMs: fields.durationMs,
  };
}

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

  async run(options: AgentRunOptions) {
    const startTime = Date.now();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

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
        sdkOptions.abortController = new AbortController();
        timeoutHandle = setTimeout(() => sdkOptions.abortController!.abort(), options.timeoutMs);
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

      return buildResult({
        output: resultOutput,
        exitCode: isError ? 1 : 0,
        usage,
        sessionId,
        durationMs,
      });
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = (err instanceof Error ? err.message : String(err));

      if (err instanceof Error && err.name === 'AbortError') {
        return buildResult({
          output: `Agent timed out after ${Math.round(durationMs / 1000)}s`,
          exitCode: 1,
          usage: null,
          sessionId: null,
          durationMs,
        });
      }

      return buildResult({
        output: errorMsg,
        exitCode: 1,
        usage: null,
        sessionId: null,
        durationMs,
      });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private handleMessage(message: SDKMessage): void {
    if (!this.onProgress) return;

    switch (message.type) {
      case 'assistant':
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
