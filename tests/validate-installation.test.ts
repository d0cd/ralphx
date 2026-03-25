import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeCodeAgent } from '../src/agents/claude-code.js';
import * as childProcess from 'node:child_process';

// Mock execFile to avoid needing actual claude binary
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

describe('ClaudeCodeAgent.validateInstallation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok:true with version when command succeeds', async () => {
    const mockExecFile = vi.mocked(childProcess.execFile);
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, '1.2.3\n', '');
      return {} as ReturnType<typeof childProcess.execFile>;
    });

    const agent = new ClaudeCodeAgent('claude');
    const result = await agent.validateInstallation();
    expect(result.ok).toBe(true);
    expect(result.version).toBe('1.2.3');
    expect(result.error).toBeUndefined();
  });

  it('returns ok:false with error when command not found', async () => {
    const mockExecFile = vi.mocked(childProcess.execFile);
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(new Error('ENOENT'), '', '');
      return {} as ReturnType<typeof childProcess.execFile>;
    });

    const agent = new ClaudeCodeAgent('nonexistent-cmd');
    const result = await agent.validateInstallation();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('nonexistent-cmd not found');
  });

  it('uses custom command name in error message', async () => {
    const mockExecFile = vi.mocked(childProcess.execFile);
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(new Error('timeout'), '', '');
      return {} as ReturnType<typeof childProcess.execFile>;
    });

    const agent = new ClaudeCodeAgent('my-custom-cli');
    const result = await agent.validateInstallation();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('my-custom-cli');
  });
});
