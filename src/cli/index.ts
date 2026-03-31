#!/usr/bin/env node

import { Command, InvalidArgumentError } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config/loader.js';
import { loadPrd } from '../prd/tracker.js';
import { parseRequirements } from '../prd/importer.js';
import { findResumableRun } from '../core/resume.js';
import { RalphLoop } from '../core/loop.js';
import { ClaudeCodeAgent } from '../agents/claude-code.js';
import { saveWorkflow, useWorkflow, listWorkflows } from '../workflow/manager.js';
import { resolveProjectDir, getWorkspaceDir, getRunsDir, findLatestRun, loadRunState, validatePathSegment } from './helpers.js';
import { readJsonFile, atomicWriteJson } from '../sync/atomic-write.js';
import type { RalphConfig } from '../types/config.js';
import type { ExitReason, RunState } from '../types/state.js';

/** Parse an integer CLI option, using InvalidArgumentError for clean Commander error output. */
function parseIntStrict(value: string): number {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) throw new InvalidArgumentError(`"${value}" is not a valid integer`);
  return n;
}

/** Parse a float CLI option, using InvalidArgumentError for clean Commander error output. */
function parseFloatStrict(value: string): number {
  const n = parseFloat(value);
  if (Number.isNaN(n)) throw new InvalidArgumentError(`"${value}" is not a valid number`);
  return n;
}

const EXIT_REASON_LABELS: Record<ExitReason, string> = {
  converged: 'All stories passed quality gates',
  no_progress: 'Agent made no progress — review stories and acceptance criteria',
  max_iterations: 'Hit iteration limit — increase with --max-iterations or .ralphxrc',
  max_rounds: 'Hit round limit — increase with maxRounds in .ralphxrc',
  budget_exceeded: 'Cost or token budget exceeded — increase with --max-cost or .ralphxrc',
  circuit_breaker_terminal: 'Repeated failures tripped the circuit breaker — check logs for root cause',
  interrupted: 'Stopped by signal (Ctrl-C or SIGTERM) — resume with --resume',
  validation_failed_repeatedly: 'Quality gates failed 5+ times in a row — check gate commands with dry-run',
};

function exitReasonLabel(reason: ExitReason): string {
  return EXIT_REASON_LABELS[reason] ?? reason;
}

/** Wrap a CLI action with consistent error handling: log the error and exit 1. */
function cliAction(label: string, fn: () => void | Promise<void>, hint?: string): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (e) {
      console.error(`${label}: ${(e instanceof Error ? e.message : String(e))}`);
      if (hint) console.error(hint);
      process.exit(1);
    }
  };
}

function requireWorkspace(projectDir: string, workspace: string): string {
  const wsDir = getWorkspaceDir(projectDir, workspace);
  if (!existsSync(join(wsDir, 'prd.json'))) {
    console.error(`Workspace "${workspace}" does not exist.`);
    console.error(`Run \`ralphx init ${workspace}\` first.`);
    process.exit(1);
  }
  return wsDir;
}

function requireRunId(projectDir: string, workspace: string, explicitRunId?: string): string {
  if (explicitRunId) {
    validatePathSegment(explicitRunId, 'Run ID');
  }
  const runId = explicitRunId ?? findLatestRun(projectDir, workspace);
  if (!runId) {
    console.error(`No runs found in workspace "${workspace}".`);
    console.error(`Start one with: ralphx run ${workspace}`);
    process.exit(1);
  }
  return runId;
}

function runNotFound(runId: string, workspace: string): never {
  console.error(`Run "${runId}" not found in workspace "${workspace}".`);
  console.error(`Use \`ralphx status ${workspace}\` to see available runs.`);
  process.exit(1);
}

const KV_PAD = 18;

function kv(key: string, value: string | number): string {
  return `${(key + ':').padEnd(KV_PAD)}${value}`;
}

const program = new Command();

