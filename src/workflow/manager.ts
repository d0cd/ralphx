import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const WORKFLOW_FILES = ['PROMPT.md', 'AGENT.md', '.ralphrc', 'prd.json'];

function getWorkflowsDir(): string {
  return join(homedir(), '.ralph', 'workflows');
}

export function saveWorkflow(name: string, projectDir: string): void {
  const ralphDir = join(projectDir, '.ralph');
  if (!existsSync(ralphDir)) {
    throw new Error('No .ralph/ directory found. Run `ralph init` first.');
  }

  const destDir = join(getWorkflowsDir(), name);
  try {
    mkdirSync(destDir, { recursive: true });
  } catch (e) {
    throw new Error(`Failed to create workflow directory ${destDir}: ${e instanceof Error ? e.message : String(e)}`);
  }

  let copied = 0;
  for (const file of WORKFLOW_FILES) {
    const src = join(ralphDir, file);
    if (existsSync(src)) {
      try {
        copyFileSync(src, join(destDir, file));
      } catch (e) {
        throw new Error(`Failed to copy workflow file ${src} to ${destDir}: ${e instanceof Error ? e.message : String(e)}`);
      }
      copied++;
    }
  }

  if (copied === 0) {
    throw new Error('No workflow files found to save.');
  }
}

export function useWorkflow(name: string, projectDir: string): void {
  const srcDir = join(getWorkflowsDir(), name);
  if (!existsSync(srcDir)) {
    throw new Error(`Workflow "${name}" not found. Use \`ralph workflow list\` to see available workflows.`);
  }

  const ralphDir = join(projectDir, '.ralph');
  try {
    mkdirSync(join(ralphDir, 'runs'), { recursive: true });
  } catch (e) {
    throw new Error(`Failed to create directory ${join(ralphDir, 'runs')}: ${e instanceof Error ? e.message : String(e)}`);
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(srcDir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`Failed to read workflow directory ${srcDir}: ${e instanceof Error ? e.message : String(e)}`);
  }

  const files = entries.filter(e => e.isFile()).map(e => e.name);
  for (const file of files) {
    try {
      copyFileSync(join(srcDir, file), join(ralphDir, file));
    } catch (e) {
      throw new Error(`Failed to copy workflow file ${file} to ${ralphDir}: ${e instanceof Error ? e.message : String(e)}`);
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
    throw new Error(`Failed to read workflows directory ${dir}: ${e instanceof Error ? e.message : String(e)}`);
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

export function getWorkflowDetail(name: string): { prdSummary?: string } | null {
  const dir = join(getWorkflowsDir(), name);
  if (!existsSync(dir)) return null;

  const prdPath = join(dir, 'prd.json');
  if (!existsSync(prdPath)) return {};

  try {
    const prd = JSON.parse(readFileSync(prdPath, 'utf-8'));
    const storyCount = prd.stories?.length ?? 0;
    return { prdSummary: `${prd.projectName ?? 'unnamed'}: ${storyCount} stories` };
  } catch {
    return {}; // best-effort: corrupted prd.json in workflow is non-fatal
  }
}
