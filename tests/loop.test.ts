import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RalphLoop } from '../src/core/loop.js';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IAgent, AgentRunResult, AgentRunOptions } from '../src/types/agent.js';
import type { RalphConfig } from '../src/types/config.js';
import type { PRD } from '../src/types/prd.js';

function makeMockAgent(results?: Partial<AgentRunResult>[]): IAgent {
  let callIndex = 0;
  const defaultResult: AgentRunResult = {
    output: 'Task completed.',
    exitCode: 0,
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
    sessionId: 'sess-1',
    isApiLimitHit: false,
    isRateLimitHit: false,
    rawJson: null,
    durationMs: 1000,
  };

  return {
    name: 'mock-agent',
    supportsSessionContinuity: true,
    supportsStructuredOutput: true,
    async run(_options: AgentRunOptions): Promise<AgentRunResult> {
      const overrides = results?.[callIndex] ?? {};
      callIndex++;
      return { ...defaultResult, ...overrides };
    },
    parseOutput(raw: string): AgentRunResult {
      return { ...defaultResult, output: raw };
    },
    async validateInstallation() {
      return { ok: true, version: '1.0.0' };
    },
  };
}

function makeConfig(overrides: Partial<RalphConfig> = {}): RalphConfig {
  return {
    agent: 'claude-code',
    loopMode: 'backlog',
    contextMode: 'continue',
    timeoutMinutes: 20,
    cbNoProgressThreshold: 3,
    cbSameErrorThreshold: 4,
    cbCooldownMinutes: 15,
    claimTtlMinutes: 45,
    verbose: false,
    ...overrides,
  };
}

function makePrd(storyCount = 2): PRD {
  return {
    version: '1.0',
    projectName: 'test-project',
    stories: Array.from({ length: storyCount }, (_, i) => ({
      id: `story-${i + 1}`,
      title: `Story ${i + 1}`,
      description: `Do thing ${i + 1}`,
      acceptanceCriteria: [`AC ${i + 1}`],
      priority: i + 1,
      status: 'active' as const,
      passes: false,
    })),
    qualityGates: {},
  };
}

