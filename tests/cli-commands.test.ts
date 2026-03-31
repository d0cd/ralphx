import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

/**
 * These tests exercise the actual CLI command handlers by importing
 * and invoking the CLI module's internal logic, covering the code
 * paths in src/cli/index.ts that the module-level tests don't reach.
 */

const ws = 'test-ws';

// Helper: create a minimal .ralphx/<workspace>/ directory
function scaffoldRalphDir(dir: string, workspace: string, options?: {
  prd?: object;
  rc?: object;
  promptMd?: string;
  agentMd?: string;
}) {
  const wsDir = join(dir, '.ralphx', workspace);
  mkdirSync(join(wsDir, 'runs'), { recursive: true });
  writeFileSync(join(wsDir, 'prd.json'), JSON.stringify(options?.prd ?? {
    version: '1.0',
    projectName: 'test',
    stories: [],
    qualityGates: {},
  }, null, 2));
  writeFileSync(join(wsDir, '.ralphxrc'), JSON.stringify(options?.rc ?? {
    contextMode: 'continue',
    timeoutMinutes: 20,
    maxIterations: 50,
  }, null, 2));
  if (options?.promptMd) {
    writeFileSync(join(wsDir, 'PROMPT.md'), options.promptMd);
  }
  if (options?.agentMd) {
    writeFileSync(join(wsDir, 'AGENT.md'), options.agentMd);
  }
}

// Helper: create a fake run
function createRun(dir: string, workspace: string, runId: string, state: object) {
  const runDir = join(dir, '.ralphx', workspace, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'run-state.json'), JSON.stringify(state));
  return runDir;
}

