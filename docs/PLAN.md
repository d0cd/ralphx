# Ralph Next v0.1 — Implementation Plan

Concrete tasks organized by phase. Each task lists what to build, what tests to write, and the definition of done.

---

## Phase 1 — Core Loop

### Task 1.1: Repo Scaffold

**Build:**
- Initialize npm project with TypeScript, vitest, tsx
- Set up `tsconfig.json` (strict mode)
- Set up `vitest.config.ts` with coverage
- Create source tree directories per design
- Add `.ralphrc.example`

**Tests:**
- `npm run build` succeeds with no errors
- `npm test` runs (empty suite passes)

**Done when:** `npm run build && npm test` both pass cleanly.

---

### Task 1.2: Types

**Build:**
- `src/types/state.ts` — `RunState`, `ValidationResult`, `ExitReason`, per-iteration record
- `src/types/config.ts` — `RalphConfig` type (inferred from zod schema)
- `src/types/agent.ts` — `AgentRunResult`, `TokenUsage`, `AgentRunOptions`, `IAgent`

**Tests:**
- Type-level tests: create valid objects of each type, assert zod parse where applicable
- Invalid objects are rejected by zod schemas

**Done when:** All types compile, zod schemas validate/reject correctly.

---

### Task 1.3: Config Loader

**Build:**
- `src/types/config.ts` — zod schema (`RalphConfigSchema`) and `RalphConfig` type
- `src/config/loader.ts` — load from `.ralph/.ralphrc` (JSON), merge env vars, merge CLI flags, apply defaults
- Resolution order: flags > env > file > defaults

**Tests:**
- `config.loader.test.ts`:
  - Loads valid `.ralphrc` file
  - Returns defaults when no file exists
  - Env var overrides file value
  - CLI flag overrides env var
  - Invalid config throws with clear error message
  - Partial config merges correctly with defaults
  - Unknown keys are stripped (not error)

**Done when:** Config loads correctly with full resolution chain.

---

### Task 1.4: State Writer

**Build:**
- `src/core/state-writer.ts`
  - `StateWriter` class: owns a single `RunState`, writes to `.ralph/runs/{runId}/run-state.json`
  - Atomic writes: write to temp file, rename
  - Methods: `initialize()`, `recordIteration()`, `recordValidation()`, `setStatus()`, `flush()`
  - Append to `loop.log` on each flush

**Tests:**
- `state-writer.test.ts`:
  - Creates run directory and initial state file
  - State file is valid JSON after flush
  - Atomic write: if process dies mid-write, no corrupt file (simulate by checking temp file cleanup)
  - `recordIteration()` appends to `perIteration` array and updates cost totals
  - `recordValidation()` updates `lastValidationResult`
  - `setStatus()` updates status field
  - Concurrent flushes don't corrupt (sequential calls, verify each)
  - `loop.log` grows with each flush

**Done when:** StateWriter creates, updates, and persists run state atomically.

---

### Task 1.5: Agent Interface and Claude Code Adapter

**Build:**
- `src/types/agent.ts` — `IAgent` interface (and related types)
- `src/agents/claude-code.ts` — `ClaudeCodeAgent` class
  - `validateInstallation()` — check `claude` CLI exists and version
  - `run()` — invoke claude with prompt, parse output
  - `parseOutput()` — extract structured result from JSON output
  - Support `--output-format json` for structured parsing
  - Handle API limit and rate limit detection from output

**Tests:**
- `claude-code.test.ts`:
  - `parseOutput()` correctly parses fixture JSON output into `AgentRunResult`
  - Handles missing usage fields gracefully (null)
  - Detects `isApiLimitHit` from known error patterns
  - Detects `isRateLimitHit` from known error patterns
  - `validateInstallation()` returns error when CLI not found (mock child_process)
  - `run()` constructs correct CLI args from `AgentRunOptions`
  - Timeout kills child process after configured duration

**Done when:** Adapter parses real Claude Code output fixtures correctly.

---

### Task 1.6: Signal Handler

**Build:**
- `src/core/signal-handler.ts`
  - Register SIGINT, SIGTERM handlers
  - On first signal: set `stopRequested` flag, log
  - On second signal: force exit
  - Expose `isStopRequested()` for loop to check

**Tests:**
- `signal-handler.test.ts`:
  - After registering, `isStopRequested()` is false
  - Simulating SIGINT sets `isStopRequested()` to true
  - Callback is invoked on signal
  - Second signal calls process.exit (mock)

**Done when:** Signal handler sets stop flag and allows graceful shutdown.

---

### Task 1.7: Base Orchestrator (Loop)

**Build:**
- `src/core/loop.ts` — `RalphLoop` class
  - Constructor takes config, agent, state writer
  - `run()` method: main loop per design
  - Check exit conditions each iteration
  - Call agent, record iteration, validate (stub validator for now)
  - Return `LoopResult` with final state and exit reason

