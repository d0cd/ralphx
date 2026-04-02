# ralphx v0.1

## What is this project?

An autonomous coding loop CLI tool (`ralphx`) that wraps AI coding agents (Claude Code only in v0.1) in a safe, resumable loop with durable state and budget guardrails.

## Tech stack

- **Language:** TypeScript (strict mode)
- **Runtime validation:** zod
- **Testing:** vitest (80%+ coverage required)
- **Dev runner:** tsx
- **CLI framework:** commander

## Key directories

- `docs/DESIGN.md` — full design document
- `docs/PLAN.md` — implementation plan with tasks and tests
- `src/` — source code
- `tests/` — test files
- `.ralphx/` — runtime directory (created in target repos, not in this repo's source)

## Source tree

```
src/
├── cli/
│   ├── index.ts          — CLI entry point (commander)
│   └── helpers.ts        — Workspace/run path helpers
├── core/
│   ├── loop.ts           — Main orchestrator
│   ├── state-writer.ts   — Atomic run state persistence
│   ├── circuit-breaker.ts — Trip on no-progress/repeated errors
│   ├── validator.ts      — Quality gates + protected paths + diff sanity
│   ├── signal-handler.ts — SIGINT/SIGTERM graceful shutdown
│   ├── hint.ts           — Hint file consumption
│   ├── resume.ts         — Find resumable runs
│   ├── logger.ts         — Structured log levels
│   ├── errors.ts         — Error handling utilities
│   └── progress-writer.ts — Progress markdown output
├── agents/
│   └── claude-code.ts    — Claude Code CLI/SDK adapter
├── context/
│   └── strategies.ts     — Fresh/continue prompt building
├── prd/
│   ├── tracker.ts        — Load/update prd.json
│   └── importer.ts       — Markdown → prd.json
├── config/
│   └── loader.ts         — Config resolution (flag > env > file > defaults)
├── cost/
│   ├── pricing.ts        — Per-model cost estimation
│   └── models.json       — Pricing data
├── sync/
│   └── atomic-write.ts   — Atomic JSON write (temp+rename)
├── workflow/
│   └── manager.ts        — Save/use/list reusable workflow templates
└── types/
    ├── state.ts          — RunState, ValidationResult, ExitReason
    ├── config.ts         — RalphConfig zod schema
    ├── agent.ts          — IAgent, AgentRunResult, TokenUsage
    └── prd.ts            — Story, PRD
```

## Architecture rules

- **Convergent loop** — stories have `passes: boolean` re-evaluated each round. Loop exits when all pass (fixed point) or no progress is made.
- **The loop decides pass/fail, not the agent** — quality gates are run by the orchestrator. `passes` is computed from gate results, never set by the agent.
- **Orchestrator is thin** — `src/core/loop.ts` sequences operations; business logic lives in focused modules
- **StateWriter is the only writer** of `run-state.json` — atomic writes via temp+rename
- **One run = one state file** — runs never write to each other's state
- **Docker is the security boundary** — no additional sandbox layer
- **Agent interface** — all agent interaction goes through `IAgent` interface in `src/types/agent.ts`
- **Stories run sequentially** in priority order; the agent handles its own parallelism via subagents

## Development rules

- Test-driven: write the failing test first
- Smallest change that solves the problem — no refactoring outside the task
- All cost math is estimates — label clearly, never present as exact
- Protected paths enforced in prompt AND validation — prompt alone is not sufficient
- Config resolution: CLI flag > env var > `.ralphx/<workspace>/.ralphxrc` > defaults
- Every phase of implementation ends with a mandatory audit before continuing

## CLI commands

Every command takes a `<workspace>` name. Each workspace is independent at `.ralphx/<workspace>/`.

```
ralphx run <workspace> [options]                 — start or resume a coding loop
ralphx status <workspace> [--run <id>]           — show run status
ralphx logs <workspace> [--run <id>] [-n lines]  — tail loop log
ralphx cost <workspace> [--run <id>]             — show cost breakdown
ralphx hint <workspace> "msg" --run <id>         — inject hint for next iteration
ralphx pause <workspace> --run <id>              — mark run as paused
ralphx diff <workspace> [--stat]                  — show what the loop changed
ralphx dry-run <workspace>                       — show resolved config + PRD without running
ralphx import <file> <workspace>                 — parse markdown into prd.json
ralphx workflow save <name> <workspace>          — save workspace config as template
ralphx workflow use <name> <workspace>           — apply template to workspace
ralphx workflow list                             — list saved templates
ralphx --agent-help                              — detailed workspace setup guide for agents
```

## Convergence model

Stories have `passes: boolean` (loop-computed) and `status: 'active' | 'deferred'` (human intent).
- One round = one pass through all failing stories
- `passes` flipped by the loop based on quality gate results, not the agent
- At round start, all passing stories are re-evaluated; regressions flip `passes` back to false
- Exit when: all stories pass (converged), zero-fix round (no_progress), budget/iterations exceeded
- Per-story circuit breaker: skip stories that fail N consecutive times

## Implementation status

Convergent loop model with workflows. 400 tests, 24 test files, build and types clean.