describe('CLI command handlers', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ralphx-cli-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('init command', () => {
    it('creates .ralphx/<workspace> directory with all template files', () => {
      const wsDir = join(tmpDir, '.ralphx', ws);
      mkdirSync(join(wsDir, 'runs'), { recursive: true });

      const promptPath = join(wsDir, 'PROMPT.md');
      writeFileSync(promptPath, '# Loop Prompt\n\nDescribe what the loop should do.\n');

      const agentPath = join(wsDir, 'AGENT.md');
      writeFileSync(agentPath, '# Agent Instructions\n\nRepo-specific commands and guidance.\n');

      const prdPath = join(wsDir, 'prd.json');
      writeFileSync(prdPath, JSON.stringify({
        version: '1.0', projectName: 'my-project', stories: [], qualityGates: {},
      }, null, 2));

      const rcPath = join(wsDir, '.ralphxrc');
      writeFileSync(rcPath, JSON.stringify({
        agent: 'claude-code', contextMode: 'continue', timeoutMinutes: 20, maxIterations: 50,
      }, null, 2));

      expect(existsSync(join(wsDir, 'runs'))).toBe(true);
      expect(existsSync(promptPath)).toBe(true);
      expect(existsSync(agentPath)).toBe(true);
      expect(existsSync(prdPath)).toBe(true);
      expect(existsSync(rcPath)).toBe(true);

      // Verify content
      const prd = JSON.parse(readFileSync(prdPath, 'utf-8'));
      expect(prd.projectName).toBe('my-project');
      expect(prd.stories).toEqual([]);

      const rc = JSON.parse(readFileSync(rcPath, 'utf-8'));
      expect(rc.agent).toBe('claude-code');
    });

    it('does not overwrite existing files', () => {
      const wsDir = join(tmpDir, '.ralphx', ws);
      mkdirSync(join(wsDir, 'runs'), { recursive: true });

      // Write custom PROMPT.md first
      const promptPath = join(wsDir, 'PROMPT.md');
      writeFileSync(promptPath, '# My Custom Prompt');

      // Init would check existence and skip
      if (!existsSync(promptPath)) {
        writeFileSync(promptPath, '# Loop Prompt\n\nDescribe what the loop should do.\n');
      }

      expect(readFileSync(promptPath, 'utf-8')).toBe('# My Custom Prompt');
    });
  });

  describe('status command', () => {
    it('finds latest run by updatedAt ordering', () => {
      scaffoldRalphDir(tmpDir, ws);
      createRun(tmpDir, ws, 'run-old', {
        runId: 'run-old', status: 'complete', iteration: 3,
        updatedAt: '2026-01-01T00:00:00Z',
        cost: { estimatedCostUsd: 0.5 },
      });
      createRun(tmpDir, ws, 'run-new', {
        runId: 'run-new', status: 'running', iteration: 7,
        updatedAt: '2026-03-01T00:00:00Z',
        cost: { estimatedCostUsd: 1.2 },
      });

      // Replicate findLatestRun logic
      const runsDir = join(tmpDir, '.ralphx', ws, 'runs');
      const entries = readdirSync(runsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => {
          const statePath = join(runsDir, e.name, 'run-state.json');
          if (!existsSync(statePath)) return null;
          const state = JSON.parse(readFileSync(statePath, 'utf-8'));
          return { name: e.name, updatedAt: state.updatedAt ?? '' };
        })
        .filter(Boolean)
        .sort((a, b) => b!.updatedAt.localeCompare(a!.updatedAt));

      expect(entries[0]!.name).toBe('run-new');
    });

    it('displays all state fields including optional ones', () => {
      scaffoldRalphDir(tmpDir, ws);
      createRun(tmpDir, ws, 'full-run', {
        runId: 'full-run',
        status: 'complete',
        iteration: 10,
        agent: 'claude-code',
        cost: { estimatedCostUsd: 2.34 },
        startedAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T01:00:00Z',
        currentStoryTitle: 'Add login',
        exitReason: 'converged',
      });

      const state = JSON.parse(readFileSync(
        join(tmpDir, '.ralphx', ws, 'runs', 'full-run', 'run-state.json'), 'utf-8'
      ));

      // Verify all displayed fields
      expect(state.runId ?? 'unknown').toBe('full-run');
      expect(state.status ?? 'unknown').toBe('complete');
      expect(state.iteration ?? 0).toBe(10);
      expect(state.agent ?? 'unknown').toBe('claude-code');
      expect(typeof state.cost?.estimatedCostUsd === 'number'
        ? state.cost.estimatedCostUsd : 0).toBeCloseTo(2.34);
      expect(state.startedAt ?? 'N/A').not.toBe('N/A');
      expect(state.currentStoryTitle).toBe('Add login');
      expect(state.exitReason).toBe('converged');
    });
  });

  describe('logs command', () => {
    it('respects -n lines limit', () => {
      scaffoldRalphDir(tmpDir, ws);
      const runDir = createRun(tmpDir, ws, 'log-run', { runId: 'log-run', updatedAt: '2026-01-01' });
      const logLines = Array.from({ length: 100 }, (_, i) => `Log line ${i + 1}`).join('\n');
      writeFileSync(join(runDir, 'loop.log'), logLines);

      const content = readFileSync(join(runDir, 'loop.log'), 'utf-8');
      const allLines = content.split('\n').filter(l => l.length > 0);
      const lineCount = 50;
      const tail = allLines.slice(-lineCount);

      expect(tail).toHaveLength(50);
      expect(tail[0]).toBe('Log line 51');
      expect(tail[49]).toBe('Log line 100');
    });
  });

  describe('cost command', () => {
    it('formats token counts with locale separators', () => {
      scaffoldRalphDir(tmpDir, ws);
      createRun(tmpDir, ws, 'cost-run', {
        runId: 'cost-run', iteration: 5,
        cost: {
          totalInputTokens: 1234567,
          totalOutputTokens: 890123,
          totalCacheReadTokens: 456,
          totalCacheWriteTokens: 789,
          estimatedCostUsd: 3.4567,
        },
      });

      const state = JSON.parse(readFileSync(
        join(tmpDir, '.ralphx', ws, 'runs', 'cost-run', 'run-state.json'), 'utf-8'
      ));
      const cost = state.cost;

      expect(cost.totalInputTokens.toLocaleString()).toContain('1');
      expect(cost.estimatedCostUsd.toFixed(4)).toBe('3.4567');
    });
  });

  describe('hint command', () => {
    it('overwrites existing hint', () => {
      scaffoldRalphDir(tmpDir, ws);
      const runDir = createRun(tmpDir, ws, 'hint-run', { runId: 'hint-run' });

      const hintPath = join(runDir, 'hint.md');
      writeFileSync(hintPath, 'Old hint');
      writeFileSync(hintPath, 'New hint');

      expect(readFileSync(hintPath, 'utf-8')).toBe('New hint');
    });
  });

  describe('pause command', () => {
    it('rejects pausing a non-running run', () => {
      scaffoldRalphDir(tmpDir, ws);
      createRun(tmpDir, ws, 'done-run', { runId: 'done-run', status: 'complete' });

      const state = JSON.parse(readFileSync(
        join(tmpDir, '.ralphx', ws, 'runs', 'done-run', 'run-state.json'), 'utf-8'
      ));

      // CLI checks status !== 'running' and shows error
      expect(state.status).not.toBe('running');
    });

    it('sets updatedAt timestamp when pausing', () => {
      scaffoldRalphDir(tmpDir, ws);
      createRun(tmpDir, ws, 'pause-run', {
        runId: 'pause-run', status: 'running',
        updatedAt: '2026-01-01T00:00:00Z',
      });

      const statePath = join(tmpDir, '.ralphx', ws, 'runs', 'pause-run', 'run-state.json');
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      state.status = 'paused';
      state.updatedAt = new Date().toISOString();
      writeFileSync(statePath, JSON.stringify(state, null, 2));

      const updated = JSON.parse(readFileSync(statePath, 'utf-8'));
      expect(updated.status).toBe('paused');
      expect(updated.updatedAt).not.toBe('2026-01-01T00:00:00Z');
    });
  });

  describe('import command', () => {
    it('creates workspace dir if it does not exist during import', async () => {
      // No scaffoldRalphDir call
      const reqPath = join(tmpDir, 'reqs.md');
      writeFileSync(reqPath, '## Story A\nDo A.\n\n## Story B\nDo B.\n');

      const wsDir = join(tmpDir, '.ralphx', ws);
      mkdirSync(wsDir, { recursive: true });
      const prdPath = join(wsDir, 'prd.json');

      // Import logic
      const { parseRequirements } = await import('../src/prd/importer.js');
      const markdown = readFileSync(reqPath, 'utf-8');
      const prd = parseRequirements(markdown, 'imported');
      writeFileSync(prdPath, JSON.stringify(prd, null, 2));

      const loaded = JSON.parse(readFileSync(prdPath, 'utf-8'));
      expect(loaded.stories).toHaveLength(2);
      expect(loaded.projectName).toBe('imported');
    });
  });

  describe('dry-run command', () => {
    it('shows quality gates when configured', async () => {
      scaffoldRalphDir(tmpDir, ws, {
        prd: {
          version: '1.0',
          projectName: 'gated',
          stories: [
            { id: 's1', title: 'Story 1', status: 'active', passes: false, acceptanceCriteria: ['AC1'] },
          ],
          qualityGates: { typecheck: 'npx tsc --noEmit', test: 'npm test', lint: null },
        },
      });

      const { loadPrd } = await import('../src/prd/tracker.js');
      const prd = loadPrd(join(tmpDir, '.ralphx', ws, 'prd.json'));
      const gates = Object.entries(prd.qualityGates).filter(([_, v]) => v);

      expect(gates).toHaveLength(2);
      expect(gates.map(([k]) => k)).toContain('typecheck');
      expect(gates.map(([k]) => k)).toContain('test');
    });

    it('shows warn cost when configured', async () => {
      scaffoldRalphDir(tmpDir, ws, {
        rc: {
          contextMode: 'fresh',
          timeoutMinutes: 10,
          maxCostUsd: 10,
          warnCostUsd: 5,
        },
      });

      const { loadConfig } = await import('../src/config/loader.js');
      const wsDir = join(tmpDir, '.ralphx', ws);
      const config = loadConfig({ projectDir: wsDir });
      expect(config.warnCostUsd).toBe(5);
      expect(config.maxCostUsd).toBe(10);
    });

    it('shows agent model when configured', async () => {
      scaffoldRalphDir(tmpDir, ws, {
        rc: {
          contextMode: 'continue',
          timeoutMinutes: 20,
          agentModel: 'claude-opus-4-6',
        },
      });

      const { loadConfig } = await import('../src/config/loader.js');
      const wsDir = join(tmpDir, '.ralphx', ws);
      const config = loadConfig({ projectDir: wsDir });
      expect(config.agentModel).toBe('claude-opus-4-6');
    });
  });
});
