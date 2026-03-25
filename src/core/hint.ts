import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function readHint(runDir: string): string | null {
  const hintPath = join(runDir, 'hint.md');
  if (!existsSync(hintPath)) return null;

  let content: string;
  try {
    content = readFileSync(hintPath, 'utf-8');
  } catch {
    return null;
  }

  // Delete atomically after reading
  try {
    unlinkSync(hintPath);
  } catch {
    // Best effort — hint may have been consumed by another read
  }

  const trimmed = content.trim();
  return trimmed.length > 0 ? trimmed : null;
}