**Tests:**
- `loop.test.ts` (with mock agent):
  - Runs N iterations when maxIterations=N
  - Stops when agent reports all tasks done
  - Stops when `isStopRequested()` returns true
  - Records each iteration in state
  - Flushes state at expected boundaries

**Done when:** Loop runs with mock agent, respects iteration limit and stop signal.

---

### Task 1.8: Basic CLI (`run`, `status`, `logs`)

**Build:**
- `src/cli/index.ts` — CLI entry point (use `commander`)
- `ralph run` — create run, start loop
- `ralph status` — read latest or specified run-state.json, print summary
- `ralph logs` — tail loop.log for latest or specified run

**Tests:**
- `cli.test.ts`:
  - `ralph status` with no runs prints "no runs found"
  - `ralph status` with existing run prints status summary
  - `ralph logs` prints log content
  - `ralph run --max-iterations 1` creates a run directory

**Done when:** CLI commands work for basic single-loop workflow.

---

### Phase 1 Audit Gate

Before starting Phase 2, audit all Phase 1 code for production readiness:

- **Error handling:** All file I/O wrapped in try-catch with meaningful errors. No unhandled promise rejections in the loop.
- **Test coverage:** Every exported function has tests. Edge cases (missing files, corrupt JSON, empty inputs) are covered.
- **No silent failures:** Functions that fail must throw or return errors, never silently do nothing.
- **No dead code:** Remove unused variables, unreachable branches.
- **Type safety:** `tsc --noEmit` passes clean. No `any` types that could be narrowed.
- **Build verification:** `npm run build && npm test` both pass.

**Done when:** All issues found in audit are resolved, full test suite passes, build is clean.

---

## Phase 2 — Safety

### Task 2.1: Cost Tracking

**Build:**
- `src/cost/pricing.ts` — pricing lookup by model
- `src/cost/models.json` — pricing data
- Integrate into StateWriter: accumulate token counts and estimated cost per iteration
- Check `maxCostUsd` and `maxTokensSession` in loop exit conditions

**Tests:**
- `pricing.test.ts`:
  - Known model returns correct per-token prices
  - Unknown model returns fallback/error
  - Cost calculation matches expected value for known token counts
- `loop.test.ts` additions:
  - Loop exits when `maxCostUsd` exceeded
  - Loop exits when `maxTokensSession` exceeded
  - Warning logged when `warnCostUsd` reached

**Done when:** Cost is tracked per-iteration and budget limits stop the loop.

---

### Task 2.2: Circuit Breaker

**Build:**
- `src/core/circuit-breaker.ts`
  - States: `closed`, `open`, `half_open`
  - Track: consecutive no-progress count, same-error count, per-iteration cost
  - `recordIteration()` — update internal counters
  - `trip()` — open the breaker
  - `isTerminal()` — true if breaker is open and cooldown not elapsed
  - `tryHalfOpen()` — transition to half_open after cooldown

**Tests:**
- `circuit-breaker.test.ts`:
  - Starts `closed`
  - Trips to `open` after N no-progress iterations
  - Trips on same error repeated N times
  - Trips on cost spike above threshold
  - Transitions to `half_open` after cooldown
  - Returns to `closed` on successful iteration in `half_open`
  - `isTerminal()` returns true when open and cooldown not elapsed
  - Reset clears all counters

**Done when:** CB correctly transitions through states based on iteration outcomes.

---

### Task 2.3: Protected Paths

**Build:**
- In validator: after agent run, check git diff for modified files
- Compare against configured + default protected paths (glob matching)
- Return violations in `ValidationResult.protectedPathsViolated`
- Inject protected path list into agent prompt

**Tests:**
- `validator.test.ts` (protected paths):
  - No violation when only non-protected files changed
  - Violation detected when `.env` modified
  - Violation detected when `.ralph/prd.json` modified
  - Glob patterns work (`**/*.lock` matches `package-lock.json`)
  - Custom protected paths from config are honored
  - Violations block story completion

**Done when:** Protected path violations are detected and prevent completion.

---

### Task 2.4: Validation Pipeline

**Build:**
- `src/core/validator.ts`
  - Run quality gate commands (typecheck, lint, test) from PRD config
  - Check protected paths (from 2.3)
  - Diff sanity: count changed files, diff size, lockfile changes
  - Return `ValidationResult`

**Tests:**
- `validator.test.ts`:
  - All commands pass → `passed: true`
  - One command fails → `passed: false`, correct `commandResults`
  - Protected path violation → `passed: false`
  - Diff too large → warning in result
  - Too many files changed → warning
  - No quality gates configured → skip command validation, still check paths
  - Command timeout → treated as failure

**Done when:** Validation runs all stages and returns structured result.

---

### Task 2.5: Exit Detection

**Build:**
- Exit conditions evaluated in the loop:
  - All tasks done, max iterations, budget, CB terminal, signal, repeated validation failures
  - Return `ExitReason | null`

