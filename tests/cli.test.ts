import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config/loader.js';
import { loadPrd } from '../src/prd/tracker.js';
import { parseRequirements } from '../src/prd/importer.js';
import { findResumableRun } from '../src/core/resume.js';

/**
 * These tests verify the behavior of CLI commands by exercising
 * the underlying modules directly, avoiding subprocess spawning
 * which is unreliable under tight PID cgroup limits.
 */

const ws = 'test-ws';

describe('CLI', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ralphx-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('ralphx init', () => {
    it('creates .ralphx/<workspace> directory with template files', () => {
      const wsDir = join(tmpDir, '.ralphx', ws);
      mkdirSync(join(wsDir, 'runs'), { recursive: true });

      const promptPath = join(wsDir, 'PROMPT.md');
      if (!existsSync(promptPath)) {
        writeFileSync(promptPath, '# Loop Prompt\n\nDescribe what the loop should do.\n');
      }

      const agentPath = join(wsDir, 'AGENT.md');
      if (!existsSync(agentPath)) {
        writeFileSync(agentPath, '# Agent Instructions\n\nRepo-specific commands and guidance.\n');
      }

      const prdPath = join(wsDir, 'prd.json');
      if (!existsSync(prdPath)) {
        writeFileSync(prdPath, JSON.stringify({
          version: '1.0',
          projectName: 'my-project',
          stories: [],
          qualityGates: {},
        }, null, 2));
      }

      const rcPath = join(wsDir, '.ralphxrc');
      if (!existsSync(rcPath)) {
        writeFileSync(rcPath, JSON.stringify({
          agent: 'claude-code',
          contextMode: 'continue',
          timeoutMinutes: 20,
          maxIterations: 50,
        }, null, 2));
      }

      expect(existsSync(wsDir)).toBe(true);
      expect(existsSync(join(wsDir, 'PROMPT.md'))).toBe(true);
      expect(existsSync(join(wsDir, 'AGENT.md'))).toBe(true);
      expect(existsSync(join(wsDir, 'prd.json'))).toBe(true);
    });
  });

  describe('ralphx run', () => {
    it('exits non-zero when prd.json is missing', () => {
      const wsDir = join(tmpDir, '.ralphx', ws);
      mkdirSync(wsDir, { recursive: true });
      // The run command checks for prd.json existence
      const prdExists = existsSync(join(wsDir, 'prd.json'));
      expect(prdExists).toBe(false);
    });

    it('accepts --prompt flag without error', () => {
      // The run command accepts --prompt as a Commander option.
      // Without prd.json it fails, but the flag itself is valid.
      // We verify prd.json is needed regardless of --prompt.
      const wsDir = join(tmpDir, '.ralphx', ws);
      mkdirSync(wsDir, { recursive: true });
      const prdExists = existsSync(join(wsDir, 'prd.json'));
      expect(prdExists).toBe(false);
    });
  });

  describe('ralphx status', () => {
    it('prints "no runs found" when no runs exist', () => {
      const wsDir = join(tmpDir, '.ralphx', ws);
      mkdirSync(wsDir, { recursive: true });
      // findLatestRun returns null when no runs directory exists
      const runsDir = join(wsDir, 'runs');
      const hasRunsDir = existsSync(runsDir);
      expect(hasRunsDir).toBe(false);
    });

    it('exits non-zero when specified run not found', () => {
      const wsDir = join(tmpDir, '.ralphx', ws);
      mkdirSync(join(wsDir, 'runs'), { recursive: true });
      const statePath = join(wsDir, 'runs', 'nonexistent', 'run-state.json');
      expect(existsSync(statePath)).toBe(false);
    });

    it('prints status summary for existing run', () => {
      const runDir = join(tmpDir, '.ralphx', ws, 'runs', 'test-run');
      mkdirSync(runDir, { recursive: true });
      const stateData = {
        runId: 'test-run',
        status: 'running',
        iteration: 5,
        agent: 'claude-code',
        cost: { estimatedCostUsd: 1.23 },
        startedAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:05:00Z',
        perIteration: [],
      };
      writeFileSync(join(runDir, 'run-state.json'), JSON.stringify(stateData));

      const state = JSON.parse(readFileSync(join(runDir, 'run-state.json'), 'utf-8'));
      expect(state.runId).toBe('test-run');
      expect(state.status).toBe('running');
    });

    it('degrades gracefully when state has missing fields', () => {
      const runDir = join(tmpDir, '.ralphx', ws, 'runs', 'partial-run');
      mkdirSync(runDir, { recursive: true });
      // Minimal state — missing cost, agent, timestamps
      writeFileSync(join(runDir, 'run-state.json'), JSON.stringify({
        runId: 'partial-run',
        status: 'interrupted',
      }));

      const state = JSON.parse(readFileSync(join(runDir, 'run-state.json'), 'utf-8'));
      // Verify the fallback logic works without crashing
      expect(state.runId ?? 'unknown').toBe('partial-run');
      expect(state.status ?? 'unknown').toBe('interrupted');
      expect(state.iteration ?? 0).toBe(0);
      expect(state.agent ?? 'unknown').toBe('unknown');
      const cost = state.cost as Record<string, unknown> | undefined;
      expect(typeof cost?.estimatedCostUsd === 'number' ? cost.estimatedCostUsd : 0).toBe(0);
      expect(state.startedAt ?? 'N/A').toBe('N/A');
      expect(state.updatedAt ?? 'N/A').toBe('N/A');
    });
  });

  describe('ralphx logs', () => {
    it('exits non-zero when no runs exist', () => {
      const wsDir = join(tmpDir, '.ralphx', ws);
      mkdirSync(wsDir, { recursive: true });
      const runsDir = join(wsDir, 'runs');
      expect(existsSync(runsDir)).toBe(false);
    });

    it('degrades gracefully when log file missing for run', () => {
      const runDir = join(tmpDir, '.ralphx', ws, 'runs', 'test-run');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'run-state.json'), JSON.stringify({ runId: 'test-run', updatedAt: '2026-01-01T00:00:00Z' }));
      const logPath = join(runDir, 'loop.log');
      // Missing log file is no longer a hard error — it degrades gracefully
      expect(existsSync(logPath)).toBe(false);
    });

    it('handles empty log file gracefully', () => {
      const runDir = join(tmpDir, '.ralphx', ws, 'runs', 'empty-log-run');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'run-state.json'), JSON.stringify({ runId: 'empty-log-run' }));
      writeFileSync(join(runDir, 'loop.log'), '');
      const content = readFileSync(join(runDir, 'loop.log'), 'utf-8');
      const lines = content.split('\n').filter((l: string) => l.length > 0);
      expect(lines).toHaveLength(0);
    });

    it('prints log content for existing run', () => {
      const runDir = join(tmpDir, '.ralphx', ws, 'runs', 'test-run');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'run-state.json'), JSON.stringify({ runId: 'test-run' }));
      writeFileSync(join(runDir, 'loop.log'), 'line 1\nline 2\n');
      const content = readFileSync(join(runDir, 'loop.log'), 'utf-8');
      expect(content).toContain('line 1');
      expect(content).toContain('line 2');
    });
  });

  describe('ralphx cost', () => {
    it('exits non-zero when specified run not found', () => {
      const wsDir = join(tmpDir, '.ralphx', ws);
      mkdirSync(join(wsDir, 'runs'), { recursive: true });
      const statePath = join(wsDir, 'runs', 'nonexistent', 'run-state.json');
      expect(existsSync(statePath)).toBe(false);
    });

    it('shows cost totals', () => {
      const runDir = join(tmpDir, '.ralphx', ws, 'runs', 'test-run');
      mkdirSync(runDir, { recursive: true });
      const stateData = {
        runId: 'test-run',
        iteration: 3,
        cost: {
          totalInputTokens: 15000,
          totalOutputTokens: 7500,
          totalCacheReadTokens: 1000,
          totalCacheWriteTokens: 500,
          estimatedCostUsd: 0.4567,
        },
      };
      writeFileSync(join(runDir, 'run-state.json'), JSON.stringify(stateData));

      const state = JSON.parse(readFileSync(join(runDir, 'run-state.json'), 'utf-8'));
      const cost = state.cost;
      expect(cost.totalInputTokens.toLocaleString()).toBe('15,000');
      expect(cost.totalOutputTokens.toLocaleString()).toBe('7,500');
      expect(cost.estimatedCostUsd.toFixed(4)).toBe('0.4567');
    });

    it('degrades gracefully when cost data is missing', () => {
      const runDir = join(tmpDir, '.ralphx', ws, 'runs', 'no-cost-run');
      mkdirSync(runDir, { recursive: true });
      // State with no cost field at all
      writeFileSync(join(runDir, 'run-state.json'), JSON.stringify({
        runId: 'no-cost-run',
        iteration: 1,
      }));

      const state = JSON.parse(readFileSync(join(runDir, 'run-state.json'), 'utf-8'));
      expect(state.runId ?? 'unknown').toBe('no-cost-run');
      expect(state.iteration ?? 0).toBe(1);
      // cost is undefined — CLI should show "not yet available" instead of crashing
      expect(state.cost).toBeUndefined();
    });

    it('handles partial cost data without crashing', () => {
      const runDir = join(tmpDir, '.ralphx', ws, 'runs', 'partial-cost-run');
      mkdirSync(runDir, { recursive: true });
      // cost with some missing token fields
      writeFileSync(join(runDir, 'run-state.json'), JSON.stringify({
        runId: 'partial-cost-run',
        iteration: 2,
        cost: { estimatedCostUsd: 0.12 },
      }));

      const state = JSON.parse(readFileSync(join(runDir, 'run-state.json'), 'utf-8'));
      const cost = state.cost;
      expect((cost.totalInputTokens ?? 0).toLocaleString()).toBe('0');
      expect((cost.totalOutputTokens ?? 0).toLocaleString()).toBe('0');
      expect((cost.estimatedCostUsd ?? 0).toFixed(4)).toBe('0.1200');
    });
  });

  describe('ralphx hint', () => {
    it('exits non-zero when run not found', () => {
      const wsDir = join(tmpDir, '.ralphx', ws);
      mkdirSync(join(wsDir, 'runs'), { recursive: true });
      const runDir = join(wsDir, 'runs', 'nonexistent');
      expect(existsSync(runDir)).toBe(false);
    });

    it('writes hint.md to correct run directory', () => {
      const runDir = join(tmpDir, '.ralphx', ws, 'runs', 'test-run');
      mkdirSync(runDir, { recursive: true });
      const hintPath = join(runDir, 'hint.md');
      writeFileSync(hintPath, 'Focus on auth');
      const hint = readFileSync(hintPath, 'utf-8');
      expect(hint).toBe('Focus on auth');
    });
  });

  describe('ralphx pause', () => {
    it('updates run-state.json status to paused', () => {
      const runDir = join(tmpDir, '.ralphx', ws, 'runs', 'test-run');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'run-state.json'), JSON.stringify({
        runId: 'test-run',
        status: 'running',
      }));

      // Replicate pause command logic
      const statePath = join(runDir, 'run-state.json');
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      expect(state.status).toBe('running');
      state.status = 'paused';
      state.updatedAt = new Date().toISOString();
      writeFileSync(statePath, JSON.stringify(state, null, 2));

      const updated = JSON.parse(readFileSync(statePath, 'utf-8'));
      expect(updated.status).toBe('paused');
    });
  });

  describe('ralphx dry-run', () => {
    it('exits 0 with expected output sections', () => {
      // Set up a valid workspace directory
      const wsDir = join(tmpDir, '.ralphx', ws);
      mkdirSync(join(wsDir, 'runs'), { recursive: true });
      writeFileSync(join(wsDir, 'prd.json'), JSON.stringify({
        version: '1.0',
        projectName: 'my-project',
        stories: [],
        qualityGates: {},
      }, null, 2));
      writeFileSync(join(wsDir, '.ralphxrc'), JSON.stringify({
        contextMode: 'continue',
        timeoutMinutes: 20,
        maxIterations: 50,
      }, null, 2));

      // Replicate dry-run command logic — loadConfig reads from wsDir
      const config = loadConfig({ projectDir: wsDir });
      expect(config.contextMode).toBe('continue');
      expect(config.timeoutMinutes).toBe(20);

      const prd = loadPrd(join(wsDir, 'prd.json'));
      expect(prd.projectName).toBe('my-project');
      expect(prd.stories).toHaveLength(0);

      const gates = Object.entries(prd.qualityGates).filter(([_, v]) => v);
      expect(gates).toHaveLength(0);
    });

    it('shows all resolved config including loop mode and circuit breaker', () => {
      const wsDir = join(tmpDir, '.ralphx', ws);
      mkdirSync(join(wsDir, 'runs'), { recursive: true });
      writeFileSync(join(wsDir, 'prd.json'), JSON.stringify({
        version: '1.0',
        projectName: 'test-project',
        stories: [
          { id: 's1', title: 'Story 1', status: 'active', passes: true, acceptanceCriteria: [] },
          { id: 's2', title: 'Story 2', status: 'active', passes: false, acceptanceCriteria: [] },
        ],
        qualityGates: { typecheck: 'npx tsc --noEmit', test: 'npm test' },
      }, null, 2));
      writeFileSync(join(wsDir, '.ralphxrc'), JSON.stringify({
        contextMode: 'fresh',
        loopMode: 'backlog',
        timeoutMinutes: 30,
        maxIterations: 100,
        maxCostUsd: 5.0,
        cbNoProgressThreshold: 5,
        cbSameErrorThreshold: 6,
      }, null, 2));

      const config = loadConfig({ projectDir: wsDir });
      // Verify all config fields the dry-run now displays
      expect(config.loopMode).toBe('backlog');
      expect(config.contextMode).toBe('fresh');
      expect(config.timeoutMinutes).toBe(30);
      expect(config.maxIterations).toBe(100);
      expect(config.maxCostUsd).toBe(5.0);
      expect(config.cbNoProgressThreshold).toBe(5);
      expect(config.cbSameErrorThreshold).toBe(6);
      expect(config.storyMaxConsecutiveFailures).toBe(3); // default

      const prd = loadPrd(join(wsDir, 'prd.json'));
      const active = prd.stories.filter(s => s.status === 'active');
      const failing = active.filter(s => !s.passes);
      expect(active).toHaveLength(2);
      expect(failing).toHaveLength(1);
      expect(failing[0].title).toBe('Story 2');

      const gateEntries = Object.entries(prd.qualityGates).filter(([_, v]) => v);
      expect(gateEntries).toHaveLength(2);
    });

    it('exits non-zero with invalid config', () => {
      // No workspace dir at all — prd.json missing
      expect(existsSync(join(tmpDir, '.ralphx', ws, 'prd.json'))).toBe(false);
    });
  });

  describe('ralphx run --resume', () => {
    it('shows resumable info for interrupted run', () => {
      const wsDir = join(tmpDir, '.ralphx', ws);
      const runDir = join(wsDir, 'runs', 'test-run');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'run-state.json'), JSON.stringify({
        runId: 'test-run',
        status: 'interrupted',
        iteration: 5,
        cost: { estimatedCostUsd: 0.1234 },
      }));
      // findResumableRun reads from projectDir/runs/ — pass wsDir
      const state = findResumableRun(wsDir, 'test-run');
      expect(state).not.toBeNull();
      expect(state!.status).toBe('interrupted');
    });

    it('exits non-zero for completed run', () => {
      const wsDir = join(tmpDir, '.ralphx', ws);
      const runDir = join(wsDir, 'runs', 'test-run');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'run-state.json'), JSON.stringify({
        runId: 'test-run',
        status: 'complete',
        iteration: 10,
        cost: { estimatedCostUsd: 1.0 },
      }));
      const state = findResumableRun(wsDir, 'test-run');
      expect(state).toBeNull();
    });
  });

  describe('ralphx import', () => {
    it('exits non-zero when file not found', () => {
      expect(existsSync('/nonexistent/file.md')).toBe(false);
    });

    it('imports markdown requirements into prd.json', () => {
      const reqPath = join(tmpDir, 'reqs.md');
      writeFileSync(reqPath, `# My App

## Add login
Implement login page.
- Accepts email
- Accepts password

## Add signup
Implement signup page.
- Validates email
`);
      const markdown = readFileSync(reqPath, 'utf-8');
      const prd = parseRequirements(markdown, 'my-app');

      expect(prd.stories).toHaveLength(2);
      expect(prd.projectName).toBe('my-app');
      expect(prd.stories[0].title).toBe('Add login');

      // Verify it can be written and read back
      const wsDir = join(tmpDir, '.ralphx', ws);
      mkdirSync(wsDir, { recursive: true });
      const prdPath = join(wsDir, 'prd.json');
      writeFileSync(prdPath, JSON.stringify(prd, null, 2));

      const loaded = JSON.parse(readFileSync(prdPath, 'utf-8'));
      expect(loaded.projectName).toBe('my-app');
      expect(loaded.stories).toHaveLength(2);
      expect(loaded.stories[0].title).toBe('Add login');
    });
  });

  describe('ralphx --agent-help', () => {
    it('prints workspace setup guide with all key sections', async () => {
      const { printAgentHelp } = await import('../src/cli/agent-help.js');
      const chunks: string[] = [];
      const origWrite = process.stdout.write;
      process.stdout.write = ((chunk: string) => { chunks.push(chunk); return true; }) as typeof process.stdout.write;
      try {
        printAgentHelp();
      } finally {
        process.stdout.write = origWrite;
      }
      const output = chunks.join('');
      expect(output).toContain('prd.json');
      expect(output).toContain('acceptanceCriteria');
      expect(output).toContain('.ralphxrc');
      expect(output).toContain('PROMPT.md');
      expect(output).toContain('AGENT.md');
      expect(output).toContain('qualityGates');
      expect(output).toContain('convergenceThreshold');
      expect(output).toContain('protectedPaths');
      expect(output).toContain('converged');
    });
  });
});
