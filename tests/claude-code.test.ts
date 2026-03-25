import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeCodeAgent } from '../src/agents/claude-code.js';

describe('ClaudeCodeAgent', () => {
  let agent: ClaudeCodeAgent;

  beforeEach(() => {
    agent = new ClaudeCodeAgent();
  });

  describe('parseOutput', () => {
    it('parses valid JSON output into AgentRunResult', () => {
      const fixture = JSON.stringify({
        result: 'I completed the task.',
        is_error: false,
        session_id: 'sess-123',
        usage: {
          input_tokens: 1500,
          output_tokens: 800,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 100,
        },
      });

      const result = agent.parseOutput(fixture);
      expect(result.output).toBe('I completed the task.');
      expect(result.exitCode).toBe(0);
      expect(result.sessionId).toBe('sess-123');
      expect(result.usage).toEqual({
        inputTokens: 1500,
        outputTokens: 800,
        cacheReadTokens: 200,
        cacheWriteTokens: 100,
      });
      expect(result.isApiLimitHit).toBe(false);
      expect(result.isRateLimitHit).toBe(false);
    });

    it('handles missing usage fields gracefully', () => {
      const fixture = JSON.stringify({
        result: 'Done.',
        is_error: false,
      });

      const result = agent.parseOutput(fixture);
      expect(result.output).toBe('Done.');
      expect(result.usage).toBeNull();
      expect(result.sessionId).toBeNull();
    });

    it('detects isApiLimitHit from error output', () => {
      const fixture = JSON.stringify({
        result: 'Error: Your API key has exceeded its usage limit',
        is_error: true,
      });

      const result = agent.parseOutput(fixture);
      expect(result.isApiLimitHit).toBe(true);
      expect(result.exitCode).toBe(1);
    });

    it('detects isRateLimitHit from error output', () => {
      const fixture = JSON.stringify({
        result: 'Error: rate_limit_error - Rate limit exceeded',
        is_error: true,
      });

      const result = agent.parseOutput(fixture);
      expect(result.isRateLimitHit).toBe(true);
    });

    it('handles is_error flag', () => {
      const fixture = JSON.stringify({
        result: 'Something went wrong',
        is_error: true,
      });

      const result = agent.parseOutput(fixture);
      expect(result.exitCode).toBe(1);
    });

    it('returns raw string with exitCode 1 for non-JSON input', () => {
      const result = agent.parseOutput('not valid json at all');
      expect(result.output).toBe('not valid json at all');
      expect(result.exitCode).toBe(1);
      expect(result.usage).toBeNull();
      expect(result.sessionId).toBeNull();
      expect(result.isApiLimitHit).toBe(false);
      expect(result.isRateLimitHit).toBe(false);
      expect(result.rawJson).toBeNull();
    });

    it('returns raw string for empty input', () => {
      const result = agent.parseOutput('');
      expect(result.output).toBe('');
      expect(result.exitCode).toBe(1);
      expect(result.usage).toBeNull();
    });
  });

  describe('buildArgs', () => {
    it('constructs correct CLI args from AgentRunOptions', () => {
      const args = agent.buildArgs({
        prompt: 'Fix the bug',
        outputFormat: 'json',
        sessionId: 'sess-abc',
        allowedTools: ['Read', 'Write'],
        timeoutMs: 60000,
      });

      expect(args).toContain('--output-format');
      expect(args).toContain('json');
      expect(args).toContain('--resume');
      expect(args).toContain('sess-abc');
      expect(args).toContain('--allowedTools');
      expect(args).toContain('Read,Write');
      expect(args).toContain('-p');
      expect(args).toContain('Fix the bug');
    });

    it('omits optional args when not provided', () => {
      const args = agent.buildArgs({
        prompt: 'Do something',
      });

      expect(args).toContain('-p');
      expect(args).toContain('Do something');
      expect(args).not.toContain('--resume');
      expect(args).not.toContain('--allowedTools');
    });
  });

  describe('properties', () => {
    it('has correct name', () => {
      expect(agent.name).toBe('claude-code');
    });

    it('supports session continuity', () => {
      expect(agent.supportsSessionContinuity).toBe(true);
    });

    it('supports structured output', () => {
      expect(agent.supportsStructuredOutput).toBe(true);
    });
  });
});
