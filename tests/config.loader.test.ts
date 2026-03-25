import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config/loader.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Config Loader', () => {
  let tmpDir: string;
  let ralphDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ralph-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    ralphDir = join(tmpDir, '.ralph');
    mkdirSync(ralphDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns defaults when no config file exists', () => {
    const config = loadConfig({ projectDir: tmpDir });
    expect(config.contextMode).toBe('continue');
    expect(config.timeoutMinutes).toBe(20);
    expect(config.cbNoProgressThreshold).toBe(3);
    expect(config.cbSameErrorThreshold).toBe(4);
    expect(config.cbCooldownMinutes).toBe(15);
    expect(config.verbose).toBe(false);
  });

  it('loads valid .ralphrc file', () => {
    writeFileSync(
      join(ralphDir, '.ralphrc'),
      JSON.stringify({ maxIterations: 10, maxCostUsd: 5.0, verbose: true }),
    );
    const config = loadConfig({ projectDir: tmpDir });
    expect(config.maxIterations).toBe(10);
    expect(config.maxCostUsd).toBe(5.0);
    expect(config.verbose).toBe(true);
    // defaults still apply
    expect(config.contextMode).toBe('continue');
  });

  it('env var overrides file value', () => {
    writeFileSync(
      join(ralphDir, '.ralphrc'),
      JSON.stringify({ maxIterations: 10 }),
    );
    const config = loadConfig({
      projectDir: tmpDir,
      env: { RALPH_MAX_ITERATIONS: '25' },
    });
    expect(config.maxIterations).toBe(25);
  });

  it('CLI flag overrides env var', () => {
    const config = loadConfig({
      projectDir: tmpDir,
      env: { RALPH_MAX_ITERATIONS: '25' },
      flags: { maxIterations: 50 },
    });
    expect(config.maxIterations).toBe(50);
  });

  it('invalid config throws with clear error', () => {
    writeFileSync(
      join(ralphDir, '.ralphrc'),
      JSON.stringify({ timeoutMinutes: -5 }),
    );
    expect(() => loadConfig({ projectDir: tmpDir })).toThrow();
  });

  it('partial config merges correctly with defaults', () => {
    writeFileSync(
      join(ralphDir, '.ralphrc'),
      JSON.stringify({ verbose: true }),
    );
    const config = loadConfig({ projectDir: tmpDir });
    expect(config.verbose).toBe(true);
    expect(config.timeoutMinutes).toBe(20);
    expect(config.contextMode).toBe('continue');
  });

  it('malformed JSON in .ralphrc throws with path in message', () => {
    writeFileSync(
      join(ralphDir, '.ralphrc'),
      '{ not valid json',
    );
    expect(() => loadConfig({ projectDir: tmpDir })).toThrow('Failed to load config from');
  });

  it('unknown keys are stripped', () => {
    writeFileSync(
      join(ralphDir, '.ralphrc'),
      JSON.stringify({ unknownKey: 'should be dropped', verbose: true }),
    );
    const config = loadConfig({ projectDir: tmpDir });
    expect(config.verbose).toBe(true);
    expect((config as any).unknownKey).toBeUndefined();
  });
});
