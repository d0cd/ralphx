import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Atomically write JSON data to a file using write-to-temp + rename.
 * This prevents partial writes from corrupting the target file.
 */
export function atomicWriteJson(path: string, data: unknown): void {
  const tmpPath = join(dirname(path), `.tmp-${randomBytes(4).toString('hex')}.json`);
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, path);
  } catch (e) {
    try { unlinkSync(tmpPath); } catch { /* best effort cleanup */ }
    throw new Error(`Failed to write ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
