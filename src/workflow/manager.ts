import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { validatePathSegment } from '../cli/helpers.js';

const WORKFLOW_FILES = ['PROMPT.md', 'AGENT.md', '.ralphxrc', 'prd.json'];

function getWorkflowsDir(): string {
  return join(homedir(), '.ralphx', 'workflows');
}

export function saveWorkflow(name: string, wsDir: string): void {
  validatePathSegment(name, 'Workflow name');
  if (!existsSync(wsDir)) {
    throw new Error('Workspace directory not found. Create workspace files first (see `ralphx --agent-help`).');
  }

  const destDir = join(getWorkflowsDir(), name);
  try {
    mkdirSync(destDir, { recursive: true });
  } catch (e) {
    throw new Error(`Failed to create workflow directory ${destDir}: ${(e instanceof Error ? e.message : String(e))}`);
  }

  let copied = 0;
  for (const file of WORKFLOW_FILES) {
    const src = join(wsDir, file);
    if (existsSync(src)) {
      try {
        copyFileSync(src, join(destDir, file));
      } catch (e) {
        throw new Error(`Failed to copy workflow file ${src} to ${destDir}: ${(e instanceof Error ? e.message : String(e))}`);
      }
      copied++;
    }
  }

  if (copied === 0) {
    throw new Error('No workflow files found to save.');
  }
}

export function useWorkflow(name: string, wsDir: string): void {
  validatePathSegment(name, 'Workflow name');
  const srcDir = join(getWorkflowsDir(), name);
  if (!existsSync(srcDir)) {
    throw new Error(`Workflow "${name}" not found. Use \`ralphx workflow list\` to see available workflows.`);
  }

  try {
    mkdirSync(join(wsDir, 'runs'), { recursive: true });
  } catch (e) {
    throw new Error(`Failed to create directory ${join(wsDir, 'runs')}: ${(e instanceof Error ? e.message : String(e))}`);
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(srcDir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`Failed to read workflow directory ${srcDir}: ${(e instanceof Error ? e.message : String(e))}`);
  }

  const files = entries.filter(e => e.isFile()).map(e => e.name);
  for (const file of files) {
    try {
      copyFileSync(join(srcDir, file), join(wsDir, file));
    } catch (e) {
      throw new Error(`Failed to copy workflow file ${file} to ${wsDir}: ${(e instanceof Error ? e.message : String(e))}`);
    }
  }
}

interface WorkflowInfo {
  name: string;
  files: string[];
  createdAt: string;
}

export function listWorkflows(): WorkflowInfo[] {
  const dir = getWorkflowsDir();
  if (!existsSync(dir)) return [];

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`Failed to read workflows directory ${dir}: ${(e instanceof Error ? e.message : String(e))}`);
  }

  return entries
    .filter(e => e.isDirectory())
    .map(e => {
      const workflowDir = join(dir, e.name);
      try {
        const files = readdirSync(workflowDir);
        const stat = statSync(workflowDir);
        return {
          name: e.name,
          files,
          createdAt: stat.mtime.toISOString(),
        };
      } catch {
        // Best-effort: skip workflows we can't read
        return {
          name: e.name,
          files: [] as string[],
          createdAt: new Date(0).toISOString(),
        };
      }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
