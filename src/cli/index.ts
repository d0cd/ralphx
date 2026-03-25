#!/usr/bin/env node

import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config/loader.js';
import { loadPrd } from '../prd/tracker.js';
import { parseRequirements } from '../prd/importer.js';
import { findResumableRun } from '../core/resume.js';
import { RalphLoop } from '../core/loop.js';
import { ClaudeCodeAgent } from '../agents/claude-code.js';
import { saveWorkflow, useWorkflow, listWorkflows } from '../workflow/manager.js';
import type { RalphConfig } from '../types/config.js';

const program = new Command();

program
  .name('ralph')
  .description('Safe, resumable autonomous coding loop for AI coding agents')
  .version('0.1.0');

function resolveProjectDir(): string {
  return process.cwd();
}

function getRalphDir(projectDir: string): string {
  return join(projectDir, '.ralph');
}

function getRunsDir(projectDir: string): string {
  return join(getRalphDir(projectDir), 'runs');
}

function findLatestRun(projectDir: string): string | null {
  const runsDir = getRunsDir(projectDir);
  if (!existsSync(runsDir)) return null;

  let dirEntries: import('node:fs').Dirent[];
  try {
    dirEntries = readdirSync(runsDir, { withFileTypes: true });
  } catch (err) {
    console.error(`Failed to read runs directory ${runsDir}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const entries = dirEntries
    .filter(e => e.isDirectory())
    .map(e => {
      const statePath = join(runsDir, e.name, 'run-state.json');
      if (!existsSync(statePath)) return null;
      try {
        const state = JSON.parse(readFileSync(statePath, 'utf-8'));
        return { name: e.name, updatedAt: state.updatedAt ?? '' };
      } catch (err) {
        console.error(`Warning: could not read ${statePath}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    })
    .filter((e): e is { name: string; updatedAt: string } => e !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return entries[0]?.name ?? null;
}

function loadRunState(projectDir: string, runId: string): Record<string, unknown> | null {
  const statePath = join(getRunsDir(projectDir), runId, 'run-state.json');
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch (err) {
    console.error(`Warning: could not read run state for "${runId}": ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// --- Commands ---

program
  .command('init')
  .description('Initialize .ralph directory with template files')
  .action(() => {
    const projectDir = resolveProjectDir();
    const ralphDir = getRalphDir(projectDir);

    try {
      mkdirSync(join(ralphDir, 'runs'), { recursive: true });

      const promptPath = join(ralphDir, 'PROMPT.md');
      if (!existsSync(promptPath)) {
        writeFileSync(promptPath, '# Loop Prompt\n\nDescribe what the loop should do.\n');
      }

      const agentPath = join(ralphDir, 'AGENT.md');
      if (!existsSync(agentPath)) {
        writeFileSync(agentPath, '# Agent Instructions\n\nRepo-specific commands and guidance.\n');
      }

      const prdPath = join(ralphDir, 'prd.json');
      if (!existsSync(prdPath)) {
        writeFileSync(prdPath, JSON.stringify({
          version: '1.0',
          projectName: 'my-project',
          stories: [],
          qualityGates: {},
        }, null, 2));
      }

      const claimsPath = join(ralphDir, 'claims.json');
      if (!existsSync(claimsPath)) {
        writeFileSync(claimsPath, JSON.stringify({ claims: [] }, null, 2));
      }

      const rcPath = join(ralphDir, '.ralphrc');
      if (!existsSync(rcPath)) {
        writeFileSync(rcPath, JSON.stringify({
          agent: 'claude-code',
          contextMode: 'continue',
          timeoutMinutes: 20,
          maxIterations: 50,
        }, null, 2));
      }

      console.log(`Initialized .ralph/ in ${projectDir}`);
    } catch (e) {
      console.error(`Failed to initialize .ralph/: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

program
  .command('run')
  .description('Start an autonomous coding loop')
  .option('--prompt <text>', 'Prompt text to prepend to the loop prompt')
  .option('--context-mode <mode>', 'Context mode: continue or fresh')
  .option('--max-iterations <n>', 'Maximum iterations', parseInt)
  .option('--max-cost <usd>', 'Maximum cost in USD', parseFloat)
  .option('--timeout <minutes>', 'Per-iteration timeout in minutes', parseInt)
  .option('--verbose', 'Enable verbose logging')
  .option('--resume <runId>', 'Resume a previous run')
  .action(async (opts) => {
    const projectDir = resolveProjectDir();

    if (!existsSync(join(getRalphDir(projectDir), 'prd.json'))) {
      console.error('No .ralph/prd.json found. Run `ralph init` first.');
      process.exit(1);
    }

    try {
      const flags: Partial<RalphConfig> = {};
      if (opts.contextMode) flags.contextMode = opts.contextMode;
      if (opts.maxIterations) flags.maxIterations = opts.maxIterations;
      if (opts.maxCost) flags.maxCostUsd = opts.maxCost;
      if (opts.timeout) flags.timeoutMinutes = opts.timeout;
      if (opts.verbose) flags.verbose = true;

      const config = loadConfig({ projectDir, flags });
      const agent = new ClaudeCodeAgent(config.agentCmd, (event) => {
        if (config.verbose) {
          console.log(`  ${event}`);
        }
      });

      const loop = new RalphLoop({
        config,
        agent,
        projectDir,
        runId: opts.resume,
      });

      const result = await loop.run();

      console.log('');
      console.log(`Exit reason:  ${result.exitReason}`);
      console.log(`Iterations:   ${result.state.iteration}`);
      console.log(`Cost:         ~$${result.state.cost.estimatedCostUsd.toFixed(4)}`);

      process.exit(result.exitReason === 'converged' ? 0 : 1);
    } catch (e) {
      console.error(`Run failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show status of runs')
  .option('--run <runId>', 'Show specific run')
  .action((opts) => {
    const projectDir = resolveProjectDir();
    const runId = opts.run ?? findLatestRun(projectDir);

    if (!runId) {
      console.log('No runs found.');
      return;
    }

    const state = loadRunState(projectDir, runId);
    if (!state) {
      console.error(`Run "${runId}" not found.`);
      process.exit(1);
    }

    const cost = state.cost as Record<string, unknown> | undefined;
    console.log(`Run:        ${state.runId}`);
    console.log(`Status:     ${state.status}`);
    console.log(`Iteration:  ${state.iteration}`);
    console.log(`Agent:      ${state.agent}`);
    console.log(`Cost:       ~$${(cost?.estimatedCostUsd as number ?? 0).toFixed(4)}`);
    console.log(`Started:    ${state.startedAt}`);
    console.log(`Updated:    ${state.updatedAt}`);
  });

program
  .command('logs')
  .description('Show loop log for a run')
  .option('--run <runId>', 'Show specific run')
  .option('-n, --lines <count>', 'Number of lines to show', '50')
  .action((opts) => {
    const projectDir = resolveProjectDir();
    const runId = opts.run ?? findLatestRun(projectDir);

    if (!runId) {
      console.error('No runs found.');
      process.exit(1);
    }

    const logPath = join(getRunsDir(projectDir), runId, 'loop.log');
    if (!existsSync(logPath)) {
      console.error(`No log file for run "${runId}".`);
      process.exit(1);
    }

    let content: string;
    try {
      content = readFileSync(logPath, 'utf-8');
    } catch (err) {
      console.error(`Failed to read log file ${logPath}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    const lines = content.split('\n').filter(l => l.length > 0);
    const count = parseInt(opts.lines, 10);
    const tail = lines.slice(-count).join('\n');
    process.stdout.write(tail);
  });

program
  .command('cost')
  .description('Show cost summary for a run')
  .option('--run <runId>', 'Show specific run')
  .action((opts) => {
    const projectDir = resolveProjectDir();
    const runId = opts.run ?? findLatestRun(projectDir);

    if (!runId) {
      console.log('No runs found.');
      return;
    }

    const state = loadRunState(projectDir, runId);
    if (!state) {
      console.error(`Run "${runId}" not found.`);
      process.exit(1);
    }

    const cost = state.cost as Record<string, number> | undefined;
    if (!cost) {
      console.error('No cost data available.');
      process.exit(1);
    }

    console.log(`Run:              ${state.runId}`);
    console.log(`Iterations:       ${state.iteration}`);
    console.log(`Input tokens:     ${cost.totalInputTokens?.toLocaleString() ?? 0}`);
    console.log(`Output tokens:    ${cost.totalOutputTokens?.toLocaleString() ?? 0}`);
    console.log(`Cache read:       ${cost.totalCacheReadTokens?.toLocaleString() ?? 0}`);
    console.log(`Cache write:      ${cost.totalCacheWriteTokens?.toLocaleString() ?? 0}`);
    console.log(`Estimated cost:   ~$${(cost.estimatedCostUsd ?? 0).toFixed(4)}`);
  });

program
  .command('hint')
  .description('Send a hint to a running loop')
  .requiredOption('--run <runId>', 'Target run ID')
  .argument('<message>', 'Hint message')
  .action((message: string, opts: { run: string }) => {
    const projectDir = resolveProjectDir();
    const runDir = join(getRunsDir(projectDir), opts.run);

    if (!existsSync(runDir)) {
      console.error(`Run "${opts.run}" not found.`);
      process.exit(1);
    }

    const hintPath = join(runDir, 'hint.md');
    try {
      writeFileSync(hintPath, message);
      console.log(`Hint written for run "${opts.run}".`);
    } catch (e) {
      console.error(`Failed to write hint: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

program
  .command('pause')
  .description('Request a running loop to pause')
  .requiredOption('--run <runId>', 'Target run ID')
  .action((opts: { run: string }) => {
    const projectDir = resolveProjectDir();
    const statePath = join(getRunsDir(projectDir), opts.run, 'run-state.json');

    if (!existsSync(statePath)) {
      console.error(`Run "${opts.run}" not found.`);
      process.exit(1);
    }

    try {
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      if (state.status !== 'running') {
        console.log(`Run "${opts.run}" is not running (status: ${state.status}).`);
        return;
      }
      state.status = 'paused';
      state.updatedAt = new Date().toISOString();
      writeFileSync(statePath, JSON.stringify(state, null, 2));
      console.log(`Run "${opts.run}" marked as paused.`);
    } catch (e) {
      console.error(`Failed to pause run: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

program
  .command('resume')
  .description('Resume an interrupted or paused run')
  .argument('<runId>', 'Run ID to resume')
  .action((runId: string) => {
    const projectDir = resolveProjectDir();
    const state = findResumableRun(projectDir, runId);

    if (!state) {
      console.error(`Run "${runId}" is not resumable (must be interrupted or paused).`);
      process.exit(1);
    }

    console.log(`Run "${runId}" is resumable.`);
    console.log(`Status:     ${state.status}`);
    console.log(`Iteration:  ${state.iteration}`);
    console.log(`Cost:       ~$${state.cost.estimatedCostUsd.toFixed(4)}`);
    console.log('');
    console.log('To resume, use: ralph run --resume ' + runId);
  });

program
  .command('dry-run')
  .description('Show what would happen without executing')
  .action(() => {
    const projectDir = resolveProjectDir();
    const ralphDir = getRalphDir(projectDir);

    if (!existsSync(join(ralphDir, 'prd.json'))) {
      console.error('No .ralph/prd.json found. Run `ralph init` first.');
      process.exit(1);
    }

    try {
      // Config
      const config = loadConfig({ projectDir });
      console.log('=== Resolved Config ===');
      console.log(`Context:        ${config.contextMode}`);
      console.log(`Timeout:        ${config.timeoutMinutes}m`);
      console.log(`Max iterations: ${config.maxIterations ?? 'unlimited'}`);
      console.log(`Max cost:       ${config.maxCostUsd ? '$' + config.maxCostUsd : 'unlimited'}`);
      console.log('');

      // PRD
      const prd = loadPrd(join(ralphDir, 'prd.json'));
      const active = prd.stories.filter(s => s.status === 'active');
      const passing = active.filter(s => s.passes);
      const failing = active.filter(s => !s.passes);
      console.log('=== PRD ===');
      console.log(`Project:        ${prd.projectName}`);
      console.log(`Total stories:  ${prd.stories.length}`);
      console.log(`Active:         ${active.length}`);
      console.log(`Passing:        ${passing.length}`);
      console.log(`Failing:        ${failing.length}`);
      if (failing.length > 0) {
        console.log(`Next story:     [${failing[0].id}] ${failing[0].title}`);
      }
      console.log('');

      // Quality gates
      const gates = Object.entries(prd.qualityGates).filter(([_, v]) => v);
      console.log('=== Quality Gates ===');
      if (gates.length === 0) {
        console.log('None configured.');
      } else {
        for (const [name, cmd] of gates) {
          console.log(`${name}: ${cmd}`);
        }
      }
      console.log('');

      console.log('Dry run complete. No agent was invoked.');
    } catch (e) {
      console.error(`Dry run failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

program
  .command('import')
  .description('Import requirements from a markdown file into prd.json')
  .argument('<file>', 'Path to markdown requirements file')
  .option('--project <name>', 'Project name', 'my-project')
  .action((file: string, opts: { project: string }) => {
    const projectDir = resolveProjectDir();
    const ralphDir = getRalphDir(projectDir);

    if (!existsSync(file)) {
      console.error(`File not found: ${file}`);
      process.exit(1);
    }

    try {
      const markdown = readFileSync(file, 'utf-8');
      const prd = parseRequirements(markdown, opts.project);

      mkdirSync(ralphDir, { recursive: true });
      const prdPath = join(ralphDir, 'prd.json');
      writeFileSync(prdPath, JSON.stringify(prd, null, 2));

      console.log(`Imported ${prd.stories.length} stories into ${prdPath}`);
    } catch (e) {
      console.error(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

// --- Workflow commands ---

const workflowCmd = program.command('workflow').description('Manage reusable workflow templates');

workflowCmd
  .command('save')
  .description('Save current .ralph/ config as a named workflow')
  .argument('<name>', 'Workflow name')
  .action((name: string) => {
    try {
      saveWorkflow(name, resolveProjectDir());
      console.log(`Workflow "${name}" saved.`);
    } catch (e) {
      console.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

workflowCmd
  .command('use')
  .description('Apply a saved workflow to current project')
  .argument('<name>', 'Workflow name')
  .action((name: string) => {
    try {
      useWorkflow(name, resolveProjectDir());
      console.log(`Workflow "${name}" applied to .ralph/`);
    } catch (e) {
      console.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

workflowCmd
  .command('list')
  .description('List available workflows')
  .action(() => {
    const workflows = listWorkflows();
    if (workflows.length === 0) {
      console.log('No saved workflows. Use `ralph workflow save <name>` to create one.');
      return;
    }
    for (const w of workflows) {
      console.log(`  ${w.name} (${w.files.join(', ')}) — ${w.createdAt.split('T')[0]}`);
    }
  });

program.parse();
