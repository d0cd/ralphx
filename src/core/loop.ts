import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { StateWriter } from './state-writer.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { Validator, sanitizeOutput } from './validator.js';
import { SignalHandler } from './signal-handler.js';
import { readHint } from './hint.js';
import { log, setLogLevel } from './logger.js';
import { appendProgress, readProgress } from './progress-writer.js';
import { buildFreshPrompt, buildContinuePrompt } from '../context/strategies.js';
import { loadPrd, getFailingStories, getPassingStoryIds, allStoriesPass, updateStoryPasses, resetFailingStories } from '../prd/tracker.js';
import { estimateCost } from '../cost/pricing.js';
import type { IAgent } from '../types/agent.js';
import type { RalphConfig } from '../types/config.js';
import type { RunState, ExitReason } from '../types/state.js';
import type { Story } from '../types/prd.js';

interface LoopResult {
  state: RunState;
  exitReason: ExitReason;
}

interface RalphLoopOptions {
  config: RalphConfig;
  agent: IAgent;
  /** Workspace directory (contains prd.json, AGENT.md, runs/, etc.) */
  projectDir: string;
  /** Git repo root where quality gates and git commands run. Defaults to projectDir. */
  projectRoot?: string;
  runId?: string;
  previousState?: RunState;
}

const DEFAULT_PROTECTED_PATHS = [
  '.ralphx/**',
  '.env',
  '.env.*',
];

const VALIDATION_FAILURE_THRESHOLD = 5;

/** Expected git errors that don't indicate a real problem (no repo, or empty repo). */
function isExpectedGitError(msg: string): boolean {
  return msg.includes('not a git repository') || msg.includes('does not have any commits');
}

export class RalphLoop {
  private config: RalphConfig;
  private agent: IAgent;
  private projectDir: string;
  private projectRoot: string;
  private runId: string;
  private stateWriter: StateWriter;
  private cb: CircuitBreaker;
  private validator: Validator;
  private signalHandler: SignalHandler;
  private stopRequested = false;
  private consecutiveValidationFailures = 0;
  private consecutiveCleanRounds = 0;
  private prdPath: string;
  private protectedPaths: string[];
  private previousState?: RunState;
  private cachedWorkspacePrefix?: string;
  private cachedAgentMd?: string | null;
  private lastSessionId?: string;

  constructor(options: RalphLoopOptions) {
    this.config = options.config;
    this.agent = options.agent;
    this.projectDir = options.projectDir;
    this.projectRoot = options.projectRoot ?? options.projectDir;
    this.prdPath = join(options.projectDir, 'prd.json');

    setLogLevel(options.config.verbose ? 'debug' : 'info');

    this.runId = options.runId ?? randomUUID();
    this.stateWriter = new StateWriter({
      runId: this.runId,
      projectDir: options.projectDir,
      agent: options.agent.name,
      contextMode: options.config.contextMode,
      maxIterations: options.config.maxIterations,
    });

    this.cb = new CircuitBreaker({
      noProgressThreshold: options.config.cbNoProgressThreshold,
      sameErrorThreshold: options.config.cbSameErrorThreshold,
      costPerIterationThreshold: options.config.costPerIterationThreshold,
      cooldownMinutes: options.config.cbCooldownMinutes,
    });

    this.protectedPaths = options.config.protectedPaths ?? DEFAULT_PROTECTED_PATHS;
    const prd = loadPrd(this.prdPath);
    this.validator = new Validator({
      protectedPaths: this.protectedPaths,
      qualityGates: prd.qualityGates,
      projectRoot: this.projectRoot,
    });

    this.signalHandler = new SignalHandler();
    this.previousState = options.previousState;
  }

  requestStop(): void {
    this.stopRequested = true;
  }