program
  .name('ralphx')
  .description(`Safe, resumable autonomous coding loop for AI coding agents.

Every command takes a <workspace> name as its first argument.
Each workspace is an independent environment with its own PRD,
prompt, config, and run history, stored at .ralphx/<workspace>/.

Quick start:
  $ ralphx init audit
  $ ralphx import requirements.md audit
  $ ralphx run audit --max-iterations 20 --max-cost 5.00
  $ ralphx status audit

Workspaces:
  You can run multiple independent loops on the same repo:
  $ ralphx init dev
  $ ralphx init audit
  $ ralphx run dev &
  $ ralphx run audit

Workspace directory layout:
  .ralphx/<workspace>/
  ├── prd.json       Task definitions and acceptance criteria
  ├── PROMPT.md      Instructions for the coding loop
  ├── AGENT.md       Repo-specific agent guidance
  ├── .ralphxrc      Configuration (budget, timeouts, etc.)
  └── runs/          Run history (one subdirectory per run)

Currently supports Claude Code as the agent backend.`)
  .version('0.1.0');

// --- Commands ---

program
  .command('init')
  .description('Create a new workspace with template files.')
  .argument('<workspace>', 'Workspace name (e.g., "audit", "dev", "feature-auth")')
  .addHelpText('after', `
Examples:
  $ ralphx init audit           Create .ralphx/audit/ with template files
  $ ralphx init dev             Create .ralphx/dev/ with template files

Created files:
  .ralphx/<workspace>/
  ├── PROMPT.md      Placeholder loop prompt (edit to describe what the loop should do)
  ├── AGENT.md       Repo-specific agent guidance (test commands, conventions)
  ├── prd.json       Empty PRD with template structure (add stories here)
  ├── .ralphxrc      Default config: agent=claude-code, contextMode=continue,
  │                  timeoutMinutes=20, maxIterations=50
  └── runs/          Directory for run history (created automatically)

After init, edit these files to configure your loop:
  .ralphx/<workspace>/prd.json    Define stories with acceptance criteria
  .ralphx/<workspace>/PROMPT.md   Write the loop prompt
  .ralphx/<workspace>/AGENT.md    Add repo-specific commands and guidance
  .ralphx/<workspace>/.ralphxrc   Set budget, timeouts, and other config`)
  .action((workspace: string) => cliAction(
    'Failed to initialize workspace',
    () => {
      const projectDir = resolveProjectDir();
      const wsDir = getWorkspaceDir(projectDir, workspace);

      mkdirSync(join(wsDir, 'runs'), { recursive: true });

      const promptPath = join(wsDir, 'PROMPT.md');
      if (!existsSync(promptPath)) {
        writeFileSync(promptPath, '# Loop Prompt\n\nDescribe what the loop should do.\n');
      }

      const agentPath = join(wsDir, 'AGENT.md');
      if (!existsSync(agentPath)) {
        writeFileSync(agentPath, '# Agent Instructions\n\nRepo-specific commands and guidance.\n');
      }

      const prdPath = join(wsDir, 'prd.json');
      if (!existsSync(prdPath)) {
        writeFileSync(prdPath, JSON.stringify({
          version: '1.0',
          projectName: workspace,
          stories: [],
          qualityGates: {},
        }, null, 2));
      }

      const rcPath = join(wsDir, '.ralphxrc');
      if (!existsSync(rcPath)) {
        writeFileSync(rcPath, JSON.stringify({
          contextMode: 'continue',
          timeoutMinutes: 20,
          maxIterations: 50,
        }, null, 2));
      }

      console.log(`Initialized workspace "${workspace}" at ${'.ralphx'}/${workspace}/`);
    },
    'Check that you have write permissions to the current directory.',
  )());

