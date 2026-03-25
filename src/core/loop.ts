import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { StateWriter } from './state-writer.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { Validator } from './validator.js';
import { SignalHandler } from './signal-handler.js';
import { readHint } from './hint.js';
import { log, setLogLevel } from './logger.js';
import { appendProgress, readProgress } from './progress-writer.js';
import { buildFreshPrompt, buildContinuePrompt } from '../context/strategies.js';
import { loadPrd, getFailingStories, allStoriesPass, updateStoryPasses, resetFailingStories } from '../prd/tracker.js';
import { estimateCost } from '../cost/pricing.js';
import type { IAgent } from '../types/agent.js';
import type { RalphConfig } from '../types/config.js';
import type { RunState, ExitReason } from '../types/state.js';

interface LoopResult {
  state: RunState;
  exitReason: ExitReason;
}

interface RalphLoopOptions {
  config: RalphConfig;
  agent: IAgent;
  projectDir: string;
  runId?: string;
}

const DEFAULT_PROTECTED_PATHS = [
  '.ralph/AGENT.md',
  '.ralph/prd.json',
  '.ralph/runs/**',
  '.env',
  '.env.*',
  '**/*.lock',
];

const VALIDATION_FAILURE_THRESHOLD = 5;

export class RalphLoop {
  private config: RalphConfig;
  private agent: IAgent;
  private projectDir: string;
  private runId: string;
  private stateWriter: StateWriter;
  private cb: CircuitBreaker;
  private validator: Validator;
  private signalHandler: SignalHandler;
  private stopRequested = false;
  private consecutiveValidationFailures = 0;
  private prdPath: string;

  constructor(options: RalphLoopOptions) {
    this.config = options.config;
    this.agent = options.agent;
    this.projectDir = options.projectDir;
    this.prdPath = join(options.projectDir, '.ralph', 'prd.json');

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

    const protectedPaths = options.config.protectedPaths ?? DEFAULT_PROTECTED_PATHS;
    const prd = loadPrd(this.prdPath);
    this.validator = new Validator({
      protectedPaths,
      qualityGates: prd.qualityGates,
      projectDir: options.projectDir,
    });

    this.signalHandler = new SignalHandler();
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
    this.signalHandler.register();

    await this.stateWriter.initialize();
    log.info(`Run ${this.runId} started (context: ${this.config.contextMode})`);

    let exitReason: ExitReason = 'converged';
    let iteration = 0;
    let round = 0;
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
          exitReason = 'max_iterations';
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
        const maxFailures = this.config.storyMaxConsecutiveFailures ?? 3;

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

          const result = await this.executeStory(story, ++iteration, round);
          if (result) roundFixCount++;
        }

        // End of round
        if (this.stopRequested) {
          exitReason = 'interrupted';
          await this.stateWriter.setStatus('interrupted');
          break;
        }
        if (exitReason === 'max_iterations' || exitReason === 'budget_exceeded' || exitReason === 'circuit_breaker_terminal' || exitReason === 'validation_failed_repeatedly') break;

        // Post-round exit check
        const postPrd = loadPrd(this.prdPath);

