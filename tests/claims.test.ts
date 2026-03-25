import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ClaimsManager } from '../src/prd/claims.js';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PRD, ClaimsFile } from '../src/types/prd.js';

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

describe('ClaimsManager', () => {
  let tmpDir: string;
  let prdPath: string;
  let claimsPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ralph-claims-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    prdPath = join(tmpDir, 'prd.json');
    claimsPath = join(tmpDir, 'claims.json');
    writeFileSync(prdPath, JSON.stringify(makePrd()));
    writeFileSync(claimsPath, JSON.stringify({ claims: [] }));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeManager(ttlMinutes = 45) {
    return new ClaimsManager({ prdPath, claimsPath, ttlMinutes });
  }

  it('claims highest-priority todo story', async () => {
    const mgr = makeManager();
    const story = await mgr.claimNextStory('run-1');
    expect(story).not.toBeNull();
    expect(story!.id).toBe('s-1');
  });

  it('skips already-claimed stories', async () => {
    const mgr = makeManager();
    await mgr.claimNextStory('run-1');
    const story2 = await mgr.claimNextStory('run-2');
    expect(story2).not.toBeNull();
    expect(story2!.id).toBe('s-2');
  });

  it('skips passing stories', async () => {
    const prd = makePrd();
    prd.stories[0].passes = true;
    writeFileSync(prdPath, JSON.stringify(prd));

    const mgr = makeManager();
    const story = await mgr.claimNextStory('run-1');
    expect(story!.id).toBe('s-2');
  });

  it('prunes claim with dead PID', async () => {
    // Write a claim with a dead PID
    const claims: ClaimsFile = {
      claims: [{
        storyId: 's-1',
        runId: 'dead-run',
        claimedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        pid: 999999999,
      }],
    };
    writeFileSync(claimsPath, JSON.stringify(claims));

    const mgr = makeManager();
    const story = await mgr.claimNextStory('run-1');
    // Should reclaim s-1 since the old claim had a dead PID
    expect(story!.id).toBe('s-1');
  });

  it('prunes claim with expired heartbeat', async () => {
    const oldTime = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    const claims: ClaimsFile = {
      claims: [{
        storyId: 's-1',
        runId: 'old-run',
        claimedAt: oldTime,
        heartbeatAt: oldTime,
        pid: process.pid, // alive PID but expired heartbeat
      }],
    };
    writeFileSync(claimsPath, JSON.stringify(claims));

    const mgr = makeManager(30); // 30 minute TTL
    const story = await mgr.claimNextStory('run-1');
    expect(story!.id).toBe('s-1');
  });

  it('two concurrent claims get different stories', async () => {
    const mgr1 = makeManager();
    const mgr2 = makeManager();

    const [story1, story2] = await Promise.all([
      mgr1.claimNextStory('run-1'),
      mgr2.claimNextStory('run-2'),
    ]);

    expect(story1).not.toBeNull();
    expect(story2).not.toBeNull();
    expect(story1!.id).not.toBe(story2!.id);
  });

  it('release removes claim from file', async () => {
    const mgr = makeManager();
    await mgr.claimNextStory('run-1');

    await mgr.releaseStory('s-1', 'run-1');

    const raw = JSON.parse(readFileSync(claimsPath, 'utf-8')) as ClaimsFile;
    expect(raw.claims.find(c => c.storyId === 's-1')).toBeUndefined();
  });

  it('heartbeat updates timestamp', async () => {
    const mgr = makeManager();
    await mgr.claimNextStory('run-1');

    const before = JSON.parse(readFileSync(claimsPath, 'utf-8')) as ClaimsFile;
    const beforeHb = before.claims[0].heartbeatAt;

    await new Promise(r => setTimeout(r, 10));
    await mgr.heartbeat('s-1', 'run-1');

    const after = JSON.parse(readFileSync(claimsPath, 'utf-8')) as ClaimsFile;
    expect(after.claims[0].heartbeatAt).not.toBe(beforeHb);
  });

  it('empty PRD returns null', async () => {
    writeFileSync(prdPath, JSON.stringify({ ...makePrd(0) }));
    const mgr = makeManager();
    const story = await mgr.claimNextStory('run-1');
    expect(story).toBeNull();
  });

  it('all stories passing returns null', async () => {
    const prd = makePrd(2);
    prd.stories.forEach(s => s.passes = true);
    writeFileSync(prdPath, JSON.stringify(prd));

    const mgr = makeManager();
    const story = await mgr.claimNextStory('run-1');
    expect(story).toBeNull();
  });

  it('release is safe when claim does not exist', async () => {
    const mgr = makeManager();
    // Should not throw
    await mgr.releaseStory('nonexistent', 'run-1');
    const raw = JSON.parse(readFileSync(claimsPath, 'utf-8')) as ClaimsFile;
    expect(raw.claims).toHaveLength(0);
  });

  it('heartbeat returns false when claim was pruned', async () => {
    const mgr = makeManager();
    // No claim exists for this story
    const result = await mgr.heartbeat('s-1', 'run-1');
    expect(result).toBe(false);
  });

  it('heartbeat returns true for valid claim', async () => {
    const mgr = makeManager();
    await mgr.claimNextStory('run-1');
    const result = await mgr.heartbeat('s-1', 'run-1');
    expect(result).toBe(true);
  });

  it('recovers from corrupt claims JSON file', async () => {
    // Write invalid JSON to the claims file
    writeFileSync(claimsPath, '{ corrupt json!!!');

    const mgr = makeManager();
    // loadClaims should return empty claims, not throw
    const story = await mgr.claimNextStory('run-1');
    expect(story).not.toBeNull();
    expect(story!.id).toBe('s-1');
  });

  it('handles missing claims file gracefully', async () => {
    const { unlinkSync } = await import('node:fs');
    unlinkSync(claimsPath);

    const mgr = makeManager();
    const story = await mgr.claimNextStory('run-1');
    expect(story).not.toBeNull();
    expect(story!.id).toBe('s-1');
  });
});
