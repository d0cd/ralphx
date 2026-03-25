import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { saveWorkflow, useWorkflow, listWorkflows, getWorkflowDetail } from '../src/workflow/manager.js';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

describe('Workflow Manager', () => {
  let tmpDir: string;
  let workflowsDir: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ralph-wf-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpDir, '.ralph'), { recursive: true });

    // Use a temp home to isolate workflow storage
    const fakeHome = join(tmpDir, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
    workflowsDir = join(fakeHome, '.ralph', 'workflows');
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves workflow files from .ralph/', () => {
    writeFileSync(join(tmpDir, '.ralph', 'PROMPT.md'), '# Test prompt');
    writeFileSync(join(tmpDir, '.ralph', '.ralphrc'), '{"verbose": true}');
    writeFileSync(join(tmpDir, '.ralph', 'prd.json'), '{"version":"1","projectName":"test","stories":[],"qualityGates":{}}');

    saveWorkflow('my-audit', tmpDir);

    expect(existsSync(join(workflowsDir, 'my-audit', 'PROMPT.md'))).toBe(true);
    expect(existsSync(join(workflowsDir, 'my-audit', '.ralphrc'))).toBe(true);
    expect(existsSync(join(workflowsDir, 'my-audit', 'prd.json'))).toBe(true);
  });

  it('applies workflow to project', () => {
    // Save first
    writeFileSync(join(tmpDir, '.ralph', 'PROMPT.md'), '# Saved prompt');
    writeFileSync(join(tmpDir, '.ralph', 'prd.json'), '{"version":"1","projectName":"saved","stories":[],"qualityGates":{}}');
    saveWorkflow('reuse-me', tmpDir);

    // Clear and apply
    const newProject = join(tmpDir, 'newproject');
    mkdirSync(join(newProject, '.ralph'), { recursive: true });
    useWorkflow('reuse-me', newProject);

    const prompt = readFileSync(join(newProject, '.ralph', 'PROMPT.md'), 'utf-8');
    expect(prompt).toBe('# Saved prompt');
  });

  it('lists saved workflows', () => {
    writeFileSync(join(tmpDir, '.ralph', 'PROMPT.md'), '# P');
    saveWorkflow('wf-a', tmpDir);
    saveWorkflow('wf-b', tmpDir);

    const list = listWorkflows();
    expect(list.length).toBeGreaterThanOrEqual(2);
    const names = list.map(w => w.name);
    expect(names).toContain('wf-a');
    expect(names).toContain('wf-b');
  });

  it('throws when saving from non-existent .ralph/', () => {
    const empty = join(tmpDir, 'empty');
    mkdirSync(empty);
    expect(() => saveWorkflow('bad', empty)).toThrow('No .ralph/ directory');
  });

  it('throws when using non-existent workflow', () => {
    expect(() => useWorkflow('nonexistent', tmpDir)).toThrow('not found');
  });

  it('returns empty list when no workflows exist', () => {
    expect(listWorkflows()).toHaveLength(0);
  });

  describe('getWorkflowDetail', () => {
    it('returns null for non-existent workflow', () => {
      expect(getWorkflowDetail('nonexistent')).toBeNull();
    });

    it('returns empty object when workflow has no prd.json', () => {
      writeFileSync(join(tmpDir, '.ralph', 'PROMPT.md'), '# P');
      saveWorkflow('no-prd', tmpDir);

      // Remove the prd.json from the saved workflow
      const { unlinkSync } = require('node:fs');
      const prdInWorkflow = join(workflowsDir, 'no-prd', 'prd.json');
      if (existsSync(prdInWorkflow)) unlinkSync(prdInWorkflow);

      const detail = getWorkflowDetail('no-prd');
      expect(detail).not.toBeNull();
      expect(detail!.prdSummary).toBeUndefined();
    });

    it('returns prdSummary with project name and story count', () => {
      const prd = {
        version: '1', projectName: 'my-project',
        stories: [
          { id: 's1', title: 'S1', description: 'D', acceptanceCriteria: [], priority: 1, status: 'active', passes: false },
          { id: 's2', title: 'S2', description: 'D', acceptanceCriteria: [], priority: 2, status: 'active', passes: false },
        ],
        qualityGates: {},
      };
      writeFileSync(join(tmpDir, '.ralph', 'prd.json'), JSON.stringify(prd));
      writeFileSync(join(tmpDir, '.ralph', 'PROMPT.md'), '# P');
      saveWorkflow('with-prd', tmpDir);

      const detail = getWorkflowDetail('with-prd');
      expect(detail).not.toBeNull();
      expect(detail!.prdSummary).toBe('my-project: 2 stories');
    });

    it('handles corrupt prd.json gracefully', () => {
      writeFileSync(join(tmpDir, '.ralph', 'PROMPT.md'), '# P');
      writeFileSync(join(tmpDir, '.ralph', 'prd.json'), '{"version":"1","projectName":"x","stories":[],"qualityGates":{}}');
      saveWorkflow('corrupt-prd', tmpDir);

      // Overwrite the saved prd.json with corrupt data
      writeFileSync(join(workflowsDir, 'corrupt-prd', 'prd.json'), '{ broken json!!!');

      const detail = getWorkflowDetail('corrupt-prd');
      expect(detail).not.toBeNull();
      expect(detail!.prdSummary).toBeUndefined();
    });

    it('handles prd.json missing projectName', () => {
      writeFileSync(join(tmpDir, '.ralph', 'PROMPT.md'), '# P');
      writeFileSync(join(tmpDir, '.ralph', 'prd.json'), '{"version":"1","projectName":"x","stories":[],"qualityGates":{}}');
      saveWorkflow('no-name', tmpDir);

      // Overwrite with valid JSON but no projectName
      writeFileSync(join(workflowsDir, 'no-name', 'prd.json'), JSON.stringify({ stories: [1, 2, 3] }));

      const detail = getWorkflowDetail('no-name');
      expect(detail!.prdSummary).toBe('unnamed: 3 stories');
    });
  });
});
