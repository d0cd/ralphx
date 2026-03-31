import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateWriter } from '../src/core/state-writer.js';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RunState } from '../src/types/state.js';

describe('StateWriter', () => {
  let tmpDir: string;
  let ralphDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ralphx-sw-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    ralphDir = tmpDir;
    mkdirSync(ralphDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeWriter(runId = 'test-run-1') {
    return new StateWriter({
      runId,
      projectDir: tmpDir,
      agent: 'claude-code',
      contextMode: 'continue',
    });
  }

  it('creates run directory and initial state file on initialize', async () => {
    const writer = makeWriter();
    await writer.initialize();

    const runDir = join(ralphDir, 'runs', 'test-run-1');
    expect(existsSync(runDir)).toBe(true);
    expect(existsSync(join(runDir, 'run-state.json'))).toBe(true);
  });

  it('state file is valid JSON after flush', async () => {
    const writer = makeWriter();
    await writer.initialize();

    const statePath = join(ralphDir, 'runs', 'test-run-1', 'run-state.json');
    const state: RunState = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(state.runId).toBe('test-run-1');
    expect(state.status).toBe('running');
    expect(state.iteration).toBe(0);
    expect(state.cost.estimatedCostUsd).toBe(0);
  });

  it('recordIteration appends to perIteration and updates cost totals', async () => {
    const writer = makeWriter();
    await writer.initialize();

    await writer.recordIteration({
      iteration: 1,
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:01:00Z',
      durationMs: 60000,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
      estimatedCostUsd: 0.05,
      validationPassed: true,
    });

    const state = writer.getState();
    expect(state.perIteration).toHaveLength(1);
    expect(state.perIteration[0].iteration).toBe(1);
    expect(state.cost.totalInputTokens).toBe(1000);
    expect(state.cost.totalOutputTokens).toBe(500);
    expect(state.cost.totalCacheReadTokens).toBe(200);
    expect(state.cost.totalCacheWriteTokens).toBe(100);
    expect(state.cost.estimatedCostUsd).toBe(0.05);
    expect(state.iteration).toBe(1);

    // Second iteration accumulates
    await writer.recordIteration({
      iteration: 2,
      startedAt: '2026-01-01T00:01:00Z',
      endedAt: '2026-01-01T00:02:00Z',
      durationMs: 60000,
      inputTokens: 2000,
      outputTokens: 800,
      cacheReadTokens: 300,
      cacheWriteTokens: 150,
      estimatedCostUsd: 0.08,
      validationPassed: false,
    });

    const state2 = writer.getState();
    expect(state2.perIteration).toHaveLength(2);
    expect(state2.cost.totalInputTokens).toBe(3000);
    expect(state2.cost.totalOutputTokens).toBe(1300);
    expect(state2.cost.totalCacheReadTokens).toBe(500);
    expect(state2.cost.totalCacheWriteTokens).toBe(250);
    expect(state2.cost.estimatedCostUsd).toBeCloseTo(0.13);
    expect(state2.iteration).toBe(2);
  });

  it('recordValidation updates lastValidationResult', async () => {
    const writer = makeWriter();
    await writer.initialize();

    await writer.recordValidation({
      passed: false,
      commandResults: [{ name: 'test', passed: false, exitCode: 1 }],
      protectedPathsViolated: ['.env'],
      warnings: [],
      reasons: ['tests failed'],
    });

    const state = writer.getState();
    expect(state.lastValidationResult?.passed).toBe(false);
    expect(state.lastValidationResult?.protectedPathsViolated).toContain('.env');
  });

  it('setStatus updates status field', async () => {
    const writer = makeWriter();
    await writer.initialize();

    await writer.setStatus('paused');
    expect(writer.getState().status).toBe('paused');

    await writer.setStatus('interrupted');
    expect(writer.getState().status).toBe('interrupted');
  });

  it('no temp files left after flush', async () => {
    const writer = makeWriter();
    await writer.initialize();

    const runDir = join(ralphDir, 'runs', 'test-run-1');
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(runDir);
    const tempFiles = files.filter(f => f.startsWith('.tmp-'));
    expect(tempFiles).toHaveLength(0);
  });

  it('flush throws descriptive error when directory is removed', async () => {
    const writer = makeWriter();
    await writer.initialize();

    // Remove the run directory to simulate write failure
    rmSync(join(ralphDir, 'runs', 'test-run-1'), { recursive: true, force: true });

    await expect(writer.flush()).rejects.toThrow('Failed to write');
  });

  it('getState returns a defensive copy', async () => {
    const writer = makeWriter();
    await writer.initialize();

    const state1 = writer.getState();
    state1.iteration = 999;
    state1.perIteration.push({} as never);

    const state2 = writer.getState();
    expect(state2.iteration).toBe(0);
    expect(state2.perIteration).toHaveLength(0);
  });

  it('setCurrentStory is observable through getState', async () => {
    const writer = makeWriter();
    await writer.initialize();

    writer.setCurrentStory('story-42', 'Fix the widget');
    const state = writer.getState();
    expect(state.currentStoryId).toBe('story-42');
    expect(state.currentStoryTitle).toBe('Fix the widget');

    // Clearing
    writer.setCurrentStory(undefined, undefined);
    const cleared = writer.getState();
    expect(cleared.currentStoryId).toBeUndefined();
    expect(cleared.currentStoryTitle).toBeUndefined();
  });

  it('setLastAgentOutputSummary is observable through getState', async () => {
    const writer = makeWriter();
    await writer.initialize();

    writer.setLastAgentOutputSummary('Agent fixed 3 issues');
    expect(writer.getState().lastAgentOutputSummary).toBe('Agent fixed 3 issues');

    writer.setLastAgentOutputSummary(undefined);
    expect(writer.getState().lastAgentOutputSummary).toBeUndefined();
  });

  it('setLastError is observable through getState', async () => {
    const writer = makeWriter();
    await writer.initialize();

    writer.setLastError('Validation failed: tests broken');
    expect(writer.getState().lastError).toBe('Validation failed: tests broken');

    writer.setLastError(undefined);
    expect(writer.getState().lastError).toBeUndefined();
  });

  it('setLastError stores error messages', async () => {
    const writer = makeWriter();
    await writer.initialize();

    writer.setLastError('Connection failed: some error');
    const state = writer.getState();
    expect(state.lastError).toContain('Connection failed');
  });

  it('setLastError truncates very long error messages', async () => {
    const writer = makeWriter();
    await writer.initialize();

    const longError = 'Error: '.repeat(200);
    writer.setLastError(longError);
    const state = writer.getState();
    // sanitizeOutput caps at 500, truncateForState also caps at 500
    expect(state.lastError!.length).toBeLessThanOrEqual(520); // 500 + "[truncated]"
  });

  it('setExitReason is observable through getState', async () => {
    const writer = makeWriter();
    await writer.initialize();

    writer.setExitReason('budget_exceeded');
    expect(writer.getState().exitReason).toBe('budget_exceeded');
  });

  it('recordIteration includes round and storyId fields', async () => {
    const writer = makeWriter();
    await writer.initialize();

    await writer.recordIteration({
      iteration: 1,
      round: 2,
      storyId: 'story-7',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:01:00Z',
      durationMs: 60000,
      inputTokens: 500,
      outputTokens: 250,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.02,
      validationPassed: true,
      summary: 'Fixed auth bug',
    });

    const state = writer.getState();
    expect(state.round).toBe(2);
    expect(state.perIteration[0].storyId).toBe('story-7');
    expect(state.perIteration[0].summary).toBe('Fixed auth bug');
  });

  it('loop.log grows with each flush', async () => {
    const writer = makeWriter();
    await writer.initialize();

    const logPath = join(ralphDir, 'runs', 'test-run-1', 'loop.log');
    const initialSize = readFileSync(logPath, 'utf-8').length;

    await writer.recordIteration({
      iteration: 1,
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:01:00Z',
      durationMs: 60000,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.05,
      validationPassed: true,
    });

    const afterSize = readFileSync(logPath, 'utf-8').length;
    expect(afterSize).toBeGreaterThan(initialSize);
  });

  it('restoreFrom preserves previous iteration count and cost totals', async () => {
    const writer = makeWriter();
    await writer.initialize();

    const previousState: RunState = {
      runId: 'test-run-1',
      projectDir: tmpDir,
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:05:00Z',
      pid: 1234,
      agent: 'claude-code',
      status: 'interrupted',
      iteration: 7,
      round: 3,
      contextMode: 'continue',
      cost: {
        totalInputTokens: 15000,
        totalOutputTokens: 8000,
        totalCacheReadTokens: 500,
        totalCacheWriteTokens: 200,
        estimatedCostUsd: 0.42,
      },
      perIteration: [
        {
          iteration: 1, round: 1, storyId: 'story-1',
          startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z',
          durationMs: 60000, inputTokens: 1000, outputTokens: 500,
          cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0.05,
          validationPassed: true,
        },
      ],
      exitReason: 'interrupted',
      lastError: 'previous error',
    };

    await writer.restoreFrom(previousState);

    const state = writer.getState();
    expect(state.iteration).toBe(7);
    expect(state.round).toBe(3);
    expect(state.cost.totalInputTokens).toBe(15000);
    expect(state.cost.totalOutputTokens).toBe(8000);
    expect(state.cost.estimatedCostUsd).toBe(0.42);
    expect(state.perIteration).toHaveLength(1);
    expect(state.startedAt).toBe('2026-01-01T00:00:00Z');
    expect(state.exitReason).toBeUndefined();
    expect(state.lastError).toBe('previous error');
    expect(state.status).toBe('running');
  });

  it('restoreFrom then recordIteration accumulates correctly', async () => {
    const writer = makeWriter();
    await writer.initialize();

    await writer.restoreFrom({
      runId: 'test-run-1',
      projectDir: tmpDir,
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:05:00Z',
      pid: 1234,
      agent: 'claude-code',
      status: 'interrupted',
      iteration: 3,
      round: 1,
      contextMode: 'continue',
      cost: {
        totalInputTokens: 5000,
        totalOutputTokens: 2000,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        estimatedCostUsd: 0.10,
      },
      perIteration: [],
    });

    await writer.recordIteration({
      iteration: 4, round: 2, storyId: 'story-2',
      startedAt: '2026-01-01T00:06:00Z', endedAt: '2026-01-01T00:07:00Z',
      durationMs: 60000, inputTokens: 1000, outputTokens: 500,
      cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0.05,
      validationPassed: true,
    });

    const state = writer.getState();
    expect(state.iteration).toBe(4);
    expect(state.cost.totalInputTokens).toBe(6000);
    expect(state.cost.estimatedCostUsd).toBeCloseTo(0.15);
  });

  it('two independent runs produce separate state files', async () => {
    const writer1 = makeWriter('run-aaa');
    const writer2 = makeWriter('run-bbb');

    await writer1.initialize();
    await writer2.initialize();

    await writer1.recordIteration({
      iteration: 1, round: 1, storyId: 's1',
      startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z',
      durationMs: 60000, inputTokens: 1000, outputTokens: 500,
      cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0.05,
      validationPassed: true,
    });

    // Writer 2 should be unaffected
    const state2 = writer2.getState();
    expect(state2.iteration).toBe(0);
    expect(state2.cost.totalInputTokens).toBe(0);

    // Writer 1 has its own state
    const state1 = writer1.getState();
    expect(state1.iteration).toBe(1);
    expect(state1.runId).toBe('run-aaa');

    // Both state files exist on disk independently
    const path1 = join(ralphDir, 'runs', 'run-aaa', 'run-state.json');
    const path2 = join(ralphDir, 'runs', 'run-bbb', 'run-state.json');
    expect(existsSync(path1)).toBe(true);
    expect(existsSync(path2)).toBe(true);

    const disk1: RunState = JSON.parse(readFileSync(path1, 'utf-8'));
    const disk2: RunState = JSON.parse(readFileSync(path2, 'utf-8'));
    expect(disk1.runId).toBe('run-aaa');
    expect(disk2.runId).toBe('run-bbb');
    expect(disk1.iteration).toBe(1);
    expect(disk2.iteration).toBe(0);
  });
});