**Tests:**
- Exit detection tests:
  - Returns `null` when no exit condition met
  - Returns `'converged'` when all stories pass
  - Returns `'max_iterations'` at limit
  - Returns `'budget_exceeded'` when cost over max
  - Returns `'circuit_breaker_terminal'` when CB is terminal
  - Returns `'interrupted'` when stop requested
  - Returns `'validation_failed_repeatedly'` after N consecutive failures

**Done when:** Exit detection correctly identifies all exit conditions.

---

### Phase 2 Audit Gate

Before starting Phase 3, audit all Phase 2 code for production readiness using the same criteria as Phase 1 audit gate, plus:

- **Safety invariants hold:** Budget limits actually stop the loop. CB actually trips. Protected paths actually block completion.
- **Integration between modules:** Validator, CB, exit detection, and cost tracker are wired into the loop correctly.
- **No hardcoded TODOs in critical paths:** Cost calculation must use real estimates, not zero.

**Done when:** All issues resolved, full test suite passes, build is clean.

---

## Phase 3 — Polish

### Task 3.1: Fresh Context Mode

**Build:**
- `src/context/strategies.ts`
  - `buildFreshPrompt(story, priorSummary, agentMd, validationResults, repoState)` — assemble full prompt
  - `buildContinuePrompt(story, hint)` — minimal prompt for session continuation

**Tests:**
- `strategies.test.ts`:
  - Fresh prompt includes all expected sections
  - Fresh prompt includes prior summary when available
  - Continue prompt includes story and hint
  - Continue prompt omits prior summary

**Done when:** Both context modes produce correct prompts.

---

### Task 3.2: Hint Injection

**Build:**
- In loop: before building prompt, check for `.ralph/runs/{runId}/hint.md`
- If exists: read content, prepend to prompt, delete file atomically

**Tests:**
- `hint.test.ts`:
  - Hint file content is prepended to prompt
  - Hint file is deleted after consumption
  - No hint file → prompt unchanged
  - Empty hint file → ignored and deleted

**Done when:** Hints are consumed exactly once.

---

### Task 3.3: Dry Run

**Build:**
- `ralph dry-run` — run full setup (config, PRD load, agent validation, prompt build) but do not invoke agent
- Print: resolved config, next story, assembled prompt, validation commands

**Tests:**
- `cli.test.ts` addition:
  - `ralph dry-run` exits 0 with expected output sections
  - `ralph dry-run` with invalid config exits non-zero

**Done when:** Dry run shows what would happen without executing.

---

### Task 3.4: Resume

**Build:**
- `src/core/resume.ts`
  - `findResumableRun(runId)` — load run-state.json, verify status is `interrupted` or `paused`
  - `resumeRun(runId)` — restore state, continue loop

**Tests:**
- `resume.test.ts`:
  - Resumes interrupted run from correct iteration
  - Resumes paused run
  - Fails to resume completed run
  - Restores cost totals from previous state

**Done when:** Resume continues from prior state correctly.

---

### Task 3.5: Remaining CLI Commands

**Build:**
- `ralph cost` — print cost summary from run state
- `ralph resume <runId>` — wire to resume module
- `ralph hint --run <runId> "msg"` — write hint.md
- `ralph pause --run <runId>` — set run status to paused
- `ralph init` — create `.ralph/` directory with template files
- `ralph import <file>` — parse markdown requirements into prd.json

**Tests:**
- `ralph cost` shows correct totals
- `ralph hint` writes hint.md to correct run directory
- `ralph pause` updates run-state.json status
- `ralph init` creates expected directory structure
- `ralph import` produces valid prd.json from markdown input

**Done when:** All CLI commands from the design are functional.

---

### Task 3.6: Workflow Templates

**Build:**
- `src/workflow/manager.ts`
  - `saveWorkflow(name, projectDir)` — save .ralph/ config as reusable workflow
  - `useWorkflow(name, projectDir)` — apply saved workflow to current project
  - `listWorkflows()` — list available workflows

**Tests:**
- Workflow save/use/list round-trip works
- Missing workflow returns error

**Done when:** Workflow commands work end-to-end.

---

### Task 3.7: Log and Error Message Quality

**Build:**
- Review all log output for clarity and consistency
- Ensure errors include actionable context
- Add structured log levels (info, warn, error, debug behind --verbose)

**Tests:**
- Spot-check: key scenarios produce expected log messages
- `--verbose` shows debug output, default does not

**Done when:** Logs are clear and helpful for debugging.

---

## Summary

| Phase | Tasks | Key milestone |
|---|---|---|
| 1 | 1.1–1.8 + audit | One loop runs safely with durable state |
| 2 | 2.1–2.5 + audit | Unattended single-loop is safe |
| 3 | 3.1–3.7 | v0.1 ready |

Each phase ends with a mandatory audit gate. No phase starts until the prior audit passes.

Total: 20 tasks, 24 test files, targeting 80%+ coverage.

---

## Implementation Status

All phases complete. 242 tests passing across 24 test files. Build and types clean.

Each phase passed a mandatory audit gate before the next began. See audit gate sections above for criteria.