  async run(): Promise<LoopResult> {
    const installation = await this.agent.validateInstallation();
    if (!installation.ok) {
      throw new Error(`Agent installation check failed: ${installation.error}`);
    }

    this.signalHandler.onStop(() => {
      log.info('Stop requested — finishing current iteration');
      this.requestStop();
    });
    this.signalHandler.onForceExit(() => {
      log.warn('Force exit requested');
      process.exit(1);
    });
    this.signalHandler.onCrash(() => {
      try { this.stateWriter.setStatus('crashed'); } catch { /* best effort */ }
    });
    this.signalHandler.register();

    await this.stateWriter.initialize();

    // Record git HEAD at start for diff/undo capability
    const gitHead = this.getGitHead();
    if (gitHead) this.stateWriter.setGitHeadAtStart(gitHead);

    if (this.previousState) {
      await this.stateWriter.restoreFrom(this.previousState);
      if (this.previousState.sessionId) {
        this.lastSessionId = this.previousState.sessionId;
      }
      log.info(`Run ${this.runId} resumed from iteration ${this.previousState.iteration} (context: ${this.config.contextMode})`);
    } else {
      log.info(`Run ${this.runId} started (context: ${this.config.contextMode})`);
    }

    let exitReason: ExitReason = 'converged';
    let iteration = this.previousState ? this.previousState.iteration : 0;
    let round = this.previousState ? this.previousState.round : 0;
    try {
      // Outer loop: rounds.
      // Each round runs the agent on ALL active stories.
      // A story passes only if the agent makes NO changes and gates pass.
      // Convergence = a full round where every story passes (agent found nothing to fix).
      while (true) {
        round++;
        this.cb.tryHalfOpen();

        // Re-evaluate at round start: run gates, flip regressions
        if (round > 1) {
          await this.reEvaluatePassingStories();
        }

        const prd = loadPrd(this.prdPath);
        const state = this.stateWriter.getState();

        // Check hard limits before starting round
        if (this.stopRequested) {
          exitReason = 'interrupted';
          await this.stateWriter.setStatus('interrupted');
          break;
        }
        if (this.config.maxRounds && round > this.config.maxRounds) {
          exitReason = 'max_rounds';
          log.info(`Max rounds (${this.config.maxRounds}) reached`);
          break;
        }
        if (this.config.maxIterations && iteration >= this.config.maxIterations) {
          exitReason = 'max_iterations';
          break;
        }
        if (this.config.maxCostUsd && state.cost.estimatedCostUsd >= this.config.maxCostUsd) {
          exitReason = 'budget_exceeded';
          break;
        }
        if (this.cb.isTerminal()) {
          exitReason = 'circuit_breaker_terminal';
          break;
        }

        if (this.config.warnCostUsd && state.cost.estimatedCostUsd >= this.config.warnCostUsd) {
          log.warn(`Cost ~$${state.cost.estimatedCostUsd.toFixed(4)} has reached warn threshold`);
        }

        // Select stories for this round based on loop mode
        const isConvergent = this.config.loopMode === 'convergent';
        const maxFailures = this.config.storyMaxConsecutiveFailures;

        let stories: typeof prd.stories;
        if (isConvergent) {
          // Convergent: run ALL active stories every round
          // Convergence = a round where the agent changes nothing
          stories = prd.stories
            .filter(s => s.status === 'active')
            .filter(s => (s.consecutiveFailures ?? 0) < maxFailures)
            .sort((a, b) => a.priority - b.priority);
        } else {
          // Backlog: only run failing stories
          stories = getFailingStories(prd, maxFailures);
        }

        if (stories.length === 0) {
          if (isConvergent) {
            exitReason = 'no_progress';
            log.warn('No workable stories remain');
          } else {
            exitReason = 'converged';
            log.info('All stories pass');
          }
          break;
        }

        // Capture pre-round pass state for convergent mode change detection
        const preRoundPassState = isConvergent
          ? new Map(prd.stories.map(s => [s.id, s.passes]))
          : null;

        log.info(`Round ${round}: ${stories.length} stories (${isConvergent ? 'convergent' : 'backlog'} mode)`);
        let roundFixCount = 0;

        for (const story of stories) {
          if (this.stopRequested) break;

          // Check limits before each story
          if (this.config.maxIterations && iteration >= this.config.maxIterations) {
            exitReason = 'max_iterations';
            break;
          }
          const midState = this.stateWriter.getState();
          if (this.config.maxCostUsd && midState.cost.estimatedCostUsd >= this.config.maxCostUsd) {
            exitReason = 'budget_exceeded';
            break;
          }
          if (this.config.maxTokensSession) {
            const totalTokens = midState.cost.totalInputTokens + midState.cost.totalOutputTokens;
            if (totalTokens >= this.config.maxTokensSession) {
              exitReason = 'budget_exceeded';
              break;
            }
          }
          if (this.cb.isTerminal()) {
            exitReason = 'circuit_breaker_terminal';
            break;
          }
          if (this.consecutiveValidationFailures >= VALIDATION_FAILURE_THRESHOLD) {
            exitReason = 'validation_failed_repeatedly';
            log.warn(`Validation failed ${this.consecutiveValidationFailures} consecutive times — stopping`);
            break;
          }

          const result = await this.executeStory(story, ++iteration, round, stories.length);
          if (result) roundFixCount++;
        }

        // End of round
        if (this.stopRequested) {
          exitReason = 'interrupted';
          await this.stateWriter.setStatus('interrupted');
          break;
        }
        if (exitReason === 'max_iterations' || exitReason === 'budget_exceeded' || exitReason === 'circuit_breaker_terminal' || exitReason === 'validation_failed_repeatedly') break;

        // Run quality gates once at end of round (not per-story)
        const gateResult = await this.validator.runQualityGates();
        await this.stateWriter.recordValidation({
          passed: gateResult.passed,
          commandResults: gateResult.commandResults,
          protectedPathsViolated: [],
          warnings: [],
          reasons: gateResult.passed ? [] : [`Quality gates failed: ${gateResult.commandResults.filter(r => !r.passed).map(r => r.name).join(', ')}`],
        });

        // Progress: round-end gate result
        if (gateResult.passed) {
          const postState = this.stateWriter.getState();
          console.log(`  Round ${round}: gates passed (~$${postState.cost.estimatedCostUsd.toFixed(2)})`);
        } else {
          const failedNames = gateResult.commandResults.filter(r => !r.passed).map(r => r.name).join(', ');
          console.log(`  Round ${round}: gates FAILED (${failedNames})`);
        }

        if (!gateResult.passed) {
          const failedGates = gateResult.commandResults.filter(r => !r.passed);
          const gateOutput = failedGates.map(r => `${r.name}: ${r.outputSummary ?? 'no output'}`).join('\n');
          log.warn(`Quality gates failed at end of round ${round}:\n${gateOutput}`);
          // Mark all passing stories as failing in a single batch write (gates are global)
          const prdAfterGate = loadPrd(this.prdPath);
          const passingIds = getPassingStoryIds(prdAfterGate);
          const gateReason = `Quality gates failed: ${failedGates.map(r => r.name).join(', ')}`;
          resetFailingStories(this.prdPath, passingIds, gateReason);
          this.consecutiveValidationFailures++;
          this.cb.recordIteration({ madeProgress: false, error: `Gates failed: ${failedGates.map(r => r.name).join(', ')}` });

          if (this.consecutiveValidationFailures >= VALIDATION_FAILURE_THRESHOLD) {
            exitReason = 'validation_failed_repeatedly';
            log.warn(`Quality gates failed ${this.consecutiveValidationFailures} consecutive rounds — stopping`);
            break;
          }
          // Gates failed — run another round so the agent can fix the issue
          this.consecutiveCleanRounds = 0;
          continue;
        }

        // Gates passed — reset validation failure counter
        this.consecutiveValidationFailures = 0;

        // Post-round exit check
        const postPrd = loadPrd(this.prdPath);

        if (isConvergent) {
          // Convergent mode: converged when no story changed state and all pass.
          // Compare pre-round and post-round pass states to detect actual changes.
          const stateChanged = postPrd.stories.some(s => {
            const prev = preRoundPassState!.get(s.id);
            return prev !== s.passes;
          });

          const allPass = allStoriesPass(postPrd);
          if (!stateChanged && allPass) {
            this.consecutiveCleanRounds++;
            const threshold = this.config.convergenceThreshold ?? 1;
            if (this.consecutiveCleanRounds >= threshold) {
              exitReason = 'converged';
              log.info(`Converged: ${this.consecutiveCleanRounds} consecutive clean round(s), all gates pass`);
              break;
            }
            log.info(`Clean round ${this.consecutiveCleanRounds}/${threshold} — running another to confirm convergence`);
            continue;
          }
          if (!stateChanged && !allPass) {
            exitReason = 'no_progress';
            log.warn(`Round ${round} produced zero state changes but some stories still fail`);
            break;
          }
          // State changed: agent made progress (or regressed), reset clean round counter
          this.consecutiveCleanRounds = 0;
          log.info(`Round ${round}: ${roundFixCount} stories passed — running another round to confirm`);
        } else {
          // Backlog mode: done when all stories pass
          if (allStoriesPass(postPrd)) {
            exitReason = 'converged';
            log.info('All stories pass');
            break;
          }
          // Some stories still failing — continue to next round
          if (roundFixCount === 0) {
            exitReason = 'no_progress';
            log.warn('Round completed with zero fixes');
            break;
          }
        }
      }
    } catch (err) {
      const errorMsg = (err instanceof Error ? err.message : String(err));
      log.error(`Loop crashed: ${errorMsg}`);
      try { await this.stateWriter.setStatus('crashed'); } catch { /* best effort */ }
      throw new Error(`Loop crashed: ${errorMsg}`);
    } finally {
      this.signalHandler.unregister();
    }

    this.stateWriter.setExitReason(exitReason);
    if (exitReason === 'interrupted') {
      // Status was already set to 'interrupted' inside the loop,
      // but exitReason was set after that flush — persist it now.
      await this.stateWriter.flush();
    } else {
      await this.stateWriter.setStatus('complete');
    }

    // Report any protected path violations at exit
    const violations = this.validator.checkProtectedPaths(this.getChangedFiles());
    if (violations.protectedPathsViolated.length > 0) {
      log.warn(`Protected paths were modified during this run: ${violations.protectedPathsViolated.join(', ')}`);
      log.warn('Review these changes before committing.');
    }

    const finalState = this.stateWriter.getState();
    log.info(`Run complete: ${exitReason}, ${finalState.iteration} iterations, ${round} rounds, ~$${finalState.cost.estimatedCostUsd.toFixed(4)}`);

    return { state: finalState, exitReason };
  }

