# Agent Instructions

## Repo
- TypeScript, strict mode, ESM (`"type": "module"`)
- Runtime validation: zod v4
- Tests: vitest — run with `npm test` or `npx vitest run`
- Type check: `npx tsc --noEmit`
- Build: `npm run build` (runs `tsc && cp src/cost/models.json dist/cost/models.json`)
- CLI: `src/cli/index.ts` → `dist/cli/index.js`
- Agent SDK: `@anthropic-ai/claude-agent-sdk` (query() function, streaming)

## Source structure
```
src/
├── core/         loop, state-writer, circuit-breaker, validator, exit-detector,
│                 signal-handler, hint, logger, progress-writer, resume
├── agents/       claude-code adapter (SDK-based)
├── prd/          tracker (load/update/group), claims, importer
├── config/       loader (flag > env > file > defaults)
├── cost/         pricing + models.json
├── sync/         file-lock, pid-utils
├── context/      fresh/continue prompt strategies
├── workflow/     save/use/list reusable templates
└── types/        state, config, agent, prd
```

## Key design decisions
- Convergent loop: `passes: boolean` re-evaluated each round, loop-computed from gates
- Two modes: `backlog` (features, sequential) vs `convergent` (audits, re-runs all)
- Declarative parallelism: `group` field on stories, same group runs in parallel
- Fresh context each iteration, state on disk (prd.json, progress.md, run-state.json)
- Claims for multi-process coordination
- Quality gates run by the loop, not the agent

## When auditing
- Use `Agent` tool with `subagent_type: "Explore"` for deep investigation
- Launch multiple subagents in parallel for independent checks
- Always run `npm test` after making changes
- Be specific: file paths, line numbers, what's wrong
