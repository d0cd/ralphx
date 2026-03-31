import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Validator, type ValidatorConfig, sanitizeOutput, truncateForState } from '../src/core/validator.js';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeConfig(overrides: Partial<ValidatorConfig> = {}): ValidatorConfig {
  return {
    protectedPaths: ['AGENT.md', 'prd.json', 'runs/**', '.env', '.env.*', '**/*.lock'],
    qualityGates: {},
    projectRoot: '',
    ...overrides,
  };
}

describe('Validator', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ralphx-val-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('protected path checking', () => {
    it('no violation when only non-protected files changed', () => {
      const v = new Validator(makeConfig({ projectRoot: tmpDir }));
      const result = v.checkProtectedPaths(['src/index.ts', 'README.md']);
      expect(result.protectedPathsViolated).toHaveLength(0);
    });

    it('detects .env modification', () => {
      const v = new Validator(makeConfig({ projectRoot: tmpDir }));
      const result = v.checkProtectedPaths(['.env', 'src/index.ts']);
      expect(result.protectedPathsViolated).toContain('.env');
    });

    it('detects prd.json modification', () => {
      const v = new Validator(makeConfig({ projectRoot: tmpDir }));
      const result = v.checkProtectedPaths(['prd.json']);
      expect(result.protectedPathsViolated).toContain('prd.json');
    });

    it('glob patterns work for lockfiles', () => {
      const v = new Validator(makeConfig({ projectRoot: tmpDir }));
      const result = v.checkProtectedPaths(['yarn.lock', 'src/app.ts']);
      expect(result.protectedPathsViolated).toContain('yarn.lock');
    });

    it('glob patterns work for nested lockfiles', () => {
      const v = new Validator(makeConfig({ projectRoot: tmpDir }));
      const result = v.checkProtectedPaths(['packages/foo/pnpm-lock.lock']);
      expect(result.protectedPathsViolated).toContain('packages/foo/pnpm-lock.lock');
    });

    it('custom protected paths from config are honored', () => {
      const v = new Validator(makeConfig({
        projectRoot: tmpDir,
        protectedPaths: ['secret.key', 'certs/**'],
      }));
      const result = v.checkProtectedPaths(['secret.key', 'certs/tls.pem']);
      expect(result.protectedPathsViolated).toHaveLength(2);
    });

    it('.env.* pattern matches .env.local', () => {
      const v = new Validator(makeConfig({ projectRoot: tmpDir }));
      const result = v.checkProtectedPaths(['.env.local']);
      expect(result.protectedPathsViolated).toContain('.env.local');
    });

    it('returns empty violations for empty changed files list', () => {
      const v = new Validator(makeConfig({ projectRoot: tmpDir }));
      const result = v.checkProtectedPaths([]);
      expect(result.protectedPathsViolated).toHaveLength(0);
      expect(result.outsideProject).toHaveLength(0);
    });

    it('detects path traversal outside project directory', () => {
      const v = new Validator(makeConfig({ projectRoot: tmpDir }));
      const result = v.checkProtectedPaths(['../../etc/passwd']);
      expect(result.outsideProject).toHaveLength(1);
    });

    it('handles regex-special characters in patterns and paths', () => {
      const v = new Validator(makeConfig({
        projectRoot: tmpDir,
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
        projectRoot: tmpDir,
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
        projectRoot: tmpDir,
        qualityGates: { test: 'exit 1' },
      }));
      const result = await v.runQualityGates();
      expect(result.passed).toBe(false);
      expect(result.commandResults[0].passed).toBe(false);
      expect(result.commandResults[0].exitCode).toBe(1);
    });

    it('no quality gates configured skips command validation', async () => {
      const v = new Validator(makeConfig({ projectRoot: tmpDir, qualityGates: {} }));
      const result = await v.runQualityGates();
      expect(result.passed).toBe(true);
      expect(result.commandResults).toHaveLength(0);
    });

    it('command timeout is treated as failure', async () => {
      const v = new Validator(makeConfig({
        projectRoot: tmpDir,
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
      const v = new Validator(makeConfig({ projectRoot: tmpDir }));
      const files = Array.from({ length: 25 }, (_, i) => `file${i}.ts`);
      const result = v.checkDiffSanity(files, 5000);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some(w => w.includes('files changed'))).toBe(true);
    });

    it('large diff produces warning', () => {
      const v = new Validator(makeConfig({ projectRoot: tmpDir }));
      const result = v.checkDiffSanity(['a.ts'], 50000);
      expect(result.warnings.some(w => w.includes('diff'))).toBe(true);
    });

    it('small change has no warnings', () => {
      const v = new Validator(makeConfig({ projectRoot: tmpDir }));
      const result = v.checkDiffSanity(['a.ts'], 100);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe('path traversal security', () => {
    it('rejects ../ traversal to parent directory', () => {
      const v = new Validator(makeConfig({ projectRoot: tmpDir }));
      const result = v.checkProtectedPaths(['../../etc/passwd']);
      expect(result.outsideProject).toHaveLength(1);
      expect(result.outsideProject[0]).toBe('../../etc/passwd');
    });

    it('rejects complex traversal with intermediate dirs', () => {
      const v = new Validator(makeConfig({ projectRoot: tmpDir }));
      const result = v.checkProtectedPaths(['src/../../etc/shadow']);
      expect(result.outsideProject).toHaveLength(1);
    });

    it('rejects absolute paths outside project', () => {
      const v = new Validator(makeConfig({ projectRoot: tmpDir }));
      const result = v.checkProtectedPaths(['/etc/passwd']);
      expect(result.outsideProject).toHaveLength(1);
    });

    it('allows paths that stay inside project', () => {
      const v = new Validator(makeConfig({ projectRoot: tmpDir }));
      const result = v.checkProtectedPaths(['src/index.ts', 'lib/../src/app.ts']);
      expect(result.outsideProject).toHaveLength(0);
    });
  });

  describe('output sanitization', () => {
    it('truncates long output', () => {
      const long = 'x'.repeat(5000);
      expect(sanitizeOutput(long).length).toBeLessThanOrEqual(2000);
    });

    it('passes through clean output unchanged', () => {
      const output = 'All 42 tests passed in 3.5s';
      expect(sanitizeOutput(output)).toBe(output);
    });
  });

  describe('truncateForState', () => {
    it('returns undefined for undefined', () => {
      expect(truncateForState(undefined)).toBeUndefined();
    });

    it('returns short strings unchanged', () => {
      expect(truncateForState('short')).toBe('short');
    });

    it('truncates strings exceeding max length', () => {
      const long = 'x'.repeat(600);
      const result = truncateForState(long);
      expect(result!.length).toBeLessThan(600);
      expect(result).toContain('[truncated]');
    });

    it('respects custom max length', () => {
      const result = truncateForState('hello world', 5);
      expect(result).toBe('hello… [truncated]');
    });
  });

  describe('truncation data bounds', () => {
    it('sanitizeOutput prevents unbounded data in state', () => {
      const hugeOutput = 'x'.repeat(10000);
      const sanitized = sanitizeOutput(hugeOutput);
      expect(sanitized.length).toBeLessThanOrEqual(2000);
    });

    it('truncateForState limits error messages', () => {
      const longError = 'Error: '.repeat(1000);
      const truncated = truncateForState(longError);
      expect(truncated!.length).toBeLessThan(600); // default 500 + marker
      expect(truncated).toContain('[truncated]');
    });

    it('handles output that is exactly at truncation boundary', () => {
      const output = 'x'.repeat(2000);
      const sanitized = sanitizeOutput(output);
      expect(sanitized.length).toBe(2000);
    });

    it('handles output just over truncation boundary', () => {
      const output = 'x'.repeat(2001);
      const sanitized = sanitizeOutput(output);
      expect(sanitized.length).toBe(2000);
    });
  });

  describe('full validate', () => {
    it('protected path violations are warnings not failures', async () => {
      const v = new Validator(makeConfig({ projectRoot: tmpDir }));
      const result = await v.validate({
        changedFiles: ['.env'],
        diffSize: 50,
      });
      // Protected paths no longer block — they are warnings
      expect(result.passed).toBe(true);
      expect(result.protectedPathsViolated).toContain('.env');
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('Protected paths modified')]),
      );
    });

    it('gate failure still blocks even with protected path violation', async () => {
      const v = new Validator(makeConfig({
        projectRoot: tmpDir,
        qualityGates: { test: 'exit 1' },
      }));
      const result = await v.validate({
        changedFiles: ['.env'],
        diffSize: 50,
      });
      expect(result.passed).toBe(false);
      expect(result.protectedPathsViolated).toContain('.env');
      expect(result.reasons).toEqual(
        expect.arrayContaining([expect.stringContaining('Quality gates failed')]),
      );
      // Protected path is in warnings, not reasons
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('Protected paths modified')]),
      );
    });

    it('path traversal outside project is a hard failure', async () => {
      const v = new Validator(makeConfig({ projectRoot: tmpDir }));
      const result = await v.validate({
        changedFiles: ['../../etc/passwd'],
        diffSize: 50,
      });
      expect(result.passed).toBe(false);
      expect(result.reasons).toEqual(
        expect.arrayContaining([expect.stringContaining('Files outside project boundary')]),
      );
    });

    it('path traversal combined with protected path violation', async () => {
      const v = new Validator(makeConfig({ projectRoot: tmpDir }));
      const result = await v.validate({
        changedFiles: ['../../etc/passwd', '.env', 'src/app.ts'],
        diffSize: 50,
      });
      // Path traversal blocks, protected paths are warnings
      expect(result.passed).toBe(false);
      expect(result.reasons).toEqual(
        expect.arrayContaining([expect.stringContaining('Files outside project boundary')]),
      );
      expect(result.protectedPathsViolated).toContain('.env');
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('Protected paths modified')]),
      );
    });

    it('relative projectRoot causes gate failure', async () => {
      const v = new Validator(makeConfig({
        projectRoot: 'relative/path',
        qualityGates: { test: 'echo ok' },
      }));
      const result = await v.runQualityGates();
      expect(result.passed).toBe(false);
    });

    it('clean change passes', async () => {
      const v = new Validator(makeConfig({
        projectRoot: tmpDir,
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