  /** Execute a single story: run agent, validate, update passes. Returns true if story passes. */
  private async executeStory(story: Story, iteration: number, round: number, totalStories: number): Promise<boolean> {
    log.info(`Iteration ${iteration} (round ${round}): [${story.id}] ${story.title}`);
    this.stateWriter.setCurrentStory(story.id, story.title);

    const runDir = join(this.projectDir, 'runs', this.runId);
    const hint = readHint(runDir);
    if (hint) log.info(`Hint consumed for [${story.id}]`);

    const agentMd = this.loadAgentMd();
    const progressMd = readProgress(this.projectDir);
    const state = this.stateWriter.getState();
    const lastValidation = state.lastValidationResult;
    let validationSummary: string | undefined;
    if (lastValidation && !lastValidation.passed) {
      const parts = [...lastValidation.reasons];
      // Include full gate output so the agent can see what failed
      for (const cr of lastValidation.commandResults) {
        if (!cr.passed && cr.outputSummary) {
          parts.push(`\n--- ${cr.name} output ---\n${cr.outputSummary}`);
        }
      }
      validationSummary = parts.join('\n');
    }

    let prompt: string;
    if (this.config.contextMode === 'fresh') {
      prompt = buildFreshPrompt({
        story, agentMd: agentMd ?? undefined,
        validationSummary, progressMd: progressMd ?? undefined,
        protectedPaths: this.protectedPaths,
      });
    } else {
      prompt = buildContinuePrompt({ story, hint: hint ?? undefined, protectedPaths: this.protectedPaths });
    }

    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    let result;
    try {
      result = await this.agent.run({
        prompt,
        timeoutMs: this.config.timeoutMinutes * 60 * 1000,
        allowedTools: this.config.allowedTools,
        sessionId: this.config.contextMode === 'continue' ? this.lastSessionId : undefined,
      });
    } catch (err) {
      const errorMsg = (err instanceof Error ? err.message : String(err));
      log.error(`Agent error on [${story.id}]: ${errorMsg}`);
      this.stateWriter.setLastError(errorMsg);
      await this.stateWriter.recordIteration({
        iteration, round, storyId: story.id, startedAt,
        endedAt: new Date().toISOString(), durationMs: Date.now() - startMs,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        estimatedCostUsd: 0, validationPassed: false,
        summary: `Agent error: ${errorMsg}`,
      });
      this.cb.recordIteration({ madeProgress: false, error: errorMsg });
      updateStoryPasses(this.prdPath, story.id, false, errorMsg);
      this.stateWriter.setCurrentStory(undefined, undefined);
      return false;
    }

    // Track session ID for continue-mode session continuity.
    // Persist in state so it survives pause/resume cycles.
    if (result.sessionId) {
      this.lastSessionId = result.sessionId;
      this.stateWriter.setSessionId(result.sessionId);
    }

    const endedAt = new Date().toISOString();
    const durationMs = Date.now() - startMs;
    const iterationCost = result.usage
      ? estimateCost(result.usage, this.config.agentModel) : 0;

    log.debug(`Iteration ${iteration}: ${durationMs}ms, ~$${iterationCost.toFixed(4)}`);

    // Per-story validation: check protected paths and diff sanity (cheap checks).
    // Quality gates run once at end of round, not per-story.
    const changedFiles = this.getChangedFiles();
    const diffSize = this.getDiffSize();
    const pathCheck = this.validator.checkProtectedPaths(changedFiles);
    const sanity = this.validator.checkDiffSanity(changedFiles, diffSize);

    if (pathCheck.protectedPathsViolated.length > 0) {
      sanity.warnings.push(`Protected paths modified: ${pathCheck.protectedPathsViolated.join(', ')}`);
    }
    if (pathCheck.outsideProject.length > 0) {
      sanity.warnings.push(`Files outside project: ${pathCheck.outsideProject.join(', ')}`);
    }

    // Story passes based on agent exit code only (gates checked at round end)
    const passed = result.exitCode === 0;
    const outputSummary = sanitizeOutput(result.output);
    this.stateWriter.setLastAgentOutputSummary(outputSummary);

    if (passed) {
      this.stateWriter.setLastError(undefined);
    } else {
      this.stateWriter.setLastError(outputSummary);
    }

    await this.stateWriter.recordIteration({
      iteration, round, storyId: story.id, startedAt, endedAt, durationMs,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      cacheReadTokens: result.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: result.usage?.cacheWriteTokens ?? 0,
      estimatedCostUsd: iterationCost,
      validationPassed: passed,
      summary: outputSummary,
    });

    updateStoryPasses(this.prdPath, story.id, passed,
      passed ? undefined : outputSummary);

    if (!passed) {
      log.warn(`Story [${story.id}] failed (agent exit code ${result.exitCode})`);
    }

    if (sanity.warnings.length > 0) {
      log.warn(`Warnings for [${story.id}]: ${sanity.warnings.join('; ')}`);
    }

    this.cb.recordIteration({
      madeProgress: passed,
      error: !passed ? outputSummary : undefined,
      costUsd: iterationCost,
    });

    // Default progress output (always shown, not just --verbose)
    const icon = passed ? '✓' : '✗';
    const costSoFar = this.stateWriter.getState().cost.estimatedCostUsd;
    console.log(`  [${iteration}] ${icon} ${story.id} (~$${costSoFar.toFixed(2)})`);

    if (passed) log.info(`Story [${story.id}] passes`);

    appendProgress(this.projectDir, {
      iteration, round, storyId: story.id, storyTitle: story.title,
      passed, summary: outputSummary,
      gateResults: [],  // Gates run at end of round, not per-story
      timestamp: endedAt,
    });

    this.stateWriter.setCurrentStory(undefined, undefined);
    return passed;
  }

