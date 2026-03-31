import { join } from 'node:path';
import type { RunState, RunStatus } from '../types/state.js';
import { atomicWriteJson, readJsonFile } from '../sync/atomic-write.js';
import { log } from './logger.js';

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const RESUMABLE_STATUSES: Set<RunStatus> = new Set(['interrupted', 'paused']);

export function canResume(status: RunStatus): boolean {
  return RESUMABLE_STATUSES.has(status);
}

/**
 * Check if a run with 'running' status is actually stale (owner process is dead).
 * This handles the case where a process was killed (SIGKILL) without setting
 * a final status — the state file still says 'running' but the PID is dead.
 */
export function isStaleRunning(state: RunState): boolean {
  return state.status === 'running' && !isPidAlive(state.pid);
}

export function findResumableRun(projectDir: string, runId: string): RunState | null {
  const statePath = join(projectDir, 'runs', runId, 'run-state.json');

  const state = readJsonFile<RunState | null>(statePath, null);
  if (!state) return null;

  // A 'running' state with a dead PID means the process crashed —
  // treat it as interrupted so it can be resumed.
  // Persist the corrected status so that repeated lookups or crashes
  // before the next flush don't leave a stale 'running' on disk.
  if (isStaleRunning(state)) {
    state.status = 'interrupted';
    state.updatedAt = new Date().toISOString();
    try { atomicWriteJson(statePath, state); } catch (e) {
      // Log the failure so operators know the stale status wasn't corrected on disk.
      // The in-memory correction still allows resume, but repeated lookups before
      // the next flush will re-detect and re-correct.
      log.warn(`Failed to persist corrected run status: ${e instanceof Error ? e.message : String(e)}`);
    }
    return state;
  }

  if (!canResume(state.status)) {
    return null;
  }

  return state;
}