function setupTmpDir(): string {
  const tmpDir = join(tmpdir(), `ralph-loop-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpDir, '.ralph'), { recursive: true });
  writeFileSync(join(tmpDir, '.ralph', 'prd.json'), JSON.stringify(makePrd()));
  writeFileSync(join(tmpDir, '.ralph', 'claims.json'), JSON.stringify({ claims: [] }));
  return tmpDir;
}

describe('RalphLoop', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = setupTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Basic loop behavior ---

  it('runs N iterations when maxIterations=N', async () => {
    writeFileSync(join(tmpDir, '.ralph', 'prd.json'), JSON.stringify(makePrd(5)));
    const agent = makeMockAgent();
    const loop = new RalphLoop({
      config: makeConfig({ maxIterations: 3 }),
      agent,
      projectDir: tmpDir,
    });

    const result = await loop.run();
    expect(result.state.iteration).toBe(3);
    expect(result.exitReason).toBe('max_iterations');
  });

  it('stops when stop is requested', async () => {
    const slowAgent: IAgent = {
      name: 'slow-mock',
      supportsSessionContinuity: true,
      supportsStructuredOutput: true,
      async run() {
        await new Promise(r => setTimeout(r, 50));
        return {
          output: 'done', exitCode: 0, usage: null,
          sessionId: null, isApiLimitHit: false, isRateLimitHit: false,
          rawJson: null, durationMs: 50,
        };
      },
      parseOutput(raw) {
        return { output: raw, exitCode: 0, usage: null, sessionId: null, isApiLimitHit: false, isRateLimitHit: false, rawJson: null, durationMs: 0 };
      },
      async validateInstallation() { return { ok: true, version: '1.0.0' }; },
    };

    writeFileSync(join(tmpDir, '.ralph', 'prd.json'), JSON.stringify(makePrd(20)));
    const loop = new RalphLoop({
      config: makeConfig({ maxIterations: 100 }),
      agent: slowAgent,
      projectDir: tmpDir,
    });

    setTimeout(() => loop.requestStop(), 30);

    const result = await loop.run();
    expect(result.exitReason).toBe('interrupted');
    expect(result.state.iteration).toBeLessThan(100);
  });

  it('records each iteration in state', async () => {
    const agent = makeMockAgent();
    const loop = new RalphLoop({
      config: makeConfig({ maxIterations: 2 }),
      agent,
      projectDir: tmpDir,
    });

    const result = await loop.run();
    expect(result.state.perIteration).toHaveLength(2);
    expect(result.state.perIteration[0].iteration).toBe(1);
    expect(result.state.perIteration[1].iteration).toBe(2);
  });

  it('stops when all stories are done', async () => {
    writeFileSync(join(tmpDir, '.ralph', 'prd.json'), JSON.stringify(makePrd(1)));
    const agent = makeMockAgent();
    const loop = new RalphLoop({
      config: makeConfig({ maxIterations: 10 }),
      agent,
      projectDir: tmpDir,
    });

    const result = await loop.run();
    expect(result.exitReason).toBe('converged');
    expect(result.state.iteration).toBeGreaterThanOrEqual(1);
  });

  // --- Budget enforcement ---

  it('exits when maxCostUsd exceeded', async () => {
    writeFileSync(join(tmpDir, '.ralph', 'prd.json'), JSON.stringify(makePrd(20)));
    const agent = makeMockAgent(Array(20).fill({
      usage: { inputTokens: 100000, outputTokens: 50000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }));
    const loop = new RalphLoop({
      config: makeConfig({ maxIterations: 20, maxCostUsd: 0.01 }),
      agent,
      projectDir: tmpDir,
    });

    const result = await loop.run();
    expect(result.exitReason).toBe('budget_exceeded');
    expect(result.state.iteration).toBeLessThan(20);
  });

  it('exits when maxTokensSession exceeded', async () => {
    writeFileSync(join(tmpDir, '.ralph', 'prd.json'), JSON.stringify(makePrd(20)));
    const agent = makeMockAgent(Array(20).fill({
      usage: { inputTokens: 5000, outputTokens: 5000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }));
    const loop = new RalphLoop({
      config: makeConfig({ maxIterations: 20, maxTokensSession: 15000 }),
      agent,
      projectDir: tmpDir,
    });

    const result = await loop.run();
    expect(result.exitReason).toBe('budget_exceeded');
    expect(result.state.iteration).toBeLessThanOrEqual(2);
  });

  // --- Circuit breaker integration ---

  it('exits when circuit breaker trips after repeated no-progress', async () => {
    writeFileSync(join(tmpDir, '.ralph', 'prd.json'), JSON.stringify(makePrd(20)));
    // Agent always fails — exitCode 1
    const agent = makeMockAgent(Array(20).fill({ exitCode: 1, output: 'error' }));
    const loop = new RalphLoop({
      config: makeConfig({ maxIterations: 20, cbNoProgressThreshold: 3 }),
      agent,
      projectDir: tmpDir,
    });

    const result = await loop.run();
    expect(result.exitReason).toBe('circuit_breaker_terminal');
    // Should stop after 3 no-progress iterations
    expect(result.state.iteration).toBe(3);
  });

  // --- Validation integration ---

  it('does not mark story done when agent exits non-zero', async () => {
    writeFileSync(join(tmpDir, '.ralph', 'prd.json'), JSON.stringify(makePrd(1)));
    const agent = makeMockAgent([{ exitCode: 1, output: 'failed' }]);
    const loop = new RalphLoop({
      config: makeConfig({ maxIterations: 1 }),
      agent,
      projectDir: tmpDir,
    });

    const result = await loop.run();
    expect(result.exitReason).toBe('no_progress');
    // Story should NOT pass — agent failed
  });

  it('stores validation result in state', async () => {
    writeFileSync(join(tmpDir, '.ralph', 'prd.json'), JSON.stringify(makePrd(5)));
    const agent = makeMockAgent();
    const loop = new RalphLoop({
      config: makeConfig({ maxIterations: 1 }),
      agent,
      projectDir: tmpDir,
    });

    const result = await loop.run();
    // Validation ran and was recorded
    expect(result.state.lastValidationResult).toBeDefined();
  });

  it('does not mark story done when quality gate fails', async () => {
    const prd = makePrd(1);
    prd.qualityGates = { test: 'exit 1' };
    writeFileSync(join(tmpDir, '.ralph', 'prd.json'), JSON.stringify(prd));

    const agent = makeMockAgent();
    const loop = new RalphLoop({
      config: makeConfig({ maxIterations: 1 }),
      agent,
      projectDir: tmpDir,
    });

    const result = await loop.run();
    expect(result.exitReason).toBe('no_progress');
    expect(result.state.lastValidationResult?.passed).toBe(false);
  });

  // --- Convergence behavior ---

  it('converges after multiple rounds when stories pass incrementally', async () => {
    // 2 stories: first call succeeds (story-1 passes), second fails (story-2 fails),
    // third call succeeds (story-2 passes in round 2) → converged
    writeFileSync(join(tmpDir, '.ralph', 'prd.json'), JSON.stringify(makePrd(2)));
    const agent = makeMockAgent([
      { exitCode: 0, output: 'fixed story 1' },   // round 1, story 1 → pass
      { exitCode: 1, output: 'failed story 2' },   // round 1, story 2 → fail
      { exitCode: 0, output: 'fixed story 2' },    // round 2, story 2 → pass
    ]);
    const loop = new RalphLoop({
      config: makeConfig({ maxIterations: 10, cbNoProgressThreshold: 100 }),
      agent,
      projectDir: tmpDir,
    });

    const result = await loop.run();
    expect(result.exitReason).toBe('converged');
    expect(result.state.iteration).toBe(3); // 2 in round 1 + 1 in round 2
  });

  it('exits with no_progress when a round makes zero fixes', async () => {
    writeFileSync(join(tmpDir, '.ralph', 'prd.json'), JSON.stringify(makePrd(2)));
    // Agent always fails — both stories fail in round 1
    const agent = makeMockAgent(Array(10).fill({ exitCode: 1, output: 'failed' }));
    const loop = new RalphLoop({
      config: makeConfig({
        maxIterations: 20,
        cbNoProgressThreshold: 100, // high so CB doesn't trip
        cbSameErrorThreshold: 100,
      }),
      agent,
      projectDir: tmpDir,
    });

    const result = await loop.run();
    expect(result.exitReason).toBe('no_progress');
    expect(result.state.iteration).toBe(2); // both stories attempted, both failed
  });

  it('skips stories that exceed storyMaxConsecutiveFailures', async () => {
    // 1 story that always fails → hits consecutiveFailures threshold → no workable stories
    writeFileSync(join(tmpDir, '.ralph', 'prd.json'), JSON.stringify(makePrd(1)));
    const agent = makeMockAgent(Array(10).fill({ exitCode: 1, output: 'always fails' }));
    const loop = new RalphLoop({
      config: makeConfig({
        maxIterations: 20,
        storyMaxConsecutiveFailures: 2,
        cbNoProgressThreshold: 100, // high so CB doesn't interfere
        cbSameErrorThreshold: 100,
      }),
      agent,
      projectDir: tmpDir,
    });

    const result = await loop.run();
    expect(result.exitReason).toBe('no_progress');
    // Should stop after 2 failures (the threshold), not run all 20 iterations
    expect(result.state.iteration).toBeLessThanOrEqual(2);
  });

  // --- Convergent mode ---

  it('convergent mode: runs all active stories each round', async () => {
    const prd = makePrd(3);
    writeFileSync(join(tmpDir, '.ralph', 'prd.json'), JSON.stringify(prd));

    let callCount = 0;
    const trackingAgent: IAgent = {
      name: 'tracking-agent',
      supportsSessionContinuity: true,
      supportsStructuredOutput: true,
      async run() {
        callCount++;
        return {
          output: 'done', exitCode: 0,
          usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
          sessionId: null, isApiLimitHit: false, isRateLimitHit: false, rawJson: null, durationMs: 100,
        };
      },
      parseOutput(raw) {
        return { output: raw, exitCode: 0, usage: null, sessionId: null, isApiLimitHit: false, isRateLimitHit: false, rawJson: null, durationMs: 0 };
      },
      async validateInstallation() { return { ok: true, version: '1.0.0' }; },
    };

    const loop = new RalphLoop({
      config: makeConfig({ loopMode: 'convergent', maxRounds: 1, maxIterations: 10 }),
      agent: trackingAgent,
      projectDir: tmpDir,
    });

    await loop.run();
    // In convergent mode round 1, all 3 active stories should be attempted
    expect(callCount).toBe(3);
  });

  it('convergent mode: converges when zero changes and all pass', async () => {
    // 2 stories, both pass in round 1; round 2 confirms zero changes → converged
    writeFileSync(join(tmpDir, '.ralph', 'prd.json'), JSON.stringify(makePrd(2)));
    const agent = makeMockAgent(Array(10).fill({
      exitCode: 0, output: 'all good',
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }));
    const loop = new RalphLoop({
      config: makeConfig({ loopMode: 'convergent', maxIterations: 20, cbNoProgressThreshold: 100 }),
      agent,
      projectDir: tmpDir,
    });

    const result = await loop.run();
    expect(result.exitReason).toBe('converged');
  });

  it('convergent mode: no_progress when zero changes but some still fail', async () => {
    writeFileSync(join(tmpDir, '.ralph', 'prd.json'), JSON.stringify(makePrd(2)));
    // All agent calls fail → round 1 has 0 fixes, but stories don't all pass → no_progress
    const agent = makeMockAgent(Array(10).fill({ exitCode: 1, output: 'failed' }));
    const loop = new RalphLoop({
      config: makeConfig({
        loopMode: 'convergent',
        maxIterations: 20,
        cbNoProgressThreshold: 100,
        cbSameErrorThreshold: 100,
      }),
      agent,
      projectDir: tmpDir,
    });

    const result = await loop.run();
    expect(result.exitReason).toBe('no_progress');
  });

  it('convergent mode: exits with no_progress when all stories exceed failure threshold', async () => {
    writeFileSync(join(tmpDir, '.ralph', 'prd.json'), JSON.stringify(makePrd(1)));
    const agent = makeMockAgent(Array(10).fill({ exitCode: 1, output: 'always fails' }));
    const loop = new RalphLoop({
      config: makeConfig({
        loopMode: 'convergent',
        maxIterations: 20,
        storyMaxConsecutiveFailures: 2,
        cbNoProgressThreshold: 100,
        cbSameErrorThreshold: 100,
      }),
      agent,
      projectDir: tmpDir,
    });

    const result = await loop.run();
    expect(result.exitReason).toBe('no_progress');
    expect(result.state.iteration).toBeLessThanOrEqual(2);
  });

  // --- maxRounds ---

  it('exits when maxRounds is exceeded', async () => {
    writeFileSync(join(tmpDir, '.ralph', 'prd.json'), JSON.stringify(makePrd(1)));
    // Agent always succeeds but story keeps getting reset (simulated by always failing exit code 1 on even calls)
    let callIdx = 0;
    const flipAgent: IAgent = {
      name: 'flip-agent',
      supportsSessionContinuity: true,
      supportsStructuredOutput: true,
      async run() {
        callIdx++;
        return {
          output: 'done', exitCode: callIdx % 2 === 1 ? 0 : 1,
          usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
          sessionId: null, isApiLimitHit: false, isRateLimitHit: false, rawJson: null, durationMs: 100,
        };
      },
      parseOutput(raw) {
        return { output: raw, exitCode: 0, usage: null, sessionId: null, isApiLimitHit: false, isRateLimitHit: false, rawJson: null, durationMs: 0 };
      },
      async validateInstallation() { return { ok: true, version: '1.0.0' }; },
    };

    const loop = new RalphLoop({
      config: makeConfig({ maxRounds: 2, maxIterations: 20, cbNoProgressThreshold: 100, cbSameErrorThreshold: 100 }),
      agent: flipAgent,
      projectDir: tmpDir,
    });

    const result = await loop.run();
    expect(result.exitReason).toBe('max_iterations'); // maxRounds maps to max_iterations exit
  });

  // --- Parallel group execution ---

  it('runs stories in same group concurrently via Promise.all', async () => {
    const prd = makePrd(3);
    // Put all 3 stories in the same group
    prd.stories[0].group = 1;
    prd.stories[1].group = 1;
    prd.stories[2].group = 1;
    writeFileSync(join(tmpDir, '.ralph', 'prd.json'), JSON.stringify(prd));

    const runningConcurrently: number[] = [];
    let activeCount = 0;

    const concurrentAgent: IAgent = {
      name: 'concurrent-agent',
      supportsSessionContinuity: true,
      supportsStructuredOutput: true,
      async run() {
        activeCount++;
        runningConcurrently.push(activeCount);
        await new Promise(r => setTimeout(r, 50));
        activeCount--;
        return {
          output: 'done', exitCode: 0,
          usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
          sessionId: null, isApiLimitHit: false, isRateLimitHit: false, rawJson: null, durationMs: 50,
        };
      },
      parseOutput(raw) {
        return { output: raw, exitCode: 0, usage: null, sessionId: null, isApiLimitHit: false, isRateLimitHit: false, rawJson: null, durationMs: 0 };
      },
      async validateInstallation() { return { ok: true, version: '1.0.0' }; },
    };

    const loop = new RalphLoop({
      config: makeConfig({ maxIterations: 10 }),
      agent: concurrentAgent,
      projectDir: tmpDir,
    });

    const result = await loop.run();
    expect(result.exitReason).toBe('converged');
    // At some point, multiple agents should have been running simultaneously
    expect(Math.max(...runningConcurrently)).toBeGreaterThan(1);
  });

  it('runs different groups sequentially', async () => {
    const prd = makePrd(2);
    prd.stories[0].group = 1;
    prd.stories[1].group = 2;
    writeFileSync(join(tmpDir, '.ralph', 'prd.json'), JSON.stringify(prd));

    const callOrder: string[] = [];

    const orderAgent: IAgent = {
      name: 'order-agent',
      supportsSessionContinuity: true,
      supportsStructuredOutput: true,
      async run(options) {
        // Extract story id from prompt - stories are identified by their id in the prompt
        const match = options.prompt.match(/\[story-(\d+)\]/);
        const id = match ? `story-${match[1]}` : 'unknown';
        callOrder.push(`start-${id}`);
        await new Promise(r => setTimeout(r, 20));
        callOrder.push(`end-${id}`);
        return {
          output: 'done', exitCode: 0,
          usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
          sessionId: null, isApiLimitHit: false, isRateLimitHit: false, rawJson: null, durationMs: 20,
        };
      },
      parseOutput(raw) {
        return { output: raw, exitCode: 0, usage: null, sessionId: null, isApiLimitHit: false, isRateLimitHit: false, rawJson: null, durationMs: 0 };
      },
      async validateInstallation() { return { ok: true, version: '1.0.0' }; },
    };

    const loop = new RalphLoop({
      config: makeConfig({ maxIterations: 10 }),
      agent: orderAgent,
      projectDir: tmpDir,
    });

    await loop.run();
    // Group 1 (story-1) should finish before group 2 (story-2) starts
    // Since they're in different groups, they run sequentially
    expect(callOrder.length).toBe(4);
    // First group finishes before second starts
    const endFirst = callOrder.indexOf('end-story-1');
    const startSecond = callOrder.indexOf('start-story-2');
    if (endFirst >= 0 && startSecond >= 0) {
      expect(endFirst).toBeLessThan(startSecond);
    }
  });

  it('re-evaluates passing stories when quality gates fail at round start', async () => {
    // Use a file-based gate: passes when marker file exists, fails when it doesn't
    const markerFile = join(tmpDir, 'gate-marker');
    // Create the marker so first-round validation passes
    writeFileSync(markerFile, '');

    const prd = makePrd(2);
    prd.qualityGates = { check: `test -f "${markerFile}"` };
    writeFileSync(join(tmpDir, '.ralph', 'prd.json'), JSON.stringify(prd));

    // Round 1: both stories pass (gate passes because marker exists)
    // Agent call 2 removes marker file to simulate regression
    // Round 2 start: reEvaluatePassingStories runs gate → fails → flips stories back
    // Round 2: agent recreates marker, stories pass again → converged
    let callCount = 0;
    const trickAgent: IAgent = {
      name: 'trick-agent',
      supportsSessionContinuity: true,
      supportsStructuredOutput: true,
      async run() {
        callCount++;
        if (callCount === 2) {
          // Second call: story-2 succeeds, but remove marker to trigger regression at round 2 start
          const { unlinkSync } = await import('node:fs');
          try { unlinkSync(markerFile); } catch {}
          return {
            output: 'done', exitCode: 0,
            usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
            sessionId: null, isApiLimitHit: false, isRateLimitHit: false, rawJson: null, durationMs: 100,
          };
        } else {
          // All other calls succeed; recreate marker if needed so gate passes
          const { writeFileSync: wfs, existsSync: es } = await import('node:fs');
          if (!es(markerFile)) wfs(markerFile, '');
          return {
            output: 'done', exitCode: 0,
            usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
            sessionId: null, isApiLimitHit: false, isRateLimitHit: false, rawJson: null, durationMs: 100,
          };
        }
      },
      parseOutput(raw) {
        return { output: raw, exitCode: 0, usage: null, sessionId: null, isApiLimitHit: false, isRateLimitHit: false, rawJson: null, durationMs: 0 };
      },
      async validateInstallation() { return { ok: true, version: '1.0.0' }; },
    };

    const loop = new RalphLoop({
      config: makeConfig({ maxIterations: 10, cbNoProgressThreshold: 100, cbSameErrorThreshold: 100 }),
      agent: trickAgent,
      projectDir: tmpDir,
    });

    const result = await loop.run();
    // Should eventually converge after regression is detected and re-fixed
    expect(result.exitReason).toBe('converged');
    // More than 2 iterations means round 2+ happened (regression was detected and re-fixed)
    expect(result.state.iteration).toBeGreaterThan(2);
  });
});
