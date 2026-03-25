import { writeFileSync, unlinkSync, readFileSync, openSync, closeSync, constants } from 'node:fs';
import { isPidAlive } from './pid-utils.js';

interface LockContent {
  pid: number;
  acquiredAt: string;
}

function tryCreateLock(lockPath: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    const content: LockContent = { pid: process.pid, acquiredAt: new Date().toISOString() };
    writeFileSync(fd, JSON.stringify(content));
    return true;
  } catch {
    return false; // Lock file already exists (held by another process) — expected contention
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already closed or invalid */ }
    }
  }
}

function tryRecoverStaleLock(lockPath: string): boolean {
  try {
    const raw = readFileSync(lockPath, 'utf-8');
    const content: LockContent = JSON.parse(raw);
    if (!isPidAlive(content.pid)) {
      try { unlinkSync(lockPath); } catch { return false; /* best-effort: stale lock removal may race with another process */ }
      return true;
    }
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    // Corrupt lockfile — try to remove it
    try { unlinkSync(lockPath); return true; } catch { return false; /* best-effort: corrupt lock removal may race */ }
  }

  return false;
}

export async function acquireLock(lockPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const retryInterval = 20;

  while (Date.now() < deadline) {
    if (tryCreateLock(lockPath)) {
      return true;
    }

    tryRecoverStaleLock(lockPath);

    await new Promise(resolve => setTimeout(resolve, retryInterval));
  }

  // One final attempt
  return tryCreateLock(lockPath);
}

export async function releaseLock(lockPath: string): Promise<void> {
  try {
    unlinkSync(lockPath);
  } catch {
    // Lock already removed — fine
  }
}