program
  .command('run')
  .description('Start or resume an autonomous coding loop.')
  .argument('<workspace>', 'Workspace name')
  .option('--prompt <text>', 'Text to prepend to the loop prompt')
  .option('--context-mode <mode>', 'Context mode: "continue" (reuse session) or "fresh" (new session each iteration)')
  .option('--max-iterations <n>', 'Maximum number of iterations before stopping', parseIntStrict)
  .option('--max-cost <usd>', 'Maximum estimated cost in USD before stopping', parseFloatStrict)
  .option('--timeout <minutes>', 'Per-iteration timeout in minutes', parseIntStrict)
  .option('--verbose', 'Enable verbose logging (shows agent progress events)')
  .option('--resume <runId>', 'Resume a paused or interrupted run by its ID')
  .addHelpText('after', `
Examples:
  $ ralphx run audit                             Run with workspace defaults
  $ ralphx run dev --max-iterations 10           Limit to 10 iterations
  $ ralphx run audit --max-cost 5.00 --verbose   Cap at $5, show progress
  $ ralphx run dev --resume abc123               Resume a previous run
  $ ralphx run audit --prompt "Focus on auth"    Prepend text to the loop prompt
  $ ralphx run dev --context-mode fresh          New session each iteration

Config resolution (highest priority first):
  CLI flags > RALPH_* env vars > .ralphxrc file > defaults

Exit codes:
  0  All stories converged (passed quality gates)
  1  Stopped for any other reason (budget, circuit breaker, no progress)
  Check .ralphx/<workspace>/runs/<id>/run-state.json for detailed exit reason.`)
  .action(async (workspace: string, opts) => cliAction(
    'Run failed',
    async () => {
      const projectDir = resolveProjectDir();
      const wsDir = requireWorkspace(projectDir, workspace);

      const flags: Partial<RalphConfig> = {};
      if (opts.contextMode) flags.contextMode = opts.contextMode;
      if (opts.maxIterations !== undefined) flags.maxIterations = opts.maxIterations;
      if (opts.maxCost !== undefined) flags.maxCostUsd = opts.maxCost;
      if (opts.timeout !== undefined) flags.timeoutMinutes = opts.timeout;
      if (opts.verbose) flags.verbose = true;

      const config = loadConfig({ projectDir: wsDir, flags });
      const agent = new ClaudeCodeAgent(config.agentCmd, (event) => {
        if (config.verbose) {
          console.log(`  ${event}`);
        }
      });

      let previousState: RunState | undefined;
      if (opts.resume) {
        validatePathSegment(opts.resume, 'Run ID');
        previousState = findResumableRun(wsDir, opts.resume) ?? undefined;
        if (!previousState) {
          console.error(`Run "${opts.resume}" is not resumable (must be interrupted or paused, with valid state).`);
          process.exit(1);
        }
        console.log(`Resuming run "${opts.resume}" from iteration ${previousState.iteration}`);
      }

      const loop = new RalphLoop({
        config,
        agent,
        projectDir: wsDir,
        projectRoot: projectDir,
        runId: opts.resume,
        previousState,
      });

      const result = await loop.run();

      console.log('');
      console.log(kv('Exit reason', result.exitReason));
      console.log(kv('Iterations', result.state.iteration));
      console.log(kv('Cost', `~$${result.state.cost.estimatedCostUsd.toFixed(4)}`));
      console.log(`  → ${exitReasonLabel(result.exitReason)}`);
      if (result.exitReason !== 'converged') {
        console.log(`  → Use \`ralphx logs ${workspace}\` to investigate.`);
      }

      process.exit(result.exitReason === 'converged' ? 0 : 1);
    },
    `Check ${'.ralphx'}/${workspace}/${'prd.json'} and ${'.ralphx'}/${workspace}/${'.ralphxrc'} for configuration errors.\nUse \`ralphx dry-run ${workspace}\` to preview settings.`,
  )());

