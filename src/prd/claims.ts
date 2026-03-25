import { readFileSync, existsSync } from 'node:fs';
import { acquireLock, releaseLock } from '../sync/file-lock.js';
import { atomicWriteJson } from '../sync/atomic-write.js';
import { isPidAlive } from '../sync/pid-utils.js';
import { loadPrd, getNextStory } from './tracker.js';
import type { Story, ClaimsFile, StoryClaim } from '../types/prd.js';

interface ClaimsManagerConfig {
  prdPath: string;
  claimsPath: string;
  ttlMinutes: number;
  lockTimeoutMs?: number;
}

function isClaimStale(claim: StoryClaim, ttlMinutes: number): boolean {
  if (!isPidAlive(claim.pid)) return true;
  const heartbeatAge = Date.now() - new Date(claim.heartbeatAt).getTime();
  return heartbeatAge > ttlMinutes * 60 * 1000;
}

function loadClaims(path: string): ClaimsFile {
  if (!existsSync(path)) return { claims: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { claims: [] }; // best-effort: corrupted claims file is treated as empty
  }
}

export class ClaimsManager {
  private config: ClaimsManagerConfig;
  private lockPath: string;
  private lockTimeout: number;

  constructor(config: ClaimsManagerConfig) {
    this.config = config;
    this.lockPath = config.claimsPath + '.lock';
    this.lockTimeout = config.lockTimeoutMs ?? 5000;
  }

  /** Acquire lock, run callback, release lock. Throws on lock failure unless errorMsg is undefined. */
  private async withLock<T>(fn: () => T, errorMsg?: string): Promise<T | null> {
    const acquired = await acquireLock(this.lockPath, this.lockTimeout);
    if (!acquired) {
      if (errorMsg) throw new Error(errorMsg);
      return null;
    }
    try {
      return fn();
    } finally {
      await releaseLock(this.lockPath);
    }
  }

  async claimNextStory(runId: string, maxConsecutiveFailures?: number): Promise<Story | null> {
    return this.withLock(() => {
      const claimsFile = loadClaims(this.config.claimsPath);
      claimsFile.claims = claimsFile.claims.filter(
        c => !isClaimStale(c, this.config.ttlMinutes),
      );

      const prd = loadPrd(this.config.prdPath);
      const claimedIds = new Set(claimsFile.claims.map(c => c.storyId));
      const story = getNextStory(prd, claimedIds, maxConsecutiveFailures);

      if (!story) {
        atomicWriteJson(this.config.claimsPath, claimsFile);
        return null;
      }

      const now = new Date().toISOString();
      claimsFile.claims.push({
        storyId: story.id,
        runId,
        claimedAt: now,
        heartbeatAt: now,
        pid: process.pid,
      });
      atomicWriteJson(this.config.claimsPath, claimsFile);

      return story;
    }, 'Failed to acquire claims lock — another process may be stuck') as Promise<Story | null>;
  }

  async releaseStory(storyId: string, runId: string): Promise<void> {
    await this.withLock(() => {
      const claimsFile = loadClaims(this.config.claimsPath);
      claimsFile.claims = claimsFile.claims.filter(
        c => !(c.storyId === storyId && c.runId === runId),
      );
      atomicWriteJson(this.config.claimsPath, claimsFile);
    }, 'Failed to acquire claims lock for release');
  }

  async heartbeat(storyId: string, runId: string): Promise<boolean> {
    const result = await this.withLock(() => {
      const claimsFile = loadClaims(this.config.claimsPath);
      const claim = claimsFile.claims.find(
        c => c.storyId === storyId && c.runId === runId,
      );
      if (claim) {
        claim.heartbeatAt = new Date().toISOString();
        atomicWriteJson(this.config.claimsPath, claimsFile);
        return true;
      }
      return false;
    });
    return result ?? false; // null means lock failure, treat as false
  }
}
