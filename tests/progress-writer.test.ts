import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendProgress, readProgress } from '../src/core/progress-writer.js';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Progress Writer', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ralph-prog-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpDir, '.ralph'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends structured progress entry', () => {
    appendProgress(tmpDir, {
      iteration: 1, round: 1, storyId: 's-1', storyTitle: 'Add auth',
      passed: true, summary: 'Added JWT middleware',
      gateResults: [{ name: 'test', passed: true }],
      timestamp: '2026-01-01T00:00:00Z',
    });

    const content = readFileSync(join(tmpDir, '.ralph', 'progress.md'), 'utf-8');
    expect(content).toContain('Iteration 1 (Round 1)');
    expect(content).toContain('[s-1] Add auth');
    expect(content).toContain('PASSED');
    expect(content).toContain('test: pass');
  });

  it('appends multiple entries', () => {
    appendProgress(tmpDir, {
      iteration: 1, round: 1, storyId: 's-1', storyTitle: 'T1',
      passed: true, summary: 'Done',
      gateResults: [], timestamp: '2026-01-01T00:00:00Z',
    });
    appendProgress(tmpDir, {
      iteration: 2, round: 1, storyId: 's-2', storyTitle: 'T2',
      passed: false, summary: 'Failed',
      gateResults: [{ name: 'test', passed: false }],
      timestamp: '2026-01-01T00:01:00Z',
    });

    const content = readProgress(tmpDir);
    expect(content).toContain('Iteration 1');
    expect(content).toContain('Iteration 2');
    expect(content).toContain('FAILED');
  });

  it('readProgress returns null when no file exists', () => {
    expect(readProgress(tmpDir)).toBeNull();
  });
});