program
  .command('status')
  .description('Show the status of the latest or a specific run.')
  .argument('<workspace>', 'Workspace name')
  .option('--run <runId>', 'Show a specific run instead of the latest')
  .addHelpText('after', `
Examples:
  $ ralphx status audit                Show latest run in "audit" workspace
  $ ralphx status dev --run abc123     Show a specific run`)
  .action((workspace: string, opts) => cliAction(
    'Failed to read status',
    () => {
      const projectDir = resolveProjectDir();
      requireWorkspace(projectDir, workspace);
      const runId = requireRunId(projectDir, workspace, opts.run);

      const state = loadRunState(projectDir, workspace, runId);
      if (!state) runNotFound(runId, workspace);

      console.log(kv('Run', state.runId));
      console.log(kv('Status', state.status));
      console.log(kv('Iteration', state.iteration ?? 0));
      console.log(kv('Agent', state.agent ?? 'unknown'));
      console.log(kv('Cost', `~$${(state.cost?.estimatedCostUsd ?? 0).toFixed(4)}`));
      console.log(kv('Started', state.startedAt ?? 'N/A'));
      console.log(kv('Updated', state.updatedAt ?? 'N/A'));
      if (state.currentStoryTitle) {
        console.log(kv('Story', state.currentStoryTitle));
      }
      if (state.exitReason) {
        console.log(kv('Exit reason', state.exitReason));
        console.log(`  → ${exitReasonLabel(state.exitReason)}`);
      }
      const logPath = join(getRunsDir(projectDir, workspace), runId, 'loop.log');
      if (existsSync(logPath)) {
        console.log('');
        console.log(kv('Logs', `ralphx logs ${workspace}` + (opts.run ? ` --run ${opts.run}` : '')));
      }
    },
    `Check that workspace "${workspace}" has runs.\nList runs with: ralphx status ${workspace}`,
  )());

program
  .command('logs')
  .description('Show the loop log for the latest or a specific run.')
  .argument('<workspace>', 'Workspace name')
  .option('--run <runId>', 'Show a specific run instead of the latest')
  .option('-n, --lines <count>', 'Number of lines to show (from the end)', '50')
  .addHelpText('after', `
Examples:
  $ ralphx logs audit                  Last 50 lines of latest run
  $ ralphx logs dev -n 100            Last 100 lines
  $ ralphx logs audit --run abc123    Specific run`)
  .action((workspace: string, opts) => cliAction(
    'Failed to read logs',
    () => {
      const projectDir = resolveProjectDir();
      requireWorkspace(projectDir, workspace);
      const runId = requireRunId(projectDir, workspace, opts.run);

      const logPath = join(getRunsDir(projectDir, workspace), runId, 'loop.log');
      if (!existsSync(logPath)) {
        console.log(`No log file for run "${runId}". The run may not have produced output yet.`);
        return;
      }

      const content = readFileSync(logPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.length > 0);
      if (lines.length === 0) {
        console.log(`Log file for run "${runId}" is empty.`);
        return;
      }
      const count = parseIntStrict(opts.lines);
      if (count <= 0) {
        console.error(`Invalid line count: "${opts.lines}". Provide a positive integer (e.g., -n 50).`);
        process.exit(1);
      }
      const tail = lines.slice(-count).join('\n');
      process.stdout.write(tail + '\n');
    },
    `Check that workspace "${workspace}" has runs with log output.\nStart a run with: ralphx run ${workspace}`,
  )());

program
  .command('cost')
  .description('Show token usage and cost breakdown for a run.')
  .argument('<workspace>', 'Workspace name')
  .option('--run <runId>', 'Show a specific run instead of the latest')
  .addHelpText('after', `
Examples:
  $ ralphx cost audit                  Cost of latest run
  $ ralphx cost dev --run abc123      Cost of specific run

All costs are estimates based on public model pricing.`)
  .action((workspace: string, opts) => cliAction(
    'Failed to read cost data',
    () => {
      const projectDir = resolveProjectDir();
      requireWorkspace(projectDir, workspace);
      const runId = requireRunId(projectDir, workspace, opts.run);

      const state = loadRunState(projectDir, workspace, runId);
      if (!state) runNotFound(runId, workspace);

      console.log(kv('Run', state.runId));
      console.log(kv('Iterations', state.iteration ?? 0));
      if (!state.cost) {
        console.log(kv('Cost data', 'not yet available (run may still be starting)'));
        return;
      }
      console.log(kv('Input tokens', (state.cost.totalInputTokens ?? 0).toLocaleString()));
      console.log(kv('Output tokens', (state.cost.totalOutputTokens ?? 0).toLocaleString()));
      console.log(kv('Cache read', (state.cost.totalCacheReadTokens ?? 0).toLocaleString()));
      console.log(kv('Cache write', (state.cost.totalCacheWriteTokens ?? 0).toLocaleString()));
      console.log(kv('Estimated cost', `~$${(state.cost.estimatedCostUsd ?? 0).toFixed(4)}`));
    },
    `Check that workspace "${workspace}" has completed runs.\nStart a run with: ralphx run ${workspace}`,
  )());

