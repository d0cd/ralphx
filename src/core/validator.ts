import { execSync } from 'node:child_process';
import { resolve, normalize } from 'node:path';
import type { ValidationResult } from '../types/state.js';

export interface ValidatorConfig {
  protectedPaths: string[];
  qualityGates: {
    typecheck?: string;
    lint?: string;
    test?: string;
  };
  projectDir: string;
  commandTimeoutMs?: number;
}

interface ValidateInput {
  changedFiles: string[];
  diffSize: number;
}

const MAX_FILES_WARNING = 20;
const MAX_DIFF_SIZE_WARNING = 10000;

function minimatch(path: string, pattern: string): boolean {
  // Convert glob pattern to regex — order matters: handle glob tokens before escaping dots
  let regex = pattern
    .replace(/\*\*\//g, '\0GLOBSTAR_SLASH\0')  // placeholder for **/
    .replace(/\*\*/g, '\0GLOBSTAR\0')           // placeholder for **
    .replace(/\*/g, '\0STAR\0')                 // placeholder for *
    .replace(/\?/g, '\0QUESTION\0')             // placeholder for ?
    .replace(/[.+(){}[\]^$|\\]/g, '\\$&')         // escape regex-special chars
    .replace(/\0GLOBSTAR_SLASH\0/g, '(?:.*/)?') // **/ = zero or more dirs
    .replace(/\0GLOBSTAR\0/g, '.*')             // ** = anything
    .replace(/\0STAR\0/g, '[^/]*')              // * = one segment
    .replace(/\0QUESTION\0/g, '.');              // ? = one char
  return new RegExp(`^${regex}$`).test(path);
}

export class Validator {
  private config: ValidatorConfig;

  constructor(config: ValidatorConfig) {
    this.config = config;
  }

  /**
   * Normalize a file path to prevent traversal bypass:
   * - Resolve ../ sequences
   * - Strip leading slashes (paths should be repo-relative)
   * - Reject paths that escape the project directory
   */
  private normalizePath(filePath: string): string {
    // Normalize to collapse ../ and ./ sequences
    let normalized = normalize(filePath);
    // Strip leading path separator to keep paths repo-relative
    normalized = normalized.replace(/^[/\\]+/, '');
    return normalized;
  }

  /**
   * Check if a file path escapes the project directory.
   * Returns true if the resolved path is outside projectDir.
   */
  private isOutsideProject(filePath: string): boolean {
    if (!this.config.projectDir) return false;
    const absProject = resolve(this.config.projectDir);
    const absFile = resolve(this.config.projectDir, filePath);
    return !absFile.startsWith(absProject + '/') && absFile !== absProject;
  }

  checkProtectedPaths(changedFiles: string[]): { protectedPathsViolated: string[]; outsideProject: string[] } {
    const violated: string[] = [];
    const outsideProject: string[] = [];

    for (const file of changedFiles) {
      const normalized = this.normalizePath(file);

      // Reject any file outside project directory
      if (this.isOutsideProject(normalized)) {
        outsideProject.push(file);
        continue;
      }

      for (const pattern of this.config.protectedPaths) {
        if (minimatch(normalized, pattern)) {
          violated.push(file);
          break;
        }
      }
    }
    return { protectedPathsViolated: violated, outsideProject };
  }

  async runQualityGates(): Promise<{
    passed: boolean;
    commandResults: Array<{ name: string; passed: boolean; exitCode: number; outputSummary?: string }>;
  }> {
    const gates = this.config.qualityGates;
    const entries = Object.entries(gates).filter(([_, cmd]) => cmd);
    const commandResults: Array<{ name: string; passed: boolean; exitCode: number; outputSummary?: string }> = [];

    if (entries.length === 0) {
      return { passed: true, commandResults: [] };
    }

    for (const [name, cmd] of entries) {
      if (!cmd) continue;
      try {
        const output = execSync(cmd, {
          cwd: this.config.projectDir,
          encoding: 'utf-8',
          timeout: this.config.commandTimeoutMs ?? 300000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        commandResults.push({
          name,
          passed: true,
          exitCode: 0,
          outputSummary: output.slice(0, 500),
        });
      } catch (err: unknown) {
        const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
        commandResults.push({
          name,
          passed: false,
          exitCode: e.status ?? 1,
          outputSummary: (e.stdout ?? e.stderr ?? e.message ?? '').slice(0, 500),
        });
      }
    }

    return {
      passed: commandResults.every(r => r.passed),
      commandResults,
    };
  }

  checkDiffSanity(changedFiles: string[], diffSize: number): { warnings: string[] } {
    const warnings: string[] = [];

    if (changedFiles.length > MAX_FILES_WARNING) {
      warnings.push(`${changedFiles.length} files changed — this is unusually large`);
    }

    if (diffSize > MAX_DIFF_SIZE_WARNING) {
      warnings.push(`diff size ${diffSize} lines — this is an unusually large diff`);
    }

    return { warnings };
  }

  async validate(input: ValidateInput): Promise<ValidationResult> {
    const pathCheck = this.checkProtectedPaths(input.changedFiles);
    const gateResult = await this.runQualityGates();
    const sanity = this.checkDiffSanity(input.changedFiles, input.diffSize);

    const reasons: string[] = [];
    if (pathCheck.protectedPathsViolated.length > 0) {
      reasons.push(`Protected paths modified: ${pathCheck.protectedPathsViolated.join(', ')}`);
    }
    if (!gateResult.passed) {
      const failed = gateResult.commandResults.filter(r => !r.passed).map(r => r.name);
      reasons.push(`Quality gates failed: ${failed.join(', ')}`);
    }

    return {
      passed: pathCheck.protectedPathsViolated.length === 0 && gateResult.passed,
      commandResults: gateResult.commandResults,
      protectedPathsViolated: pathCheck.protectedPathsViolated,
      warnings: sanity.warnings,
      reasons,
    };
  }
}
