import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export function readHint(runDir: string): string | null {
  const hintPath = join(runDir, 'hint.md');

  let content: string;
  try {
    content = readFileSync(hintPath, 'utf-8');
  } catch {
    return null;
  }

  // Delete after reading so the hint is consumed only once
  try {
    unlinkSync(hintPath);
  } catch {
    // Best effort — hint may have been consumed by another read
  }

  const trimmed = content.trim();
  return trimmed.length > 0 ? trimmed : null;
}