program
  .command('hint')
  .description('Inject a message into a running loop. The agent will see it on its next iteration.')
  .argument('<workspace>', 'Workspace name')
  .argument('<message>', 'Hint message for the agent')
  .requiredOption('--run <runId>', 'Target run ID')
  .addHelpText('after', `
Examples:
  $ ralphx hint audit "Focus on the auth module" --run abc123
  $ ralphx hint dev "Skip story-3, it is blocked" --run abc123

The hint is written to .ralphx/<workspace>/runs/<runId>/hint.md
and consumed (deleted) by the loop on its next iteration.`)
  .action((workspace: string, message: string, opts: { run: string }) => cliAction(
    'Failed to write hint',
    () => {
      const projectDir = resolveProjectDir();
      requireWorkspace(projectDir, workspace);
      validatePathSegment(opts.run, 'Run ID');
      const runDir = join(getRunsDir(projectDir, workspace), opts.run);

      if (!existsSync(runDir)) runNotFound(opts.run, workspace);

      const hintPath = join(runDir, 'hint.md');
      writeFileSync(hintPath, message);
      console.log(`Hint written for run "${opts.run}".`);
    },
    `Ensure the run exists with: ralphx status ${workspace}`,
  )());

program
  .command('pause')
  .description('Request a running loop to pause after its current iteration.')
  .argument('<workspace>', 'Workspace name')
  .requiredOption('--run <runId>', 'Target run ID')
  .addHelpText('after', `
Examples:
  $ ralphx pause audit --run abc123

The run will finish its current iteration, save state, and stop.
Resume later with: ralphx run <workspace> --resume <runId>`)
  .action((workspace: string, opts: { run: string }) => cliAction(
    'Failed to pause run',
    () => {
      const projectDir = resolveProjectDir();
      requireWorkspace(projectDir, workspace);
      validatePathSegment(opts.run, 'Run ID');

      const state = loadRunState(projectDir, workspace, opts.run);
      if (!state) runNotFound(opts.run, workspace);

      if (state.status !== 'running') {
        console.log(`Run "${opts.run}" is not running (status: ${state.status}).`);
        return;
      }

      const statePath = join(getRunsDir(projectDir, workspace), opts.run, 'run-state.json');
      const current = readJsonFile<RunState>(statePath);
      atomicWriteJson(statePath, { ...current, status: 'paused', updatedAt: new Date().toISOString() });
      console.log(`Pause requested for run "${opts.run}". The loop will pause after the current iteration.`);
      console.log(`Resume with: ralphx run ${workspace} --resume ${opts.run}`);
    },
    `Ensure the run exists with: ralphx status ${workspace}`,
  )());

