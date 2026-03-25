import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readHint } from '../src/core/hint.js';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Hint Injection', () => {
  let tmpDir: string;
  let runDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ralph-hint-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    runDir = join(tmpDir, '.ralph', 'runs', 'test-run');
    mkdirSync(runDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns hint content and deletes file', () => {
    const hintPath = join(runDir, 'hint.md');
    writeFileSync(hintPath, 'Focus on auth first');

    const hint = readHint(runDir);
    expect(hint).toBe('Focus on auth first');
    expect(existsSync(hintPath)).toBe(false);
  });

  it('returns null when no hint file exists', () => {
    expect(readHint(runDir)).toBeNull();
  });

  it('returns null and deletes empty hint file', () => {
    const hintPath = join(runDir, 'hint.md');
    writeFileSync(hintPath, '');

    const hint = readHint(runDir);
    expect(hint).toBeNull();
    expect(existsSync(hintPath)).toBe(false);
  });

  it('returns null and deletes whitespace-only hint file', () => {
    const hintPath = join(runDir, 'hint.md');
    writeFileSync(hintPath, '   \n  \n  ');

    const hint = readHint(runDir);
    expect(hint).toBeNull();
    expect(existsSync(hintPath)).toBe(false);
  });
});
