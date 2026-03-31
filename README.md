# ralphx

Safe, resumable autonomous coding loop for AI coding agents.

ralphx wraps AI coding agents (Claude Code in v0.1) in a convergent loop with durable state, budget guardrails, and quality gates. It runs unattended, pauses on failure, and resumes where it left off.

## Install

```bash
npm install -g ralphx
```

Requires Node.js >= 18 and [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed.

## Quick Start

```bash
cd your-repo

# Create a workspace
ralphx init audit

# Edit .ralphx/audit/prd.json with your stories
# Edit .ralphx/audit/PROMPT.md with loop instructions

# Run the loop
ralphx run audit --max-iterations 20 --max-cost 5.00

# Check status
ralphx status audit
ralphx cost audit
ralphx logs audit
```

## Workspaces

Every command takes a workspace name. Each workspace is an independent environment with its own PRD, prompt, config, and run history.

```bash
# Run multiple independent loops on the same repo
ralphx init dev
ralphx init audit
ralphx run dev &
ralphx run audit
```

Workspace layout:
```
.ralphx/<workspace>/
├── prd.json       Task definitions and acceptance criteria
├── PROMPT.md      Instructions for the coding loop
├── AGENT.md       Repo-specific agent guidance
├── .ralphxrc      Configuration (budget, timeouts, etc.)
├── progress.md    Loop-managed progress tracking (created/deleted by runs)
└── runs/          Run history (one subdirectory per run)
```

## How It Works

1. **Define stories** in `.ralphx/<workspace>/prd.json` with acceptance criteria
2. **Run the loop** -- ralphx iterates through stories, invoking the agent for each
3. **Quality gates** validate results after each agent run (tests, type checks, protected paths)
4. **Convergence** -- stories are re-evaluated each round; the loop exits when all pass or no progress is made
5. **Circuit breakers** trip on repeated failures to prevent runaway costs

## CLI Commands

```
ralphx init <workspace>                          Create a new workspace
ralphx run <workspace> [options]                 Start the coding loop
  --prompt "..."                                 Prepend text to loop prompt
  --context-mode fresh|continue                  Context strategy
  --max-iterations N                             Iteration budget
  --max-cost USD                                 Cost budget
  --timeout M                                    Per-iteration timeout (minutes)
  --verbose                                      Enable verbose logging
  --resume <runId>                               Resume a previous run

ralphx status <workspace> [--run <id>]           Show run status
ralphx logs <workspace> [--run <id>] [-n lines]  Tail loop log
ralphx cost <workspace> [--run <id>]             Show cost breakdown
ralphx hint <workspace> "message" --run <id>     Inject a hint for next iteration
ralphx pause <workspace> --run <id>              Request a running loop to pause
ralphx dry-run <workspace>                       Preview resolved config without running
ralphx import <file> <workspace>                 Parse markdown into prd.json
ralphx workflow save <name> <workspace>          Save workspace config as template
ralphx workflow use <name> <workspace>           Apply template to workspace
ralphx workflow list                             List saved templates
```

## Configuration

Configuration resolves as: CLI flags > environment variables > `.ralphx/<workspace>/.ralphxrc` > defaults.

See `.ralphx/<workspace>/.ralphxrc` after `ralphx init` for available options.

## Safety

- **Budget limits** -- max iterations, max cost, per-iteration timeout
- **Circuit breakers** -- trip on no-progress or repeated errors
- **Protected paths** -- flag modifications to critical files as warnings for human review
- **Quality gates** -- run tests and type checks after each iteration
- **Docker isolation** -- designed to run inside containers

## License

MIT