program
  .command('dry-run')
  .description('Show resolved config, PRD summary, and quality gates without running the loop.')
  .argument('<workspace>', 'Workspace name')
  .addHelpText('after', `
Examples:
  $ ralphx dry-run audit

Useful for verifying your workspace is configured correctly before starting a run.`)
  .action((workspace: string) => cliAction(
    'Dry run failed',
    () => {
      const projectDir = resolveProjectDir();
      const wsDir = requireWorkspace(projectDir, workspace);

      const config = loadConfig({ projectDir: wsDir });
      console.log('=== Resolved Config ===');
      console.log(kv('Workspace', workspace));
      console.log(kv('Agent', config.agentCmd ?? 'claude-code (default)'));
      if (config.agentModel) {
        console.log(kv('Model', config.agentModel));
      }
      console.log(kv('Loop mode', config.loopMode));
      console.log(kv('Context', config.contextMode));
      console.log(kv('Timeout', `${config.timeoutMinutes}m per iteration`));
      console.log(kv('Max iterations', config.maxIterations ?? 'unlimited'));
      console.log(kv('Max rounds', config.maxRounds ?? 'unlimited'));
      console.log(kv('Max cost', config.maxCostUsd ? '$' + config.maxCostUsd : 'unlimited'));
      if (config.warnCostUsd) {
        console.log(kv('Warn cost', '$' + config.warnCostUsd));
      }
      console.log(kv('No-progress CB', `${config.cbNoProgressThreshold} iterations`));
      console.log(kv('Same-error CB', `${config.cbSameErrorThreshold} iterations`));
      console.log(kv('Story failures', `${config.storyMaxConsecutiveFailures} max consecutive`));
      console.log('');

      const prd = loadPrd(join(wsDir, 'prd.json'));
      const active = prd.stories.filter(s => s.status === 'active');
      const passing = active.filter(s => s.passes);
      const failing = active.filter(s => !s.passes);
      console.log('=== PRD ===');
      console.log(kv('Project', prd.projectName));
      console.log(kv('Total stories', prd.stories.length));
      console.log(kv('Active', active.length));
      console.log(kv('Passing', passing.length));
      console.log(kv('Failing', failing.length));
      if (failing.length > 0) {
        console.log(kv('Next story', `[${failing[0].id}] ${failing[0].title}`));
      }
      console.log('');

      const gates = Object.entries(prd.qualityGates).filter(([_, v]) => v);
      console.log('=== Quality Gates ===');
      if (gates.length === 0) {
        console.log('None configured. Add typecheck/lint/test to prd.json qualityGates.');
      } else {
        for (const [name, cmd] of gates) {
          console.log(kv(name, String(cmd)));
        }
      }
      console.log('');

      console.log('Dry run complete. No agent was invoked.');
    },
    `Check ${'.ralphx'}/${workspace}/${'prd.json'} and ${'.ralphx'}/${workspace}/${'.ralphxrc'} for syntax errors.`,
  )());

program
  .command('import')
  .description('Parse a markdown file into prd.json stories for a workspace.')
  .argument('<file>', 'Path to markdown file with ## headings for each story')
  .argument('<workspace>', 'Target workspace name')
  .option('--project <name>', 'Project name in prd.json (defaults to workspace name)')
  .addHelpText('after', `
Examples:
  $ ralphx import requirements.md audit
  $ ralphx import stories.md dev --project my-app

Expected markdown format:
  ## Story Title
  Description paragraph.
  - Acceptance criterion 1
  - Acceptance criterion 2

  ## Another Story
  ...

Parsing rules:
  - Each ## heading becomes a story (auto-generated IDs: story-1, story-2, ...)
  - Bullet points (- or *) under a heading become acceptance criteria
  - Non-bullet text under a heading becomes the story description
  - # H1 headings are ignored (only ## H2 headings create stories)
  - Stories default to status "active" with priority matching their order`)
  .action((file: string, workspace: string, opts: { project?: string }) => {
    const projectDir = resolveProjectDir();
    const wsDir = getWorkspaceDir(projectDir, workspace);

    if (!existsSync(file)) {
      console.error(`File not found: ${file}`);
      console.error('Provide a path to a markdown file with ## headings for each story.');
      process.exit(1);
    }

    const wsExists = existsSync(join(wsDir, 'prd.json'));

    return cliAction(
      'Import failed',
      () => {
        const markdown = readFileSync(file, 'utf-8');
        const prd = parseRequirements(markdown, opts.project ?? workspace);

        if (prd.stories.length === 0) {
          console.error('No stories found. Ensure the file has ## headings (e.g., "## Story Title").');
          process.exit(1);
        }

        mkdirSync(wsDir, { recursive: true });
        const prdPath = join(wsDir, 'prd.json');
        writeFileSync(prdPath, JSON.stringify(prd, null, 2));

        console.log(`Imported ${prd.stories.length} ${prd.stories.length === 1 ? 'story' : 'stories'} into ${'.ralphx'}/${workspace}/${'prd.json'}`);
        if (!wsExists) {
          console.log(`Tip: Run \`ralphx init ${workspace}\` to create PROMPT.md, AGENT.md, and .ralphxrc.`);
        }
      },
      'Ensure the file is valid markdown with ## headings for each story.',
    )();
  });

