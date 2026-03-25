import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ClaimsManager } from '../src/prd/claims.js';
import { loadPrd, updateStoryPasses } from '../src/prd/tracker.js';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PRD, ClaimsFile } from '../src/types/prd.js';

function makePrd(storyCount = 5): PRD {
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

describe('Concurrency Integration', () => {
  let tmpDir: string;
  let prdPath: string;
  let claimsPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ralph-conc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    prdPath = join(tmpDir, 'prd.json');
    claimsPath = join(tmpDir, 'claims.json');
    writeFileSync(prdPath, JSON.stringify(makePrd(5)));
    writeFileSync(claimsPath, JSON.stringify({ claims: [] }));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeManager(ttl = 45) {
    return new ClaimsManager({ prdPath, claimsPath, ttlMinutes: ttl });
  }

  it('two loops start simultaneously, each gets a different story', async () => {
    const mgr1 = makeManager();
    const mgr2 = makeManager();

    const [s1, s2] = await Promise.all([
      mgr1.claimNextStory('run-1'),
      mgr2.claimNextStory('run-2'),
    ]);

    expect(s1).not.toBeNull();
    expect(s2).not.toBeNull();
    expect(s1!.id).not.toBe(s2!.id);

    // Verify claims file has both
    const claims: ClaimsFile = JSON.parse(readFileSync(claimsPath, 'utf-8'));
    expect(claims.claims).toHaveLength(2);
    const claimedIds = claims.claims.map(c => c.storyId);
    expect(new Set(claimedIds).size).toBe(2);
  });

  it('one loop crashes, other loop eventually reclaims its story', async () => {
    // Simulate a crashed run with dead PID
    const claims: ClaimsFile = {
      claims: [{
        storyId: 's-1',
        runId: 'crashed-run',
        claimedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        pid: 999999999, // dead PID
      }],
    };
    writeFileSync(claimsPath, JSON.stringify(claims));

    const mgr = makeManager();
    const story = await mgr.claimNextStory('run-2');

    // Should reclaim s-1 since the crash PID is dead
    expect(story).not.toBeNull();
    expect(story!.id).toBe('s-1');
  });

  it('loop finishes story, next iteration claims new story', async () => {
    const mgr = makeManager();

    // Claim first story
    const s1 = await mgr.claimNextStory('run-1');
    expect(s1!.id).toBe('s-1');

    // Complete it
    updateStoryPasses(prdPath, 's-1', true);
    await mgr.releaseStory('s-1', 'run-1');

    // Claim next
    const s2 = await mgr.claimNextStory('run-1');
    expect(s2!.id).toBe('s-2');
  });

  it('three loops exhaust all stories, each exits cleanly', async () => {
    writeFileSync(prdPath, JSON.stringify(makePrd(3)));

    const mgr1 = makeManager();
    const mgr2 = makeManager();
    const mgr3 = makeManager();

    // All three claim simultaneously
    const [s1, s2, s3] = await Promise.all([
      mgr1.claimNextStory('run-1'),
      mgr2.claimNextStory('run-2'),
      mgr3.claimNextStory('run-3'),
    ]);

    expect(s1).not.toBeNull();
    expect(s2).not.toBeNull();
    expect(s3).not.toBeNull();

    const ids = new Set([s1!.id, s2!.id, s3!.id]);
    expect(ids.size).toBe(3);

    // Complete all and release
    for (const [story, runId, mgr] of [[s1, 'run-1', mgr1], [s2, 'run-2', mgr2], [s3, 'run-3', mgr3]] as const) {
      updateStoryPasses(prdPath, story!.id, true);
      await (mgr as ClaimsManager).releaseStory(story!.id, runId as string);
    }

    // No more stories to claim
    const s4 = await mgr1.claimNextStory('run-1');
    expect(s4).toBeNull();
  });

  it('heartbeat keeps claim alive', async () => {
    const mgr = makeManager(1); // 1 minute TTL

    await mgr.claimNextStory('run-1');

    // Heartbeat refreshes timestamp
    await mgr.heartbeat('s-1', 'run-1');

    const claims: ClaimsFile = JSON.parse(readFileSync(claimsPath, 'utf-8'));
    const claim = claims.claims.find(c => c.storyId === 's-1');
    expect(claim).toBeDefined();
    expect(claim!.runId).toBe('run-1');
  });

  it('expired heartbeat allows reclaim', async () => {
    // Create a claim with old heartbeat but alive PID
    const oldTime = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    const claims: ClaimsFile = {
      claims: [{
        storyId: 's-1',
        runId: 'stale-run',
        claimedAt: oldTime,
        heartbeatAt: oldTime,
        pid: process.pid, // alive but heartbeat expired
      }],
    };
    writeFileSync(claimsPath, JSON.stringify(claims));

    const mgr = makeManager(30); // 30 min TTL, heartbeat is 60 min old
    const story = await mgr.claimNextStory('run-fresh');
    expect(story!.id).toBe('s-1');
  });
});
