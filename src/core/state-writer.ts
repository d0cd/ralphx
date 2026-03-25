import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunState, RunStatus, ValidationResult, IterationRecord, ExitReason } from '../types/state.js';
import { atomicWriteJson } from '../sync/atomic-write.js';

interface StateWriterOptions {
  runId: string;
  projectDir: string;
  agent: string;
  contextMode: 'continue' | 'fresh';
  model?: string;
  maxIterations?: number;
  sessionId?: string;
}

export class StateWriter {
  private state: RunState;
  private runDir: string;
  private statePath: string;
  private logPath: string;

  constructor(options: StateWriterOptions) {
    this.runDir = join(options.projectDir, '.ralph', 'runs', options.runId);
    this.statePath = join(this.runDir, 'run-state.json');
    this.logPath = join(this.runDir, 'loop.log');

    const now = new Date().toISOString();
    this.state = {
      runId: options.runId,
      projectDir: options.projectDir,
      startedAt: now,
      updatedAt: now,
      pid: process.pid,
      agent: options.agent,
      model: options.model,
      status: 'running',
      iteration: 0,
      round: 0,
      maxIterations: options.maxIterations,
      sessionId: options.sessionId,
      contextMode: options.contextMode,
      cost: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        estimatedCostUsd: 0,
      },
      perIteration: [],
    };
  }

  async initialize(): Promise<void> {
    try {
      mkdirSync(this.runDir, { recursive: true });
    } catch (e) {
      throw new Error(`Failed to create run directory ${this.runDir}: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.appendLog(`[${this.state.startedAt}] Run ${this.state.runId} initialized`);
    await this.flush();
  }

  async recordIteration(record: IterationRecord): Promise<void> {
    this.state.perIteration.push(record);
    this.state.iteration = record.iteration;
    this.state.round = record.round;
    this.state.cost.totalInputTokens += record.inputTokens;
    this.state.cost.totalOutputTokens += record.outputTokens;
    this.state.cost.totalCacheReadTokens += record.cacheReadTokens;
    this.state.cost.totalCacheWriteTokens += record.cacheWriteTokens;
    this.state.cost.estimatedCostUsd += record.estimatedCostUsd;
    this.state.updatedAt = new Date().toISOString();

    this.appendLog(
      `[${record.endedAt}] Iteration ${record.iteration}: ` +
      `${record.durationMs}ms, $${record.estimatedCostUsd.toFixed(4)}, ` +
      `validation=${record.validationPassed}` +
      (record.summary ? ` — ${record.summary}` : ''),
    );
    await this.flush();
  }

  async recordValidation(result: ValidationResult): Promise<void> {
    this.state.lastValidationResult = result;
    this.state.updatedAt = new Date().toISOString();
    await this.flush();
  }

  async setStatus(status: RunStatus): Promise<void> {
    this.state.status = status;
    this.state.updatedAt = new Date().toISOString();
    this.appendLog(`[${this.state.updatedAt}] Status changed to: ${status}`);
    await this.flush();
  }

  setCurrentStory(storyId: string | undefined, storyTitle: string | undefined): void {
    this.state.currentStoryId = storyId;
    this.state.currentStoryTitle = storyTitle;
  }

  setLastAgentOutputSummary(summary: string | undefined): void {
    this.state.lastAgentOutputSummary = summary;
  }

  setLastError(error: string | undefined): void {
    this.state.lastError = error;
  }

  setExitReason(reason: ExitReason): void {
    this.state.exitReason = reason;
  }

  getState(): RunState {
    return { ...this.state, perIteration: [...this.state.perIteration] };
  }

  async flush(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    atomicWriteJson(this.statePath, this.state);
  }

  private appendLog(line: string): void {
    try {
      appendFileSync(this.logPath, line + '\n');
    } catch {
      // Best-effort logging — don't crash the loop over a log write failure
    }
  }
}
