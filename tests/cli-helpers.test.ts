import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveProjectDir, getWorkspaceDir, getRunsDir, findLatestRun, loadRunState } from '../src/cli/helpers.js';

describe('CLI helpers', () => {
  let tmpDir: string;
  const ws = 'test-ws';

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ralphx-helpers-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('resolveProjectDir', () => {
    it('returns current working directory', () => {
      expect(resolveProjectDir()).toBe(process.cwd());
    });
  });

  describe('getWorkspaceDir', () => {
    it('returns .ralphx/<workspace> subdirectory of project', () => {
      expect(getWorkspaceDir('/foo/bar', 'my-ws')).toBe('/foo/bar/.ralphx/my-ws');
    });
  });

  describe('getRunsDir', () => {
    it('returns .ralphx/<workspace>/runs subdirectory', () => {
      expect(getRunsDir('/foo/bar', 'my-ws')).toBe('/foo/bar/.ralphx/my-ws/runs');
    });
  });

  describe('findLatestRun', () => {
    it('returns null when runs directory does not exist', () => {
      expect(findLatestRun(tmpDir, ws)).toBeNull();
    });

    it('returns null when runs directory is empty', () => {
      mkdirSync(join(tmpDir, '.ralphx', ws, 'runs'), { recursive: true });
      expect(findLatestRun(tmpDir, ws)).toBeNull();
    });

    it('returns the most recently updated run', () => {
      const runsDir = join(tmpDir, '.ralphx', ws, 'runs');
      mkdirSync(runsDir, { recursive: true });

      const run1Dir = join(runsDir, 'run-old');
      mkdirSync(run1Dir);
      writeFileSync(join(run1Dir, 'run-state.json'), JSON.stringify({
        runId: 'run-old', updatedAt: '2026-01-01T00:00:00Z',
      }));

      const run2Dir = join(runsDir, 'run-new');
      mkdirSync(run2Dir);
      writeFileSync(join(run2Dir, 'run-state.json'), JSON.stringify({
        runId: 'run-new', updatedAt: '2026-03-01T00:00:00Z',
      }));

      expect(findLatestRun(tmpDir, ws)).toBe('run-new');
    });

    it('skips runs without run-state.json', () => {
      const runsDir = join(tmpDir, '.ralphx', ws, 'runs');
      mkdirSync(runsDir, { recursive: true });

      // Run with no state file
      mkdirSync(join(runsDir, 'broken-run'));

      // Run with state file
      const goodDir = join(runsDir, 'good-run');
      mkdirSync(goodDir);
      writeFileSync(join(goodDir, 'run-state.json'), JSON.stringify({
        runId: 'good-run', updatedAt: '2026-01-01T00:00:00Z',
      }));

      expect(findLatestRun(tmpDir, ws)).toBe('good-run');
    });

    it('handles corrupted run-state.json gracefully', () => {
      const runsDir = join(tmpDir, '.ralphx', ws, 'runs');
      mkdirSync(runsDir, { recursive: true });

      const badDir = join(runsDir, 'bad-run');
      mkdirSync(badDir);
      writeFileSync(join(badDir, 'run-state.json'), 'not json{{{');

      const goodDir = join(runsDir, 'good-run');
      mkdirSync(goodDir);
      writeFileSync(join(goodDir, 'run-state.json'), JSON.stringify({
        runId: 'good-run', updatedAt: '2026-02-01T00:00:00Z',
      }));

      // Should skip corrupted and return good one
      expect(findLatestRun(tmpDir, ws)).toBe('good-run');
    });

    it('returns null when runs directory cannot be read', () => {
      const runsDir = join(tmpDir, '.ralphx', ws, 'runs');
      mkdirSync(runsDir, { recursive: true });
      // Create a file (not a directory) where runs dir expects a readable dir
      // Simulate by making runsDir a file after removing it
      rmSync(runsDir, { recursive: true });
      writeFileSync(runsDir, 'not a directory');

      // existsSync returns true (path exists) but readdirSync will throw
      expect(findLatestRun(tmpDir, ws)).toBeNull();
    });

    it('returns run with missing updatedAt field', () => {
      const runsDir = join(tmpDir, '.ralphx', ws, 'runs');
      mkdirSync(runsDir, { recursive: true });

      const runDir = join(runsDir, 'no-date');
      mkdirSync(runDir);
      writeFileSync(join(runDir, 'run-state.json'), JSON.stringify({ runId: 'no-date' }));

      expect(findLatestRun(tmpDir, ws)).toBe('no-date');
    });
  });

  describe('getWorkspaceDir with different workspaces', () => {
    it('returns different paths for different workspace names', () => {
      const dir1 = getWorkspaceDir('/project', 'alpha');
      const dir2 = getWorkspaceDir('/project', 'beta');
      expect(dir1).toBe('/project/.ralphx/alpha');
      expect(dir2).toBe('/project/.ralphx/beta');
      expect(dir1).not.toBe(dir2);
    });
  });

  describe('loadRunState', () => {
    it('returns null when run does not exist', () => {
      mkdirSync(join(tmpDir, '.ralphx', ws, 'runs'), { recursive: true });
      expect(loadRunState(tmpDir, ws, 'nonexistent')).toBeNull();
    });

    it('returns parsed state for existing run', () => {
      const runDir = join(tmpDir, '.ralphx', ws, 'runs', 'test-run');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'run-state.json'), JSON.stringify({
        runId: 'test-run',
        status: 'running',
        iteration: 5,
        cost: { estimatedCostUsd: 1.23 },
      }));

      const state = loadRunState(tmpDir, ws, 'test-run');
      expect(state).not.toBeNull();
      expect(state!.runId).toBe('test-run');
      expect(state!.status).toBe('running');
      expect(state!.iteration).toBe(5);
    });

    it('returns null for corrupted state file', () => {
      const runDir = join(tmpDir, '.ralphx', ws, 'runs', 'bad-run');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'run-state.json'), '{not valid json');

      expect(loadRunState(tmpDir, ws, 'bad-run')).toBeNull();
    });

    it('returns state with all optional fields', () => {
      const runDir = join(tmpDir, '.ralphx', ws, 'runs', 'full-run');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'run-state.json'), JSON.stringify({
        runId: 'full-run',
        status: 'complete',
        iteration: 10,
        agent: 'claude-code',
        cost: {
          estimatedCostUsd: 2.34,
          totalInputTokens: 50000,
          totalOutputTokens: 25000,
          totalCacheReadTokens: 1000,
          totalCacheWriteTokens: 500,
        },
        startedAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T01:00:00Z',
        currentStoryTitle: 'Add login',
        exitReason: 'converged',
        perIteration: [],
      }));

      const state = loadRunState(tmpDir, ws, 'full-run');
      expect(state).not.toBeNull();
      expect(state!.exitReason).toBe('converged');
      expect(state!.currentStoryTitle).toBe('Add login');
    });
  });
});
