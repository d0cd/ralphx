import { execSync } from 'node:child_process';
import { resolve, normalize } from 'node:path';
import type { ValidationResult } from '../types/state.js';

export interface ValidatorConfig {
  protectedPaths: string[];
  qualityGates: { typecheck?: string; lint?: string; test?: string };
  projectRoot: string;
  commandTimeoutMs?: number;
}

interface ValidateInput { changedFiles: string[]; diffSize: number }

const MAX_FILES_WARNING = 20;
const MAX_DIFF_SIZE_WARNING = 10000;
const MAX_OUTPUT_SUMMARY_LENGTH = 2000;

const minimatchCache = new Map<string, RegExp>();
function minimatch(path: string, pattern: string): boolean {
  let re = minimatchCache.get(pattern);
  if (!re) {
    const regex = pattern
      .replace(/\*\*\//g, '\0GS\0').replace(/\*\*/g, '\0G\0')
      .replace(/\*/g, '\0S\0').replace(/\?/g, '\0Q\0')
      .replace(/[.+(){}[\]^$|\\]/g, '\\$&')
      .replace(/\0GS\0/g, '(?:.*/)?').replace(/\0G\0/g, '.*')
      .replace(/\0S\0/g, '[^/]*').replace(/\0Q\0/g, '.');
    re = new RegExp(`^${regex}$`);
    minimatchCache.set(pattern, re);
  }
  return re.test(path);
}

export class Validator {
  private config: ValidatorConfig;
  constructor(config: ValidatorConfig) { this.config = config; }

  private normalizePath(filePath: string): string {
    return normalize(filePath).replace(/^[/\\]+/, '');
  }

  private isOutsideProject(filePath: string): boolean {
    if (filePath.startsWith('/') || filePath.startsWith('\\')) return true;
    if (normalize(filePath).startsWith('..')) return true;
    const absProject = resolve(this.config.projectRoot);
    const absFile = resolve(this.config.projectRoot, filePath);
    return !absFile.startsWith(absProject + '/') && absFile !== absProject;
  }

  checkProtectedPaths(changedFiles: string[]): { protectedPathsViolated: string[]; outsideProject: string[] } {
    const violated: string[] = [];
    const outsideProject: string[] = [];
    for (const file of changedFiles) {
      if (this.isOutsideProject(file)) { outsideProject.push(file); continue; }
      const normalized = this.normalizePath(file);
      for (const pattern of this.config.protectedPaths) {
        if (minimatch(normalized, pattern)) { violated.push(file); break; }
      }
    }
    return { protectedPathsViolated: violated, outsideProject };
  }

  async runQualityGates(): Promise<{
    passed: boolean;
    commandResults: Array<{ name: string; passed: boolean; exitCode: number; outputSummary?: string }>;
  }> {
    const entries = Object.entries(this.config.qualityGates).filter(([_, cmd]) => cmd);
    const commandResults: Array<{ name: string; passed: boolean; exitCode: number; outputSummary?: string }> = [];
    if (entries.length === 0) return { passed: true, commandResults: [] };

    const cwd = resolve(this.config.projectRoot);
    for (const [name, cmd] of entries) {
      try {
        const output = execSync(cmd!, {
          cwd, encoding: 'utf-8',
          timeout: this.config.commandTimeoutMs ?? 300000,
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024,
        });
        commandResults.push({ name, passed: true, exitCode: 0, outputSummary: sanitizeOutput(output) });
      } catch (err: unknown) {
        const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
        commandResults.push({
          name, passed: false, exitCode: e.status ?? 1,
          outputSummary: sanitizeOutput(e.stdout ?? e.stderr ?? e.message ?? ''),
        });
      }
    }
    return { passed: commandResults.every(r => r.passed), commandResults };
  }

  checkDiffSanity(changedFiles: string[], diffSize: number): { warnings: string[] } {
    const warnings: string[] = [];
    if (changedFiles.length > MAX_FILES_WARNING) warnings.push(`${changedFiles.length} files changed — this is unusually large`);
    if (diffSize > MAX_DIFF_SIZE_WARNING) warnings.push(`diff size ${diffSize} lines — this is an unusually large diff`);
    return { warnings };
  }

  async validate(input: ValidateInput): Promise<ValidationResult> {
    const pathCheck = this.checkProtectedPaths(input.changedFiles);
    const gateResult = await this.runQualityGates();
    const sanity = this.checkDiffSanity(input.changedFiles, input.diffSize);

    const reasons: string[] = [];
    if (pathCheck.outsideProject.length > 0) {
      reasons.push(`Files outside project boundary: ${pathCheck.outsideProject.join(', ')}`);
    }
    if (pathCheck.protectedPathsViolated.length > 0) {
      sanity.warnings.push(`Protected paths modified: ${pathCheck.protectedPathsViolated.join(', ')}`);
    }
    if (!gateResult.passed) {
      const failed = gateResult.commandResults.filter(r => !r.passed).map(r => r.name);
      reasons.push(`Quality gates failed: ${failed.join(', ')}`);
    }
    return {
      passed: gateResult.passed && pathCheck.outsideProject.length === 0,
      commandResults: gateResult.commandResults,
      protectedPathsViolated: pathCheck.protectedPathsViolated,
      warnings: sanity.warnings,
      reasons,
    };
  }
}

export function sanitizeOutput(raw: string): string {
  return raw.slice(0, MAX_OUTPUT_SUMMARY_LENGTH);
}

export function truncateForState(value: string | undefined, maxLength = 500): string | undefined {
  if (!value) return value;
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength) + '… [truncated]';
}