  /** Re-run quality gates; flip passing stories back to false if gates now fail */
  private async reEvaluatePassingStories(): Promise<void> {
    const validation = await this.validator.validate({
      changedFiles: this.getChangedFiles(),
      diffSize: this.getDiffSize(),
    });

    if (!validation.passed) {
      const prd = loadPrd(this.prdPath);
      const passingIds = getPassingStoryIds(prd);
      if (passingIds.length > 0) {
        log.warn(`Quality gates failed at round start — re-evaluating ${passingIds.length} passing stories`);
        resetFailingStories(this.prdPath, passingIds);
      }
    }
  }

  private loadAgentMd(): string | null {
    if (this.cachedAgentMd !== undefined) return this.cachedAgentMd;
    const p = join(this.projectDir, 'AGENT.md');
    try {
      this.cachedAgentMd = readFileSync(p, 'utf-8');
    } catch {
      this.cachedAgentMd = null; // best-effort: missing AGENT.md is non-fatal
    }
    return this.cachedAgentMd;
  }

  private getChangedFiles(): string[] {
    try {
      const wsPrefix = this.getWorkspacePrefix();
      return execSync('git diff --name-only HEAD', {
        cwd: this.projectRoot, encoding: 'utf-8', timeout: 10000,
      }).trim().split('\n').filter(Boolean)
        .filter(f => !f.startsWith(wsPrefix)); // Exclude workspace-managed files
    } catch (err) {
      // Distinguish expected errors (no git, no commits) from transient failures
      // that silently disable file safety checks.
      const msg = (err instanceof Error ? err.message : String(err));
      if (!isExpectedGitError(msg)) {
        log.warn(`git diff failed — file safety checks skipped this iteration: ${msg}`);
      }
      return [];
    }
  }

