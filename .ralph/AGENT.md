# Agent Instructions

## Repo
- TypeScript, strict mode, ESM (`"type": "module"`)
- Runtime validation: zod
- Tests: vitest — run with `npm test` or `npx vitest run`
- Type check: `npx tsc --noEmit`
- CLI: `src/cli/index.ts`
- Agent SDK: `@anthropic-ai/claude-agent-sdk` (query() function, streaming)

## Source structure
```
src/
├── core/         loop, state-writer, circuit-breaker, validator,
│                 signal-handler, hint, logger, progress-writer, resume
├── agents/       claude-code adapter (SDK-based)
├── prd/          tracker (load/update), importer
├── config/       loader (flag > env > file > defaults)
├── cost/         pricing + models.json
├── sync/         atomic-write (temp+rename)
├── context/      fresh/continue prompt strategies
├── workflow/     save/use/list reusable templates
└── types/        state, config, agent, prd
```

## Key design decisions
- Convergent loop: `passes: boolean` re-evaluated each round, loop-computed from gates
- Two modes: `backlog` (features, sequential) vs `convergent` (audits, re-runs all)
- Stories run sequentially in priority order; the agent handles its own parallelism via subagents
- Fresh context each iteration, state on disk (prd.json, progress.md, run-state.json)
- Quality gates run by the loop, not the agent

## When auditing
- Use `Agent` tool with `subagent_type: "Explore"` for deep investigation
- Launch multiple subagents in parallel for independent checks
- Always run `npm test` after making changes
- Be specific: file paths, line numbers, what's wrong
