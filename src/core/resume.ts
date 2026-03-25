import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RunState, RunStatus } from '../types/state.js';

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
  const statePath = join(projectDir, '.ralph', 'runs', runId, 'run-state.json');
  if (!existsSync(statePath)) return null;

  let state: RunState;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch (e) {
    throw new Error(`Failed to read run state for "${runId}": ${e instanceof Error ? e.message : String(e)}`);
  }

  // A 'running' state with a dead PID means the process crashed —
  // treat it as interrupted so it can be resumed.
  if (isStaleRunning(state)) {
    state.status = 'interrupted';
    return state;
  }

  if (!canResume(state.status)) {
    return null;
  }

  return state;
}
