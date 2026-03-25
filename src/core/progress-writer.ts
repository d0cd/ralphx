import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

interface ProgressEntry {
  iteration: number;
  round: number;
  storyId: string;
  storyTitle: string;
  passed: boolean;
  summary: string;
  gateResults: Array<{ name: string; passed: boolean }>;
  timestamp: string;
}

export function appendProgress(projectDir: string, entry: ProgressEntry): void {
  const progressPath = join(projectDir, '.ralph', 'progress.md');

  const gates = entry.gateResults.length > 0
    ? entry.gateResults.map(g => `${g.name}: ${g.passed ? 'pass' : 'FAIL'}`).join(', ')
    : 'none configured';

  const line = [
    `## Iteration ${entry.iteration} (Round ${entry.round}) — [${entry.storyId}] ${entry.storyTitle}`,
    `- **Time**: ${entry.timestamp}`,
    `- **Result**: ${entry.passed ? 'PASSED' : 'FAILED'}`,
    `- **Gates**: ${gates}`,
    entry.summary ? `- **Summary**: ${entry.summary}` : null,
    '',
  ].filter(Boolean).join('\n');

  try {
    appendFileSync(progressPath, line + '\n');
  } catch {
    // Best-effort — don't crash the loop over progress logging
  }
}

export function readProgress(projectDir: string): string | null {
  const progressPath = join(projectDir, '.ralph', 'progress.md');
  if (!existsSync(progressPath)) return null;
  try {
    const content = readFileSync(progressPath, 'utf-8').trim();
    return content.length > 0 ? content : null;
  } catch {
    return null; // best-effort: progress file may be corrupted or removed mid-read
  }
}