// --- Workflow commands ---

const workflowCmd = program
  .command('workflow')
  .description('Save, apply, and list reusable workflow templates.')
  .addHelpText('after', `
Workflows save a workspace's config files (PROMPT.md, AGENT.md, .ralphxrc, prd.json)
as a reusable template stored in ~/.ralphx/workflows/.

Examples:
  $ ralphx workflow save my-audit audit     Save audit workspace as template
  $ ralphx workflow use my-audit dev        Apply template to dev workspace
  $ ralphx workflow list                    List saved templates`);

workflowCmd
  .command('save')
  .description('Save a workspace config as a named template.')
  .argument('<name>', 'Template name')
  .argument('<workspace>', 'Source workspace to save from')
  .addHelpText('after', `
Examples:
  $ ralphx workflow save my-audit audit     Save audit config as "my-audit" template
  $ ralphx workflow save standard dev       Save dev config as "standard" template

Saves PROMPT.md, AGENT.md, .ralphxrc, and prd.json to ~/.ralphx/workflows/<name>/.`)
  .action((name: string, workspace: string) => cliAction(
    'Failed to save workflow',
    () => {
      const projectDir = resolveProjectDir();
      const wsDir = requireWorkspace(projectDir, workspace);
      saveWorkflow(name, wsDir);
      console.log(`Workflow "${name}" saved from workspace "${workspace}".`);
    },
    `Ensure workspace "${workspace}" is initialized with: ralphx init ${workspace}`,
  )());

workflowCmd
  .command('use')
  .description('Apply a saved template to a workspace.')
  .argument('<name>', 'Template name')
  .argument('<workspace>', 'Target workspace to apply to')
  .addHelpText('after', `
Examples:
  $ ralphx workflow use my-audit staging    Apply "my-audit" template to staging workspace
  $ ralphx workflow use standard new-ws     Apply "standard" template to new-ws workspace

Creates the workspace directory if it doesn't exist. Overwrites existing config files.`)
  .action((name: string, workspace: string) => cliAction(
    'Failed to apply workflow',
    () => {
      const projectDir = resolveProjectDir();
      const wsDir = getWorkspaceDir(projectDir, workspace);
      mkdirSync(wsDir, { recursive: true });
      useWorkflow(name, wsDir);
      console.log(`Workflow "${name}" applied to workspace "${workspace}".`);
    },
    'List available workflows with: ralphx workflow list',
  )());

workflowCmd
  .command('list')
  .description('List all saved workflow templates.')
  .addHelpText('after', `
Examples:
  $ ralphx workflow list                    Show all saved templates

Templates are stored in ~/.ralphx/workflows/.`)
  .action(() => cliAction(
    'Failed to list workflows',
    () => {
      const workflows = listWorkflows();
      if (workflows.length === 0) {
        console.log('No saved workflows.');
        console.log('Save one with: ralphx workflow save <name> <workspace>');
        return;
      }
      console.log(kv('Workflows', `${workflows.length} saved`));
      console.log('');
      for (const w of workflows) {
        console.log(`  ${w.name.padEnd(20)}${w.files.join(', ').padEnd(40)}${w.createdAt.split('T')[0]}`);
      }
    },
    'Ensure ~/.ralphx/workflows/ is readable.',
  )());

program.parse();
