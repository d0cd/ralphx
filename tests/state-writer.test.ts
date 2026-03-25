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
    tmpDir = join(tmpdir(), `ralph-sw-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    ralphDir = join(tmpDir, '.ralph');
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
});
