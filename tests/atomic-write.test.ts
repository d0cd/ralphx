import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { atomicWriteJson } from '../src/sync/atomic-write.js';
import { readFileSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('atomicWriteJson', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ralph-atomic-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes JSON data to a new file', () => {
    const filePath = join(tmpDir, 'test.json');
    const data = { name: 'ralph', version: 1, items: [1, 2, 3] };

    atomicWriteJson(filePath, data);

    const result = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(result).toEqual(data);
  });

  it('writes pretty-printed JSON with 2-space indent', () => {
    const filePath = join(tmpDir, 'pretty.json');
    atomicWriteJson(filePath, { a: 1 });

    const raw = readFileSync(filePath, 'utf-8');
    expect(raw).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it('overwrites existing file atomically', () => {
    const filePath = join(tmpDir, 'overwrite.json');
    writeFileSync(filePath, JSON.stringify({ old: true }));

    atomicWriteJson(filePath, { new: true });

    const result = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(result).toEqual({ new: true });
  });

  it('does not leave temp files on success', () => {
    const filePath = join(tmpDir, 'clean.json');
    atomicWriteJson(filePath, { data: true });

    const files = readdirSync(tmpDir);
    expect(files).toEqual(['clean.json']);
  });

  it('throws on non-serializable data (circular reference)', () => {
    const filePath = join(tmpDir, 'circular.json');
    const obj: any = {};
    obj.self = obj;

    expect(() => atomicWriteJson(filePath, obj)).toThrow('Failed to write');
  });

  it('does not leave temp files on failure', () => {
    const filePath = join(tmpDir, 'fail.json');
    const obj: any = {};
    obj.self = obj;

    try { atomicWriteJson(filePath, obj); } catch { /* expected */ }

    const files = readdirSync(tmpDir);
    expect(files).toHaveLength(0);
  });

  it('throws when parent directory does not exist', () => {
    const filePath = join(tmpDir, 'nonexistent', 'sub', 'file.json');
    expect(() => atomicWriteJson(filePath, { data: true })).toThrow('Failed to write');
  });

  it('handles null and primitive values', () => {
    const filePath = join(tmpDir, 'null.json');
    atomicWriteJson(filePath, null);
    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toBeNull();

    const numPath = join(tmpDir, 'num.json');
    atomicWriteJson(numPath, 42);
    expect(JSON.parse(readFileSync(numPath, 'utf-8'))).toBe(42);
  });

  it('handles empty object and array', () => {
    const objPath = join(tmpDir, 'empty-obj.json');
    atomicWriteJson(objPath, {});
    expect(JSON.parse(readFileSync(objPath, 'utf-8'))).toEqual({});

    const arrPath = join(tmpDir, 'empty-arr.json');
    atomicWriteJson(arrPath, []);
    expect(JSON.parse(readFileSync(arrPath, 'utf-8'))).toEqual([]);
  });
});
