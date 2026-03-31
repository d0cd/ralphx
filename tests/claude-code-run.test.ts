import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeCodeAgent } from '../src/agents/claude-code.js';

// Mock the SDK query function
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
const mockQuery = vi.mocked(query);

function makeSuccessResult(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result' as const,
    subtype: 'success' as const,
    session_id: 'sess-abc',
    is_error: false,
    result: 'Task completed.',
    usage: {
      input_tokens: 500,
      output_tokens: 200,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 10,
    },
    total_cost_usd: 0.01,
    ...overrides,
  };
}

function makeErrorResult(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result' as const,
    subtype: 'error' as const,
    session_id: 'sess-err',
    is_error: true,
    errors: ['Something went wrong'],
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    total_cost_usd: 0.001,
    ...overrides,
  };
}

// Helper to create async generator from messages
async function* messageStream(messages: object[]) {
  for (const msg of messages) {
    yield msg;
  }
}

describe('ClaudeCodeAgent.run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns success result with usage data', async () => {
    mockQuery.mockReturnValue(messageStream([makeSuccessResult()]));

    const agent = new ClaudeCodeAgent();
    const result = await agent.run({ prompt: 'Do something' });

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('Task completed.');
    expect(result.sessionId).toBe('sess-abc');
    expect(result.usage).toEqual({
      inputTokens: 500,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
    });
    expect(result.isApiLimitHit).toBe(false);
    expect(result.isRateLimitHit).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('handles error result from SDK', async () => {
    mockQuery.mockReturnValue(messageStream([makeErrorResult()]));

    const agent = new ClaudeCodeAgent();
    const result = await agent.run({ prompt: 'Fail' });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Agent stopped: error');
    expect(result.output).toContain('Something went wrong');
    expect(result.sessionId).toBe('sess-err');
  });

  it('detects API limit hit in error output', async () => {
    mockQuery.mockReturnValue(messageStream([
      makeErrorResult({
        errors: ['exceeded its usage limit for the billing period'],
      }),
    ]));

    const agent = new ClaudeCodeAgent();
    const result = await agent.run({ prompt: 'Run' });

    expect(result.isApiLimitHit).toBe(true);
    expect(result.isRateLimitHit).toBe(false);
  });

  it('detects rate limit hit in error output', async () => {
    mockQuery.mockReturnValue(messageStream([
      makeErrorResult({
        errors: ['rate_limit_error: too many requests'],
      }),
    ]));

    const agent = new ClaudeCodeAgent();
    const result = await agent.run({ prompt: 'Run' });

    expect(result.isRateLimitHit).toBe(true);
  });

  it('handles AbortError as timeout', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';

    mockQuery.mockReturnValue((async function* () {
      throw abortError;
    })());

    const agent = new ClaudeCodeAgent();
    const result = await agent.run({ prompt: 'Slow task', timeoutMs: 100 });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('timed out');
    expect(result.usage).toBeNull();
    expect(result.sessionId).toBeNull();
    expect(result.isApiLimitHit).toBe(false);
  });

  it('handles non-AbortError exceptions', async () => {
    mockQuery.mockReturnValue((async function* () {
      throw new Error('Network connection failed');
    })());

    const agent = new ClaudeCodeAgent();
    const result = await agent.run({ prompt: 'Run' });

    expect(result.exitCode).toBe(1);
    expect(result.output).toBe('Network connection failed');
    expect(result.usage).toBeNull();
    expect(result.isApiLimitHit).toBe(false);
  });

  it('detects API limit in thrown error message', async () => {
    mockQuery.mockReturnValue((async function* () {
      throw new Error('billing: insufficient_quota');
    })());

    const agent = new ClaudeCodeAgent();
    const result = await agent.run({ prompt: 'Run' });

    expect(result.isApiLimitHit).toBe(true);
  });

  it('detects rate limit in thrown error message', async () => {
    mockQuery.mockReturnValue((async function* () {
      throw new Error('429 too many requests');
    })());

    const agent = new ClaudeCodeAgent();
    const result = await agent.run({ prompt: 'Run' });

    expect(result.isRateLimitHit).toBe(true);
  });

  it('passes sessionId as resume option', async () => {
    mockQuery.mockReturnValue(messageStream([makeSuccessResult()]));

    const agent = new ClaudeCodeAgent();
    await agent.run({ prompt: 'Continue', sessionId: 'prev-sess' });

    expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Continue',
      options: expect.objectContaining({ resume: 'prev-sess' }),
    }));
  });

  it('passes allowedTools option', async () => {
    mockQuery.mockReturnValue(messageStream([makeSuccessResult()]));

    const agent = new ClaudeCodeAgent();
    await agent.run({ prompt: 'Run', allowedTools: ['Read', 'Write'] });

    expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({ allowedTools: ['Read', 'Write'] }),
    }));
  });

  it('sets up AbortController when timeoutMs is provided', async () => {
    mockQuery.mockReturnValue(messageStream([makeSuccessResult()]));

    const agent = new ClaudeCodeAgent();
    await agent.run({ prompt: 'Run', timeoutMs: 5000 });

    expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        abortController: expect.any(AbortController),
      }),
    }));
  });

  it('handles result without usage data', async () => {
    mockQuery.mockReturnValue(messageStream([
      makeSuccessResult({ usage: undefined }),
    ]));

    const agent = new ClaudeCodeAgent();
    const result = await agent.run({ prompt: 'Run' });

    expect(result.usage).toBeNull();
    expect(result.exitCode).toBe(0);
  });

  it('handles error result with no errors array', async () => {
    mockQuery.mockReturnValue(messageStream([{
      type: 'result',
      subtype: 'error',
      session_id: 'sess-x',
      is_error: true,
      errors: [],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }]));

    const agent = new ClaudeCodeAgent();
    const result = await agent.run({ prompt: 'Run' });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Agent stopped: error');
    // No errors appended
    expect(result.output).not.toContain('—');
  });
});