  /**
   * Compute the workspace directory's path relative to the git root (cached).
   * Used to filter workspace-managed files (e.g., .ralphx/audit/prd.json)
   * from the changed files list so they don't trigger diff sanity warnings
   * or inflate the changed file count.
   */
  private getWorkspacePrefix(): string {
    if (this.cachedWorkspacePrefix !== undefined) return this.cachedWorkspacePrefix;
    try {
      // Compute the workspace dir path relative to the git root.
      // projectDir is the workspace dir (e.g., /repo/.ralphx/audit/)
      // projectRoot is the git repo root (e.g., /repo/)
      const gitRoot = execSync('git rev-parse --show-toplevel', {
        cwd: this.projectRoot, encoding: 'utf-8', timeout: 5000,
      }).trim();
      const relative = this.projectDir.startsWith(gitRoot + '/')
        ? this.projectDir.slice(gitRoot.length + 1)
        : '.ralphx/';
      // Ensure trailing slash so startsWith matches only children
      this.cachedWorkspacePrefix = relative.endsWith('/') ? relative : relative + '/';
    } catch {
      // Fallback: filter by the workspace directory name (covers most cases)
      this.cachedWorkspacePrefix = '.ralphx/';
    }
    return this.cachedWorkspacePrefix;
  }

  private getGitHead(): string | null {
    try {
      return execSync('git rev-parse HEAD', {
        cwd: this.projectRoot, encoding: 'utf-8', timeout: 5000,
      }).trim();
    } catch { return null; }
  }

  private getDiffSize(): number {
    try {
      return execSync('git diff --stat HEAD', {
        cwd: this.projectRoot, encoding: 'utf-8', timeout: 10000,
      }).split('\n').length;
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err));
      if (!isExpectedGitError(msg)) {
        log.warn(`git diff --stat failed — diff sanity check skipped: ${msg}`);
      }
      return 0;
    }
  }
}
