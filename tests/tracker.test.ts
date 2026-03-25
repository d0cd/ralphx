import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadPrd, getFailingStories, updateStoryPasses, allStoriesPass, resetFailingStories } from '../src/prd/tracker.js';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PRD } from '../src/types/prd.js';

function makePrd(storyCount = 3): PRD {
  return {
    version: '1.0',
    projectName: 'test',
    stories: Array.from({ length: storyCount }, (_, i) => ({
      id: `s-${i + 1}`,
      title: `Story ${i + 1}`,
      description: `Desc ${i + 1}`,
      acceptanceCriteria: [`AC ${i + 1}`],
      priority: i + 1,
      status: 'active' as const,
      passes: false,
    })),
    qualityGates: {},
  };
}

describe('PRD Tracker', () => {
  let tmpDir: string;
  let prdPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ralph-prd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    prdPath = join(tmpDir, 'prd.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadPrd', () => {
    it('loads valid PRD file', () => {
      writeFileSync(prdPath, JSON.stringify(makePrd()));
      const prd = loadPrd(prdPath);
      expect(prd.stories).toHaveLength(3);
      expect(prd.projectName).toBe('test');
    });

    it('throws on missing file', () => {
      expect(() => loadPrd(join(tmpDir, 'nope.json'))).toThrow('Failed to read PRD file');
    });

    it('throws on invalid JSON', () => {
      writeFileSync(prdPath, '{ broken json');
      expect(() => loadPrd(prdPath)).toThrow('Invalid JSON in PRD file');
    });

    it('throws on missing stories array', () => {
      writeFileSync(prdPath, JSON.stringify({ version: '1', projectName: 'x' }));
      expect(() => loadPrd(prdPath)).toThrow('missing required "stories" array');
    });

    it('throws on empty file', () => {
      writeFileSync(prdPath, '');
      expect(() => loadPrd(prdPath)).toThrow('Invalid JSON');
    });

    it('throws on missing version or projectName', () => {
      writeFileSync(prdPath, JSON.stringify({ stories: [] }));
      expect(() => loadPrd(prdPath)).toThrow('missing required "version" or "projectName"');
    });

    it('migrates legacy todo/done status to active/passes', () => {
      const legacy = {
        version: '1.0', projectName: 'test',
        stories: [
          { id: 's-1', title: 'T1', description: 'D', acceptanceCriteria: [], priority: 1, status: 'todo' },
          { id: 's-2', title: 'T2', description: 'D', acceptanceCriteria: [], priority: 2, status: 'done' },
        ],
        qualityGates: {},
      };
      writeFileSync(prdPath, JSON.stringify(legacy));
      const prd = loadPrd(prdPath);
      expect(prd.stories[0].status).toBe('active');
      expect(prd.stories[0].passes).toBe(false);
      expect(prd.stories[1].status).toBe('active');
      expect(prd.stories[1].passes).toBe(true);
    });
  });

  describe('getFailingStories', () => {
    it('returns all failing active stories sorted by priority', () => {
      const prd = makePrd(3);
      prd.stories[1].passes = true;
      const failing = getFailingStories(prd);
      expect(failing).toHaveLength(2);
      expect(failing[0].id).toBe('s-1');
      expect(failing[1].id).toBe('s-3');
    });

    it('skips deferred stories', () => {
      const prd = makePrd(3);
      prd.stories[0].status = 'deferred';
      const failing = getFailingStories(prd);
      expect(failing).toHaveLength(2);
      expect(failing[0].id).toBe('s-2');
    });

    it('returns empty array when all stories pass', () => {
      const prd = makePrd(3);
      prd.stories.forEach(s => s.passes = true);
      const failing = getFailingStories(prd);
      expect(failing).toHaveLength(0);
    });

    it('returns empty array for zero stories', () => {
      const prd = makePrd(0);
      const failing = getFailingStories(prd);
      expect(failing).toHaveLength(0);
    });

    it('skips circuit-broken stories when threshold provided', () => {
      const prd = makePrd(3);
      prd.stories[0].consecutiveFailures = 3;
      const failing = getFailingStories(prd, 3);
      expect(failing).toHaveLength(2);
      expect(failing[0].id).toBe('s-2');
    });
  });

  describe('updateStoryPasses', () => {
    it('sets passes to true and resets failure count', () => {
      writeFileSync(prdPath, JSON.stringify(makePrd()));
      updateStoryPasses(prdPath, 's-1', true);
      const prd = loadPrd(prdPath);
      expect(prd.stories[0].passes).toBe(true);
      expect(prd.stories[0].consecutiveFailures).toBe(0);
    });

    it('sets passes to false and increments failure count', () => {
      writeFileSync(prdPath, JSON.stringify(makePrd()));
      updateStoryPasses(prdPath, 's-1', false, 'tests failed');
      const prd = loadPrd(prdPath);
      expect(prd.stories[0].passes).toBe(false);
      expect(prd.stories[0].consecutiveFailures).toBe(1);
      expect(prd.stories[0].lastError).toBe('tests failed');
    });

    it('accumulates consecutiveFailures across multiple calls', () => {
      writeFileSync(prdPath, JSON.stringify(makePrd()));
      updateStoryPasses(prdPath, 's-1', false, 'fail 1');
      updateStoryPasses(prdPath, 's-1', false, 'fail 2');
      updateStoryPasses(prdPath, 's-1', false, 'fail 3');
      const prd = loadPrd(prdPath);
      expect(prd.stories[0].consecutiveFailures).toBe(3);
      expect(prd.stories[0].lastError).toBe('fail 3');
    });

    it('resets consecutiveFailures to 0 after a pass then re-accumulates', () => {
      writeFileSync(prdPath, JSON.stringify(makePrd()));
      updateStoryPasses(prdPath, 's-1', false, 'fail 1');
      updateStoryPasses(prdPath, 's-1', false, 'fail 2');
      updateStoryPasses(prdPath, 's-1', true);
      const mid = loadPrd(prdPath);
      expect(mid.stories[0].consecutiveFailures).toBe(0);

      updateStoryPasses(prdPath, 's-1', false, 'new fail');
      const after = loadPrd(prdPath);
      expect(after.stories[0].consecutiveFailures).toBe(1);
    });

    it('throws when story not found', () => {
      writeFileSync(prdPath, JSON.stringify(makePrd()));
      expect(() => updateStoryPasses(prdPath, 'nonexistent', true)).toThrow('not found');
    });

    it('does not modify other stories', () => {
      writeFileSync(prdPath, JSON.stringify(makePrd()));
      updateStoryPasses(prdPath, 's-1', true);
      const prd = loadPrd(prdPath);
      expect(prd.stories[1].passes).toBe(false);
      expect(prd.stories[2].passes).toBe(false);
    });
  });

  describe('allStoriesPass', () => {
    it('returns true when all active stories pass', () => {
      const prd = makePrd(2);
      prd.stories.forEach(s => s.passes = true);
      expect(allStoriesPass(prd)).toBe(true);
    });

    it('returns false when some stories fail', () => {
      const prd = makePrd(2);
      prd.stories[0].passes = true;
      expect(allStoriesPass(prd)).toBe(false);
    });

    it('returns false for empty stories', () => {
      const prd = makePrd(0);
      expect(allStoriesPass(prd)).toBe(false);
    });

    it('ignores deferred stories', () => {
      const prd = makePrd(2);
      prd.stories[0].passes = true;
      prd.stories[1].status = 'deferred';
      expect(allStoriesPass(prd)).toBe(true);
    });

    it('returns false when all stories are deferred', () => {
      const prd = makePrd(2);
      prd.stories[0].status = 'deferred';
      prd.stories[1].status = 'deferred';
      expect(allStoriesPass(prd)).toBe(false);
    });
  });

  describe('resetFailingStories', () => {
    it('flips passing stories back to false', () => {
      const prd = makePrd(3);
      prd.stories[0].passes = true;
      prd.stories[1].passes = true;
      writeFileSync(prdPath, JSON.stringify(prd));

      resetFailingStories(prdPath, ['s-1', 's-2']);

      const updated = loadPrd(prdPath);
      expect(updated.stories[0].passes).toBe(false);
      expect(updated.stories[1].passes).toBe(false);
      expect(updated.stories[2].passes).toBe(false); // was already false
    });

    it('resets consecutiveFailures on regression', () => {
      const prd = makePrd(1);
      prd.stories[0].passes = true;
      prd.stories[0].consecutiveFailures = 5;
      writeFileSync(prdPath, JSON.stringify(prd));

      resetFailingStories(prdPath, ['s-1']);

      const updated = loadPrd(prdPath);
      expect(updated.stories[0].consecutiveFailures).toBe(0);
    });
  });

  describe('resetFailingStories edge cases', () => {
    it('no-ops when given empty array', () => {
      const prd = makePrd(2);
      prd.stories[0].passes = true;
      writeFileSync(prdPath, JSON.stringify(prd));

      resetFailingStories(prdPath, []);

      const updated = loadPrd(prdPath);
      expect(updated.stories[0].passes).toBe(true); // unchanged
    });

    it('ignores story IDs not in PRD', () => {
      const prd = makePrd(1);
      prd.stories[0].passes = true;
      writeFileSync(prdPath, JSON.stringify(prd));

      resetFailingStories(prdPath, ['nonexistent-id']);

      const updated = loadPrd(prdPath);
      expect(updated.stories[0].passes).toBe(true); // unchanged
    });

    it('does not flip already-failing stories', () => {
      const prd = makePrd(2);
      prd.stories[0].passes = false;
      prd.stories[0].consecutiveFailures = 3;
      writeFileSync(prdPath, JSON.stringify(prd));

      resetFailingStories(prdPath, ['s-1']);

      const updated = loadPrd(prdPath);
      expect(updated.stories[0].passes).toBe(false);
      expect(updated.stories[0].consecutiveFailures).toBe(3); // unchanged
    });
  });

});
