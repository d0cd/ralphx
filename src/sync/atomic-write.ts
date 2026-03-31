import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Read and parse a JSON file. Returns the default value on ENOENT,
 * throws a descriptive error on parse or other I/O failures.
 */
export function readJsonFile<T>(path: string, defaultValue: T): T;
export function readJsonFile<T>(path: string): T;
export function readJsonFile<T>(path: string, defaultValue?: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    if (defaultValue !== undefined && e !== null && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'ENOENT') return defaultValue;
    throw new Error(`Failed to read JSON from ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

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
    try { unlinkSync(tmpPath); } catch { /* best effort cleanup — file may not exist */ }
    throw new Error(`Failed to write ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
