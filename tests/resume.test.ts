import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { findResumableRun, canResume, isStaleRunning } from '../src/core/resume.js';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RunState } from '../src/types/state.js';

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: 'test-run',
    projectDir: '/tmp/test',
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:05:00Z',
    pid: process.pid,
    agent: 'claude-code',
    status: 'interrupted',
    iteration: 5,
    contextMode: 'continue',
    cost: {
      totalInputTokens: 5000,
      totalOutputTokens: 2500,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      estimatedCostUsd: 0.05,
    },
    perIteration: [],
    ...overrides,
  };
}

describe('Resume', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ralphx-resume-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpDir, 'runs', 'test-run'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeState(state: RunState) {
    writeFileSync(
      join(tmpDir, 'runs', state.runId, 'run-state.json'),
      JSON.stringify(state),
    );
  }

  it('finds interrupted run', () => {
    writeState(makeRunState({ status: 'interrupted' }));
    const state = findResumableRun(tmpDir, 'test-run');
    expect(state).not.toBeNull();
    expect(state!.runId).toBe('test-run');
    expect(state!.iteration).toBe(5);
  });

  it('finds paused run', () => {
    writeState(makeRunState({ status: 'paused' }));
    const state = findResumableRun(tmpDir, 'test-run');
    expect(state).not.toBeNull();
  });

  it('returns null for completed run', () => {
    writeState(makeRunState({ status: 'complete' }));
    const state = findResumableRun(tmpDir, 'test-run');
    expect(state).toBeNull();
  });

  it('returns null for crashed run', () => {
    writeState(makeRunState({ status: 'crashed' }));
    const state = findResumableRun(tmpDir, 'test-run');
    expect(state).toBeNull();
  });

  it('returns null for nonexistent run', () => {
    const state = findResumableRun(tmpDir, 'nonexistent');
    expect(state).toBeNull();
  });

  it('restores cost totals from previous state', () => {
    writeState(makeRunState({ status: 'interrupted' }));
    const state = findResumableRun(tmpDir, 'test-run');
    expect(state!.cost.totalInputTokens).toBe(5000);
    expect(state!.cost.estimatedCostUsd).toBe(0.05);
  });

  it('canResume returns true for interrupted', () => {
    expect(canResume('interrupted')).toBe(true);
  });

  it('canResume returns true for paused', () => {
    expect(canResume('paused')).toBe(true);
  });

  it('canResume returns false for complete', () => {
    expect(canResume('complete')).toBe(false);
  });

  it('canResume returns false for running', () => {
    expect(canResume('running')).toBe(false);
  });

  // --- isStaleRunning ---

  it('isStaleRunning returns true when status is running and PID is dead', () => {
    // Use a PID that is almost certainly not alive (max possible PID)
    const state = makeRunState({ status: 'running', pid: 2147483647 });
    expect(isStaleRunning(state)).toBe(true);
  });

  it('isStaleRunning returns false when status is running and PID is alive', () => {
    // Current process PID is definitely alive
    const state = makeRunState({ status: 'running', pid: process.pid });
    expect(isStaleRunning(state)).toBe(false);
  });

  it('isStaleRunning returns false when status is not running', () => {
    const state = makeRunState({ status: 'interrupted', pid: 2147483647 });
    expect(isStaleRunning(state)).toBe(false);
  });

  // --- findResumableRun edge cases ---

  it('findResumableRun treats stale running process as interrupted', () => {
    // Write a state with status 'running' but a dead PID
    writeState(makeRunState({ status: 'running', pid: 2147483647 }));
    const state = findResumableRun(tmpDir, 'test-run');
    expect(state).not.toBeNull();
    expect(state!.status).toBe('interrupted');
  });

  it('findResumableRun throws on corrupt JSON (surfaces data corruption)', () => {
    const statePath = join(tmpDir, 'runs', 'test-run', 'run-state.json');
    writeFileSync(statePath, '{ broken json!!!');
    expect(() => findResumableRun(tmpDir, 'test-run')).toThrow(/Failed to read JSON from/);
  });

  it('findResumableRun throws on empty state file (surfaces data corruption)', () => {
    const statePath = join(tmpDir, 'runs', 'test-run', 'run-state.json');
    writeFileSync(statePath, '');
    expect(() => findResumableRun(tmpDir, 'test-run')).toThrow(/Failed to read JSON from/);
  });

  it('findResumableRun throws on partial/truncated JSON (surfaces data corruption)', () => {
    const statePath = join(tmpDir, 'runs', 'test-run', 'run-state.json');
    writeFileSync(statePath, '{"runId":"test","status":"inter');
    expect(() => findResumableRun(tmpDir, 'test-run')).toThrow(/Failed to read JSON from/);
  });
});
