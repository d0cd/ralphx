import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { saveWorkflow, useWorkflow, listWorkflows } from '../src/workflow/manager.js';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

describe('Workflow Manager', () => {
  let tmpDir: string;
  let wsDir: string;
  let workflowsDir: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ralphx-wf-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    wsDir = join(tmpDir, '.ralphx', 'test-ws');
    mkdirSync(wsDir, { recursive: true });

    // Use a temp home to isolate workflow storage
    const fakeHome = join(tmpDir, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
    workflowsDir = join(fakeHome, '.ralphx', 'workflows');
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves workflow files from workspace dir', () => {
    writeFileSync(join(wsDir, 'PROMPT.md'), '# Test prompt');
    writeFileSync(join(wsDir, '.ralphxrc'), '{"verbose": true}');
    writeFileSync(join(wsDir, 'prd.json'), '{"version":"1","projectName":"test","stories":[],"qualityGates":{}}');

    saveWorkflow('my-audit', wsDir);

    expect(existsSync(join(workflowsDir, 'my-audit', 'PROMPT.md'))).toBe(true);
    expect(existsSync(join(workflowsDir, 'my-audit', '.ralphxrc'))).toBe(true);
    expect(existsSync(join(workflowsDir, 'my-audit', 'prd.json'))).toBe(true);
  });

  it('applies workflow to project', () => {
    // Save first
    writeFileSync(join(wsDir, 'PROMPT.md'), '# Saved prompt');
    writeFileSync(join(wsDir, 'prd.json'), '{"version":"1","projectName":"saved","stories":[],"qualityGates":{}}');
    saveWorkflow('reuse-me', wsDir);

    // Clear and apply to a new workspace dir
    const newWsDir = join(tmpDir, 'newproject', '.ralphx', 'other-ws');
    mkdirSync(newWsDir, { recursive: true });
    useWorkflow('reuse-me', newWsDir);

    const prompt = readFileSync(join(newWsDir, 'PROMPT.md'), 'utf-8');
    expect(prompt).toBe('# Saved prompt');
  });

  it('lists saved workflows', () => {
    writeFileSync(join(wsDir, 'PROMPT.md'), '# P');
    saveWorkflow('wf-a', wsDir);
    saveWorkflow('wf-b', wsDir);

    const list = listWorkflows();
    expect(list.length).toBeGreaterThanOrEqual(2);
    const names = list.map(w => w.name);
    expect(names).toContain('wf-a');
    expect(names).toContain('wf-b');
  });

  it('throws when saving from non-existent workspace dir', () => {
    const empty = join(tmpDir, 'empty');
    // Do not create it
    expect(() => saveWorkflow('bad', empty)).toThrow();
  });

  it('throws when using non-existent workflow', () => {
    expect(() => useWorkflow('nonexistent', wsDir)).toThrow('not found');
  });

  it('returns empty list when no workflows exist', () => {
    expect(listWorkflows()).toHaveLength(0);
  });

});
