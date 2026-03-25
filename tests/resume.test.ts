import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { findResumableRun, canResume } from '../src/core/resume.js';
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
    tmpDir = join(tmpdir(), `ralph-resume-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpDir, '.ralph', 'runs', 'test-run'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeState(state: RunState) {
    writeFileSync(
      join(tmpDir, '.ralph', 'runs', state.runId, 'run-state.json'),
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
});