        if (isConvergent) {
          // Convergent mode: converged when no story changed state and all pass.
          // Compare pre-round and post-round pass states to detect actual changes.
          const stateChanged = postPrd.stories.some(s => {
            const prev = preRoundPassState!.get(s.id);
            return prev !== s.passes;
          });

          if (!stateChanged && allStoriesPass(postPrd)) {
            exitReason = 'converged';
            log.info(`Converged: round ${round} produced zero state changes, all gates pass`);
            break;
          }
          if (!stateChanged && !allStoriesPass(postPrd)) {
            exitReason = 'no_progress';
            log.warn(`Round ${round} produced zero state changes but some stories still fail`);
            break;
          }
          // State changed: agent made progress (or regressed), need another round to confirm
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
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`Loop crashed: ${errorMsg}`);
      try { await this.stateWriter.setStatus('crashed'); } catch { /* best effort */ }
      throw new Error(`Loop crashed: ${errorMsg}`);
    } finally {
      this.signalHandler.unregister();
    }

    this.stateWriter.setExitReason(exitReason);
    if (exitReason !== 'interrupted') {
      await this.stateWriter.setStatus('complete');
    }

    const finalState = this.stateWriter.getState();
    log.info(`Run complete: ${exitReason}, ${finalState.iteration} iterations, ${round} rounds, ~$${finalState.cost.estimatedCostUsd.toFixed(4)}`);

    return { state: finalState, exitReason };
  }

  /** Execute a single story: run agent, validate, update passes. Returns true if story passes. */
  private async executeStory(story: import('../types/prd.js').Story, iteration: number, round: number): Promise<boolean> {
    log.info(`Iteration ${iteration} (round ${round}): [${story.id}] ${story.title}`);
    this.stateWriter.setCurrentStory(story.id, story.title);

    const runDir = join(this.projectDir, '.ralph', 'runs', this.runId);
    const hint = readHint(runDir);
    if (hint) log.info(`Hint consumed for [${story.id}]`);

    const agentMd = this.loadAgentMd();
    const progressMd = readProgress(this.projectDir);
    const state = this.stateWriter.getState();
    const lastValidation = state.lastValidationResult;
    const validationSummary = lastValidation && !lastValidation.passed
      ? lastValidation.reasons.join('; ') : undefined;

    let prompt: string;
    if (this.config.contextMode === 'fresh') {
      prompt = buildFreshPrompt({
        story, agentMd: agentMd ?? undefined,
        validationSummary, progressMd: progressMd ?? undefined,
      });
    } else {
      prompt = buildContinuePrompt({ story, hint: hint ?? undefined });
    }

    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    let result;
    try {
      result = await this.agent.run({
        prompt,
        timeoutMs: this.config.timeoutMinutes * 60 * 1000,
        allowedTools: this.config.allowedTools,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`Agent error on [${story.id}]: ${errorMsg}`);
      this.stateWriter.setLastError(errorMsg);
      this.consecutiveValidationFailures++;
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

    const endedAt = new Date().toISOString();
    const durationMs = Date.now() - startMs;
    const iterationCost = result.usage
      ? estimateCost(result.usage, this.config.agentModel) : 0;

    log.debug(`Iteration ${iteration}: ${durationMs}ms, ~$${iterationCost.toFixed(4)}`);

    // Validate — the loop decides pass/fail, not the agent
    const changedFiles = this.getChangedFiles();
    const diffSize = this.getDiffSize();
    const validation = await this.validator.validate({ changedFiles, diffSize });
    await this.stateWriter.recordValidation(validation);

    const passed = validation.passed && result.exitCode === 0;
    this.stateWriter.setLastAgentOutputSummary(result.output.slice(0, 200));

    if (passed) {
      this.consecutiveValidationFailures = 0;
      this.stateWriter.setLastError(undefined);
    } else {
      this.consecutiveValidationFailures++;
      const errorDetail = validation.reasons.join('; ');
      this.stateWriter.setLastError(errorDetail);
    }

    await this.stateWriter.recordIteration({
      iteration, round, storyId: story.id, startedAt, endedAt, durationMs,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      cacheReadTokens: result.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: result.usage?.cacheWriteTokens ?? 0,
      estimatedCostUsd: iterationCost,
      validationPassed: passed,
      summary: result.output.slice(0, 200),
    });

    updateStoryPasses(this.prdPath, story.id, passed,
      passed ? undefined : validation.reasons.join('; '));

    if (!validation.passed) {
      log.warn(`Validation failed for [${story.id}]: ${validation.reasons.join('; ')}`);
    }

    this.cb.recordIteration({
      madeProgress: passed,
      error: !passed ? result.output.slice(0, 200) : undefined,
      costUsd: iterationCost,
      validationFailed: !validation.passed,
    });

    if (passed) log.info(`Story [${story.id}] passes`);

    appendProgress(this.projectDir, {
      iteration, round, storyId: story.id, storyTitle: story.title,
      passed, summary: result.output.slice(0, 200),
      gateResults: validation.commandResults.map(cr => ({ name: cr.name, passed: cr.passed })),
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
      const passingIds = prd.stories
        .filter(s => s.status === 'active' && s.passes)
        .map(s => s.id);
      if (passingIds.length > 0) {
        log.warn(`Quality gates failed at round start — re-evaluating ${passingIds.length} passing stories`);
        resetFailingStories(this.prdPath, passingIds);
      }
    }
  }

  private loadAgentMd(): string | null {
    const p = join(this.projectDir, '.ralph', 'AGENT.md');
    if (!existsSync(p)) return null;
    try { return readFileSync(p, 'utf-8'); } catch { return null; /* best-effort: missing AGENT.md is non-fatal */ }
  }

  private getChangedFiles(): string[] {
    try {
      return execSync('git diff --name-only HEAD', {
        cwd: this.projectDir, encoding: 'utf-8', timeout: 10000,
      }).trim().split('\n').filter(Boolean);
    } catch { return []; /* best-effort: git may not be available or no commits yet */ }
  }

  private getDiffSize(): number {
    try {
      return execSync('git diff --stat HEAD', {
        cwd: this.projectDir, encoding: 'utf-8', timeout: 10000,
      }).split('\n').length;
    } catch { return 0; /* best-effort: git may not be available or no commits yet */ }
  }
}
