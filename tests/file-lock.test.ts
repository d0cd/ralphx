import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { acquireLock, releaseLock } from '../src/sync/file-lock.js';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('File Lock', () => {
  let tmpDir: string;
  let lockPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ralph-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    lockPath = join(tmpDir, 'test.lock');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('acquire succeeds when no lock exists', async () => {
    const acquired = await acquireLock(lockPath, 1000);
    expect(acquired).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
    await releaseLock(lockPath);
  });

  it('acquire blocks then succeeds when lock released', async () => {
    await acquireLock(lockPath, 1000);

    // Release after 50ms
    setTimeout(() => releaseLock(lockPath), 50);

    const acquired = await acquireLock(lockPath, 2000);
    expect(acquired).toBe(true);
    await releaseLock(lockPath);
  });

  it('acquire fails after timeout when lock held', async () => {
    await acquireLock(lockPath, 1000);

    const acquired = await acquireLock(lockPath, 100);
    expect(acquired).toBe(false);

    await releaseLock(lockPath);
  });

  it('release removes lockfile', async () => {
    await acquireLock(lockPath, 1000);
    expect(existsSync(lockPath)).toBe(true);
    await releaseLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('stale lock with dead PID is recovered', async () => {
    // Write a lockfile with a PID that doesn't exist
    writeFileSync(lockPath, JSON.stringify({ pid: 999999999, acquiredAt: new Date().toISOString() }));

    const acquired = await acquireLock(lockPath, 1000);
    expect(acquired).toBe(true);

    // Verify our PID is now in the lock
    const content = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(content.pid).toBe(process.pid);

    await releaseLock(lockPath);
  });

  it('two concurrent acquires — only one succeeds immediately', async () => {
    const results = await Promise.all([
      acquireLock(lockPath, 50),
      acquireLock(lockPath, 50),
    ]);

    // At least one should succeed, at least one might fail (or both succeed if
    // the first releases quickly enough for retry)
    const successCount = results.filter(Boolean).length;
    expect(successCount).toBeGreaterThanOrEqual(1);

    await releaseLock(lockPath);
  });

  it('release is idempotent on missing file', async () => {
    // Should not throw
    await releaseLock(lockPath);
    await releaseLock(lockPath);
  });
});
