import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Dirent } from 'node:fs';
import { readJsonFile } from '../sync/atomic-write.js';
import type { RunState } from '../types/state.js';

/**
 * Validate that a user-provided path segment (workspace name, run ID, workflow name)
 * does not contain path traversal sequences or characters that could escape the
 * intended directory. Rejects:
 * - Empty/whitespace-only values
 * - Null bytes (truncate paths in native FS calls)
 * - Path separators (/ or \) that could navigate to other directories
 * - ".." sequences (parent directory traversal)
 * - Control characters that could confuse filesystem or terminal
 */
export function validatePathSegment(value: string, label: string): void {
  if (!value || !value.trim()) {
    throw new Error(`${label} must not be empty`);
  }
  if (value.includes('\0')) {
    throw new Error(`${label} contains null bytes: ${JSON.stringify(value)}`);
  }
  if (value.includes('/') || value.includes('\\')) {
    throw new Error(`${label} must not contain path separators: ${JSON.stringify(value)}`);
  }
  if (value.includes('..')) {
    throw new Error(`${label} must not contain path traversal (..): ${JSON.stringify(value)}`);
  }
  // Reject control characters (0x00-0x1f, 0x7f) — these can confuse
  // filesystem APIs and terminal rendering
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} contains control characters: ${JSON.stringify(value)}`);
  }
}

export function resolveProjectDir(): string {
  return process.cwd();
}

/** Resolve workspace directory: .ralphx/<workspace>/ */
export function getWorkspaceDir(projectDir: string, workspace: string): string {
  validatePathSegment(workspace, 'Workspace name');
  return join(projectDir, '.ralphx', workspace);
}

export function getRunsDir(projectDir: string, workspace: string): string {
  return join(getWorkspaceDir(projectDir, workspace), 'runs');
}

export function findLatestRun(projectDir: string, workspace: string): string | null {
  const runsDir = getRunsDir(projectDir, workspace);
  if (!existsSync(runsDir)) return null;

  let dirEntries: Dirent[];
  try {
    dirEntries = readdirSync(runsDir, { withFileTypes: true });
  } catch (err) {
    console.error(`Failed to read runs directory ${runsDir}: ${(err instanceof Error ? err.message : String(err))}`);
    console.error(`Re-initialize with: ralphx init ${workspace}`);
    return null;
  }

  const entries = dirEntries
    .filter(e => e.isDirectory())
    .map(e => {
      const statePath = join(runsDir, e.name, 'run-state.json');
      if (!existsSync(statePath)) return null;
      try {
        const state = readJsonFile<RunState>(statePath);
        return { name: e.name, updatedAt: state.updatedAt ?? '' };
      } catch (err) {
        console.error(`Warning: could not read ${statePath}: ${(err instanceof Error ? err.message : String(err))}`);
        return null;
      }
    })
    .filter((e): e is { name: string; updatedAt: string } => e !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return entries[0]?.name ?? null;
}

export function loadRunState(projectDir: string, workspace: string, runId: string): RunState | null {
  const statePath = join(getRunsDir(projectDir, workspace), runId, 'run-state.json');
  try {
    // Use default value so readJsonFile returns null on ENOENT (file missing)
    // without wrapping it in a new Error.
    return readJsonFile<RunState | null>(statePath, null);
  } catch (err) {
    // Corrupt JSON or permission errors — surface for operator investigation
    console.error(`Warning: could not load run state for "${runId}": ${(err instanceof Error ? err.message : String(err))}`);
    return null;
  }
}
