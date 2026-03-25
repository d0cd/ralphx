import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CLI_PATH = join(__dirname, '..', 'src', 'cli', 'index.ts');
const TSX_PATH = join(__dirname, '..', 'node_modules', '.bin', 'tsx');

function ralph(args: string[], cwd: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync(
      TSX_PATH,
      [CLI_PATH, ...args],
      { cwd, encoding: 'utf-8', timeout: 10000, env: { ...process.env, NODE_NO_WARNINGS: '1' } },
    );
    return { stdout, exitCode: 0 };
  } catch (e: any) {
    return { stdout: (e.stdout ?? '') + (e.stderr ?? ''), exitCode: e.status ?? 1 };
  }
}

describe('CLI', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ralph-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('ralph init', () => {
    it('creates .ralph directory with template files', () => {
      const { exitCode } = ralph(['init'], tmpDir);
      expect(exitCode).toBe(0);
      expect(existsSync(join(tmpDir, '.ralph'))).toBe(true);
      expect(existsSync(join(tmpDir, '.ralph', 'PROMPT.md'))).toBe(true);
      expect(existsSync(join(tmpDir, '.ralph', 'AGENT.md'))).toBe(true);
      expect(existsSync(join(tmpDir, '.ralph', 'prd.json'))).toBe(true);
    });
  });

  describe('ralph run', () => {
    it('exits non-zero when prd.json is missing', () => {
      mkdirSync(join(tmpDir, '.ralph'), { recursive: true });
      // No prd.json
      const { exitCode, stdout } = ralph(['run'], tmpDir);
      expect(exitCode).not.toBe(0);
      expect(stdout).toContain('prd.json');
    });

    it('accepts --prompt flag without error', () => {
      // run will fail because there's no prd.json, but the flag should be accepted
      const { stdout } = ralph(['run', '--prompt', 'test prompt'], tmpDir);
      expect(stdout).toContain('prd.json');
    });
  });

  describe('ralph status', () => {
    it('prints "no runs found" when no runs exist', () => {
      mkdirSync(join(tmpDir, '.ralph'), { recursive: true });
      const { stdout } = ralph(['status'], tmpDir);
      expect(stdout).toContain('No runs found');
    });

    it('exits non-zero when specified run not found', () => {
      mkdirSync(join(tmpDir, '.ralph', 'runs'), { recursive: true });
      const { exitCode, stdout } = ralph(['status', '--run', 'nonexistent'], tmpDir);
      expect(exitCode).not.toBe(0);
      expect(stdout).toContain('not found');
    });

    it('prints status summary for existing run', () => {
      const runDir = join(tmpDir, '.ralph', 'runs', 'test-run');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'run-state.json'), JSON.stringify({
        runId: 'test-run',
        status: 'running',
        iteration: 5,
        agent: 'claude-code',
        cost: { estimatedCostUsd: 1.23 },
        startedAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:05:00Z',
        perIteration: [],
      }));
      const { stdout } = ralph(['status'], tmpDir);
      expect(stdout).toContain('test-run');
      expect(stdout).toContain('running');
    });
  });

  describe('ralph logs', () => {
    it('exits non-zero when no runs exist', () => {
      mkdirSync(join(tmpDir, '.ralph'), { recursive: true });
      const { exitCode, stdout } = ralph(['logs'], tmpDir);
      expect(exitCode).not.toBe(0);
      expect(stdout).toContain('No runs found');
    });

    it('exits non-zero when log file missing for run', () => {
      const runDir = join(tmpDir, '.ralph', 'runs', 'test-run');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'run-state.json'), JSON.stringify({ runId: 'test-run', updatedAt: '2026-01-01T00:00:00Z' }));
      const { exitCode, stdout } = ralph(['logs', '--run', 'test-run'], tmpDir);
      expect(exitCode).not.toBe(0);
      expect(stdout).toContain('No log file');
    });

    it('prints log content for existing run', () => {
      const runDir = join(tmpDir, '.ralph', 'runs', 'test-run');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'run-state.json'), JSON.stringify({ runId: 'test-run' }));
      writeFileSync(join(runDir, 'loop.log'), 'line 1\nline 2\n');
      const { stdout } = ralph(['logs', '--run', 'test-run'], tmpDir);
      expect(stdout).toContain('line 1');
      expect(stdout).toContain('line 2');
    });
  });

  describe('ralph cost', () => {
    it('exits non-zero when specified run not found', () => {
      mkdirSync(join(tmpDir, '.ralph', 'runs'), { recursive: true });
      const { exitCode, stdout } = ralph(['cost', '--run', 'nonexistent'], tmpDir);
      expect(exitCode).not.toBe(0);
      expect(stdout).toContain('not found');
    });

    it('shows cost totals', () => {
      const runDir = join(tmpDir, '.ralph', 'runs', 'test-run');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'run-state.json'), JSON.stringify({
        runId: 'test-run',
        iteration: 3,
        cost: {
          totalInputTokens: 15000,
          totalOutputTokens: 7500,
          totalCacheReadTokens: 1000,
          totalCacheWriteTokens: 500,
          estimatedCostUsd: 0.4567,
        },
      }));
      const { stdout } = ralph(['cost', '--run', 'test-run'], tmpDir);
      expect(stdout).toContain('15,000');
      expect(stdout).toContain('7,500');
      expect(stdout).toContain('0.4567');
    });
  });

  describe('ralph hint', () => {
    it('exits non-zero when run not found', () => {
      mkdirSync(join(tmpDir, '.ralph', 'runs'), { recursive: true });
      const { exitCode, stdout } = ralph(['hint', '--run', 'nonexistent', 'test hint'], tmpDir);
      expect(exitCode).not.toBe(0);
      expect(stdout).toContain('not found');
    });

    it('writes hint.md to correct run directory', () => {
      const runDir = join(tmpDir, '.ralph', 'runs', 'test-run');
      mkdirSync(runDir, { recursive: true });
      const { exitCode } = ralph(['hint', '--run', 'test-run', 'Focus on auth'], tmpDir);
      expect(exitCode).toBe(0);
      const hint = readFileSync(join(runDir, 'hint.md'), 'utf-8');
      expect(hint).toBe('Focus on auth');
    });
  });

  describe('ralph pause', () => {
    it('updates run-state.json status to paused', () => {
      const runDir = join(tmpDir, '.ralph', 'runs', 'test-run');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'run-state.json'), JSON.stringify({
        runId: 'test-run',
        status: 'running',
      }));
      const { exitCode } = ralph(['pause', '--run', 'test-run'], tmpDir);
      expect(exitCode).toBe(0);
      const state = JSON.parse(readFileSync(join(runDir, 'run-state.json'), 'utf-8'));
      expect(state.status).toBe('paused');
    });
  });

  describe('ralph dry-run', () => {
    it('exits 0 with expected output sections', () => {
      ralph(['init'], tmpDir);
      const { stdout, exitCode } = ralph(['dry-run'], tmpDir);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Resolved Config');
      expect(stdout).toContain('PRD');
      expect(stdout).toContain('Quality Gates');
      expect(stdout).toContain('Dry run complete');
    });

    it('exits non-zero with invalid config', () => {
      // No .ralph dir at all
      const { exitCode } = ralph(['dry-run'], tmpDir);
      expect(exitCode).not.toBe(0);
    });
  });

  describe('ralph resume', () => {
    it('shows resumable info for interrupted run', () => {
      const runDir = join(tmpDir, '.ralph', 'runs', 'test-run');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'run-state.json'), JSON.stringify({
        runId: 'test-run',
        status: 'interrupted',
        iteration: 5,
        cost: { estimatedCostUsd: 0.1234 },
      }));
      const { stdout, exitCode } = ralph(['resume', 'test-run'], tmpDir);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('resumable');
      expect(stdout).toContain('interrupted');
    });

    it('exits non-zero for completed run', () => {
      const runDir = join(tmpDir, '.ralph', 'runs', 'test-run');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'run-state.json'), JSON.stringify({
        runId: 'test-run',
        status: 'complete',
        iteration: 10,
        cost: { estimatedCostUsd: 1.0 },
      }));
      const { exitCode } = ralph(['resume', 'test-run'], tmpDir);
      expect(exitCode).not.toBe(0);
    });
  });

  describe('ralph import', () => {
    it('exits non-zero when file not found', () => {
      const { exitCode, stdout } = ralph(['import', '/nonexistent/file.md'], tmpDir);
      expect(exitCode).not.toBe(0);
      expect(stdout).toContain('File not found');
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
      const { exitCode, stdout } = ralph(['import', reqPath, '--project', 'my-app'], tmpDir);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('2 stories');

      const prd = JSON.parse(readFileSync(join(tmpDir, '.ralph', 'prd.json'), 'utf-8'));
      expect(prd.projectName).toBe('my-app');
      expect(prd.stories).toHaveLength(2);
      expect(prd.stories[0].title).toBe('Add login');
    });
  });
});
