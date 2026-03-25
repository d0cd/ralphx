import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Validator, type ValidatorConfig } from '../src/core/validator.js';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeConfig(overrides: Partial<ValidatorConfig> = {}): ValidatorConfig {
  return {
    protectedPaths: ['.env', '.env.*', '**/*.lock', '.ralph/**'],
    qualityGates: {},
    projectDir: '',
    ...overrides,
  };
}

describe('Validator', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ralph-val-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('protected path checking', () => {
    it('no violation when only non-protected files changed', () => {
      const v = new Validator(makeConfig({ projectDir: tmpDir }));
      const result = v.checkProtectedPaths(['src/index.ts', 'README.md']);
      expect(result.protectedPathsViolated).toHaveLength(0);
    });

    it('detects .env modification', () => {
      const v = new Validator(makeConfig({ projectDir: tmpDir }));
      const result = v.checkProtectedPaths(['.env', 'src/index.ts']);
      expect(result.protectedPathsViolated).toContain('.env');
    });

    it('detects .ralph/prd.json modification', () => {
      const v = new Validator(makeConfig({ projectDir: tmpDir }));
      const result = v.checkProtectedPaths(['.ralph/prd.json']);
      expect(result.protectedPathsViolated).toContain('.ralph/prd.json');
    });

    it('glob patterns work for lockfiles', () => {
      const v = new Validator(makeConfig({ projectDir: tmpDir }));
      const result = v.checkProtectedPaths(['yarn.lock', 'src/app.ts']);
      expect(result.protectedPathsViolated).toContain('yarn.lock');
    });

    it('glob patterns work for nested lockfiles', () => {
      const v = new Validator(makeConfig({ projectDir: tmpDir }));
      const result = v.checkProtectedPaths(['packages/foo/pnpm-lock.lock']);
      expect(result.protectedPathsViolated).toContain('packages/foo/pnpm-lock.lock');
    });

    it('custom protected paths from config are honored', () => {
      const v = new Validator(makeConfig({
        projectDir: tmpDir,
        protectedPaths: ['secret.key', 'certs/**'],
      }));
      const result = v.checkProtectedPaths(['secret.key', 'certs/tls.pem']);
      expect(result.protectedPathsViolated).toHaveLength(2);
    });

    it('.env.* pattern matches .env.local', () => {
      const v = new Validator(makeConfig({ projectDir: tmpDir }));
      const result = v.checkProtectedPaths(['.env.local']);
      expect(result.protectedPathsViolated).toContain('.env.local');
    });

    it('returns empty violations for empty changed files list', () => {
      const v = new Validator(makeConfig({ projectDir: tmpDir }));
      const result = v.checkProtectedPaths([]);
      expect(result.protectedPathsViolated).toHaveLength(0);
      expect(result.outsideProject).toHaveLength(0);
    });

    it('detects path traversal outside project directory', () => {
      const v = new Validator(makeConfig({ projectDir: tmpDir }));
      const result = v.checkProtectedPaths(['../../etc/passwd']);
      expect(result.outsideProject).toHaveLength(1);
    });

    it('handles regex-special characters in patterns and paths', () => {
      const v = new Validator(makeConfig({
        projectDir: tmpDir,
        protectedPaths: ['keys(prod)', 'config[1]', 'a+b'],
      }));
      const result = v.checkProtectedPaths(['keys(prod)', 'config[1]', 'a+b', 'safe.ts']);
      expect(result.protectedPathsViolated).toHaveLength(3);
      expect(result.protectedPathsViolated).toContain('keys(prod)');
      expect(result.protectedPathsViolated).toContain('config[1]');
      expect(result.protectedPathsViolated).toContain('a+b');
    });
  });

  describe('command validation', () => {
    it('all commands pass yields passed=true', async () => {
      const v = new Validator(makeConfig({
        projectDir: tmpDir,
        qualityGates: { test: 'echo ok' },
      }));
      const result = await v.runQualityGates();
      expect(result.passed).toBe(true);
      expect(result.commandResults).toHaveLength(1);
      expect(result.commandResults[0].name).toBe('test');
      expect(result.commandResults[0].passed).toBe(true);
    });

    it('one command fails yields passed=false', async () => {
      const v = new Validator(makeConfig({
        projectDir: tmpDir,
        qualityGates: { test: 'exit 1' },
      }));
      const result = await v.runQualityGates();
      expect(result.passed).toBe(false);
      expect(result.commandResults[0].passed).toBe(false);
      expect(result.commandResults[0].exitCode).toBe(1);
    });

    it('no quality gates configured skips command validation', async () => {
      const v = new Validator(makeConfig({ projectDir: tmpDir, qualityGates: {} }));
      const result = await v.runQualityGates();
      expect(result.passed).toBe(true);
      expect(result.commandResults).toHaveLength(0);
    });

    it('command timeout is treated as failure', async () => {
      const v = new Validator(makeConfig({
        projectDir: tmpDir,
        qualityGates: { test: 'sleep 60' },
        commandTimeoutMs: 100,
      }));
      const result = await v.runQualityGates();
      expect(result.passed).toBe(false);
      expect(result.commandResults[0].passed).toBe(false);
    });
  });

  describe('diff sanity checks', () => {
    it('too many files changed produces warning', () => {
      const v = new Validator(makeConfig({ projectDir: tmpDir }));
      const files = Array.from({ length: 25 }, (_, i) => `file${i}.ts`);
      const result = v.checkDiffSanity(files, 5000);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some(w => w.includes('files changed'))).toBe(true);
    });

    it('large diff produces warning', () => {
      const v = new Validator(makeConfig({ projectDir: tmpDir }));
      const result = v.checkDiffSanity(['a.ts'], 50000);
      expect(result.warnings.some(w => w.includes('diff'))).toBe(true);
    });

    it('small change has no warnings', () => {
      const v = new Validator(makeConfig({ projectDir: tmpDir }));
      const result = v.checkDiffSanity(['a.ts'], 100);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe('full validate', () => {
    it('violations block completion', async () => {
      const v = new Validator(makeConfig({ projectDir: tmpDir }));
      const result = await v.validate({
        changedFiles: ['.env'],
        diffSize: 50,
      });
      expect(result.passed).toBe(false);
      expect(result.protectedPathsViolated).toContain('.env');
    });

    it('combines protected path and gate failure reasons', async () => {
      const v = new Validator(makeConfig({
        projectDir: tmpDir,
        qualityGates: { test: 'exit 1' },
      }));
      const result = await v.validate({
        changedFiles: ['.env'],
        diffSize: 50,
      });
      expect(result.passed).toBe(false);
      expect(result.reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Protected paths'),
          expect.stringContaining('Quality gates failed'),
        ]),
      );
    });

    it('clean change passes', async () => {
      const v = new Validator(makeConfig({
        projectDir: tmpDir,
        qualityGates: { test: 'echo ok' },
      }));
      const result = await v.validate({
        changedFiles: ['src/app.ts'],
        diffSize: 100,
      });
      expect(result.passed).toBe(true);
    });
  });
});