describe('ClaudeCodeAgent.handleMessage (progress)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports assistant text messages via progress callback', async () => {
    const progress = vi.fn();
    mockQuery.mockReturnValue(messageStream([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Working on the task...' }],
        },
      },
      makeSuccessResult(),
    ]));

    const agent = new ClaudeCodeAgent('claude', progress);
    await agent.run({ prompt: 'Run' });

    expect(progress).toHaveBeenCalledWith(expect.stringContaining('[assistant]'));
    expect(progress).toHaveBeenCalledWith(expect.stringContaining('Working on the task'));
  });

  it('reports tool_use blocks via progress callback', async () => {
    const progress = vi.fn();
    mockQuery.mockReturnValue(messageStream([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Read' }],
        },
      },
      makeSuccessResult(),
    ]));

    const agent = new ClaudeCodeAgent('claude', progress);
    await agent.run({ prompt: 'Run' });

    expect(progress).toHaveBeenCalledWith('[tool_use] Read');
  });

  it('reports tool_use_summary via progress callback', async () => {
    const progress = vi.fn();
    mockQuery.mockReturnValue(messageStream([
      { type: 'tool_use_summary', summary: 'Read file src/main.ts' },
      makeSuccessResult(),
    ]));

    const agent = new ClaudeCodeAgent('claude', progress);
    await agent.run({ prompt: 'Run' });

    expect(progress).toHaveBeenCalledWith('[tool] Read file src/main.ts');
  });

  it('reports result via progress callback', async () => {
    const progress = vi.fn();
    mockQuery.mockReturnValue(messageStream([makeSuccessResult()]));

    const agent = new ClaudeCodeAgent('claude', progress);
    await agent.run({ prompt: 'Run' });

    expect(progress).toHaveBeenCalledWith(expect.stringContaining('[result]'));
    expect(progress).toHaveBeenCalledWith(expect.stringContaining('subtype=success'));
  });

  it('does not crash when no progress callback', async () => {
    mockQuery.mockReturnValue(messageStream([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
      { type: 'tool_use_summary', summary: 'Did something' },
      makeSuccessResult(),
    ]));

    const agent = new ClaudeCodeAgent();
    const result = await agent.run({ prompt: 'Run' });

    expect(result.exitCode).toBe(0);
  });

  it('truncates long text in progress to 150 chars', async () => {
    const progress = vi.fn();
    const longText = 'A'.repeat(300);
    mockQuery.mockReturnValue(messageStream([
      { type: 'assistant', message: { content: [{ type: 'text', text: longText }] } },
      makeSuccessResult(),
    ]));

    const agent = new ClaudeCodeAgent('claude', progress);
    await agent.run({ prompt: 'Run' });

    const assistantCall = progress.mock.calls.find(c => c[0].includes('[assistant]'));
    expect(assistantCall).toBeDefined();
    // [assistant] prefix + space + 150 chars
    expect(assistantCall![0].length).toBeLessThanOrEqual(163);
  });
});
