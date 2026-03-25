# Ralph Next v0.1 — Design Document

**Version:** 0.1.0
**Status:** Implemented
**Primary environment:** Docker container
**Primary workflow:** One loop per repo (occasional 2–3 concurrent loops same container/repo)

---

## 1. Goal

Build a **safe, resumable autonomous coding loop** for AI coding agents.

The v0.1 goal is to be:
- reliable enough to run unattended
- simple enough to implement and debug quickly
- safe enough to bound cost, bad loops, and accidental file damage
- structured enough to support occasional multiple loops in the same repo

The loop cycle: select task → prepare context → run agent → validate result → update state → continue/pause/exit.

---

## 2. Non-Goals for v0.1

Out of scope:
- Full multi-agent orchestration
- File-level live conflict intelligence
- Intent parsing (INTENT_FILES)
- Rich web UI
- Global machine-wide orchestration
- Amp support
- Hooks platform
- GitHub issue import
- Provider-agnostic abstraction beyond immediate needs

---

## 3. Product Definition

**Name:** `ralph-next`

A CLI tool with a small internal library structure that runs an autonomous coding loop with durable per-run state and hard safety guardrails.

> A safe autonomous coding loop for one repo in one container, with lightweight support for occasional concurrent runs.

---

## 4. Key Design Principles

1. **Single-run correctness first** — default path is one loop, one repo, safely
2. **Durable state over implicit state** — explicit state on disk, resume and debug easily
3. **Safety is part of the control plane** — budget limits, circuit breakers, protected paths, validation gates are not optional
4. **Minimal concurrency support** — simple claim-and-lock model
5. **Keep the loop thin and testable** — orchestrator coordinates, doesn't contain business logic
6. **Docker is the security boundary** — no additional sandbox layer in v0.1

---

## 5. Tech Stack

- **Language:** TypeScript
- **Runtime validation:** zod
- **Test framework:** vitest
- **Dev runner:** tsx

---

## 6. Runtime Assumptions

Runs inside Docker:
- Host is isolated from loop commands
- Process lifecycle is container-scoped
- Repo-local state > machine-global state
- Same-container concurrency is limited and known

No machine-global run registry needed.

---

## 7. Execution Modes

| Mode | Description |
|---|---|
| Default | One loop, one repo, one container |
| Secondary | 2–3 loops same container/repo (claim-and-lock) |
| Cross-repo | Multiple loops, different repos, no special coordination needed |

---

## 8. Source Tree

```text
ralph-next/
├── src/
│   ├── cli/
│   │   └── index.ts
│   ├── core/
│   │   ├── loop.ts
│   │   ├── state-writer.ts
│   │   ├── circuit-breaker.ts
│   │   ├── exit-detector.ts
│   │   ├── signal-handler.ts
│   │   ├── validator.ts
│   │   ├── resume.ts
│   │   ├── hint.ts
│   │   ├── logger.ts
│   │   └── progress-writer.ts
│   ├── agents/
│   │   └── claude-code.ts
│   ├── context/
│   │   └── strategies.ts
│   ├── prd/
│   │   ├── tracker.ts
│   │   ├── claims.ts
│   │   └── importer.ts
│   ├── config/
│   │   └── loader.ts
│   ├── cost/
│   │   ├── pricing.ts
│   │   └── models.json
│   ├── sync/
│   │   ├── atomic-write.ts
│   │   ├── file-lock.ts
│   │   └── pid-utils.ts
│   ├── workflow/
│   │   └── manager.ts
│   └── types/
│       ├── state.ts
│       ├── config.ts
│       ├── agent.ts
│       └── prd.ts
├── tests/
├── .ralphrc.example
└── package.json
```

---

## 9. Runtime File Layout

```text
.ralph/
├── PROMPT.md          # Base loop prompt (human-authored)
├── AGENT.md           # Repo-specific commands/guidance (read-only during runs)
├── prd.json           # Task list
├── claims.json        # Story claiming coordination
├── .ralphrc           # Per-repo config
└── runs/
    └── {runId}/
        ├── run-state.json   # Per-run durable state (single source of truth)
        ├── loop.log         # Append-only run log
        └── hint.md          # Optional human message consumed before iteration
```

---

## 10. Run State

```ts
export interface RunState {
  runId: string;
  projectDir: string;
  startedAt: string;
  updatedAt: string;
  pid: number;

  agent: string;
  model?: string;
  status: 'running' | 'paused' | 'complete' | 'interrupted' | 'crashed';

  iteration: number;
  round: number;
  maxIterations?: number;

  currentStoryId?: string;
  currentStoryTitle?: string;
  currentClaimHeartbeatAt?: string;

  lastAgentOutputSummary?: string;
  lastValidationResult?: ValidationResult;
  lastError?: string;
  exitReason?: ExitReason;

  sessionId?: string;
  contextMode: 'continue' | 'fresh';

  cost: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheWriteTokens: number;
    estimatedCostUsd: number;
  };

  perIteration: Array<{
    iteration: number;
    round: number;
    storyId: string;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    estimatedCostUsd: number;
    validationPassed: boolean;
    summary?: string;
  }>;
}
```

State writing rules:
- One run writes only its own file
- Writes are atomic (temp file + rename)
- Flush at: run start, after story claim, after each iteration, on pause, on completion, on interruption, on crash

---

## 11. Agent Abstraction

v0.1 supports **Claude Code only**.

```ts
export interface AgentRunResult {
  output: string;
  exitCode: number;
  usage: TokenUsage | null;
  sessionId: string | null;
  isApiLimitHit: boolean;
  isRateLimitHit: boolean;
  rawJson: unknown | null;
  durationMs: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AgentRunOptions {
  prompt: string;
  allowedTools?: string[];
  sessionId?: string;
  timeoutMs?: number;
  outputFormat?: 'json' | 'text';
}

export interface IAgent {
  readonly name: string;
  readonly supportsSessionContinuity: boolean;
  readonly supportsStructuredOutput: boolean;
  run(options: AgentRunOptions): Promise<AgentRunResult>;
  parseOutput(raw: string): AgentRunResult;
  validateInstallation(): Promise<{ ok: boolean; version?: string; error?: string }>;
}
```

Claude Code adapter: prefer SDK mode when stable, fall back to CLI, parse token usage centrally.

---

## 12. Context Management

Two modes only (no auto mode in v0.1):

| Mode | When to use | Risk |
|---|---|---|
| `continue` | Short tasks, iterative work, lower overhead | Long sessions degrade |
| `fresh` | Long-running loops, cleaner control, safer recovery | More prompt assembly |

Fresh mode preamble: current story, prior run summary, AGENT.md commands, recent validation, repo state summary.

---

## 13. PRD and Task Model

```ts
export interface Story {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
  group?: number;
  status: 'active' | 'deferred';
  passes: boolean;
  consecutiveFailures?: number;
  lastError?: string;
}

export interface PRD {
  version: string;
  projectName: string;
  stories: Story[];
  qualityGates: {
    typecheck?: string;
    lint?: string;
    test?: string;
  };
}
```

---

## 14. Same-Repo Multi-Loop Support

### claims.json

```ts
export interface StoryClaim {
  storyId: string;
  runId: string;
  claimedAt: string;
  heartbeatAt: string;
  pid: number;
}

export interface ClaimsFile {
  claims: StoryClaim[];
}
```

### Claiming flow
1. Acquire short lock on `claims.json`
2. Read claims → prune stale → read `prd.json`
3. Find highest-priority unclaimed non-passing active story
4. Write claim → release lock

### Claim expiry
Stale if: PID not alive OR heartbeat older than configured TTL.

### Guarantees
- Two runs won't claim the same story simultaneously
- Stale claims don't block forever
- Each run isolated in its own run directory

### Accepted limitations
- No prevention of overlapping file edits across stories
- No semantic collision detection
- No auto-merge or conflict resolution

---

## 15. Validation Model

Every iteration flows through validation.

### Stages
1. **Command validation** — run quality gates (typecheck, lint, tests)
2. **Protected path validation** — reject if protected files modified
3. **Diff sanity checks** — too many files, large diff, unexpected lockfile changes
4. **Acceptance alignment** — compare result against story acceptance criteria

```ts
export interface ValidationResult {
  passed: boolean;
  commandResults: Array<{
    name: string;
    passed: boolean;
    exitCode: number;
    outputSummary?: string;
  }>;
  protectedPathsViolated: string[];
  warnings: string[];
  reasons: string[];
}
```

Story `passes` set to `true` only when: validation passes + no protected path violations + acceptance criteria satisfied.

---

## 16. Exit Detection

```ts
export type ExitReason =
  | 'converged'
  | 'no_progress'
  | 'max_iterations'
  | 'budget_exceeded'
  | 'circuit_breaker_terminal'
  | 'interrupted'
  | 'validation_failed_repeatedly';
```

Exit when: all stories converge (pass), no progress in a round, max iterations, budget exceeded, CB terminal, user interrupt, or repeated validation failures.

---

## 17. Cost Tracking

Limits: `maxCostUsd` (hard), `warnCostUsd` (warn), `maxTokensSession` (hard), `costPerIterationThreshold` (CB trip).

All cost math is estimates, stored in RunState.

---

## 18. Circuit Breaker

Trip conditions: no progress for N iterations, same error N times, cost spike, repeated validation failure, repeated permission denial.

States: `closed` → `open` → `half_open`

---

## 19. Protected Paths

Defaults:
- `.ralph/AGENT.md`, `.ralph/prd.json`, `.ralph/claims.json`, `.ralph/runs/**`
- `.env`, `.env.*`
- `**/*.lock`

Enforced in prompt AND validated after changes.

---

## 20. Resume and Interruption

On SIGINT/SIGTERM: request stop → wait for iteration → flush state → preserve claim (short TTL) → exit cleanly.

On crash: mark `crashed` best-effort, stale claim cleanup releases story later.

`resume <runId>` continues from same story if claim still valid.

---

## 21. Hint Injection

Human writes to `.ralph/runs/{runId}/hint.md` → loop reads before next iteration → prepends to prompt → deletes atomically after consumption.

---

## 22. Orchestrator

Two loop modes controlled by `loopMode` config:

| Mode | Behavior | Best for |
|---|---|---|
| `convergent` (default) | Run ALL active stories every round; converged when a full round produces zero changes and all gates pass | Audits, quality sweeps |
| `backlog` | Run only failing stories; done when all stories pass | Feature implementation, sequential work |

Stories with a `group` field run in parallel within the same group; groups execute sequentially.

```ts
export class RalphLoop {
  async run(): Promise<LoopResult> {
    await agent.validateInstallation();
    registerSignalHandlers(...);

    while (true) {  // outer loop: rounds
      if (budgetExceeded() || cbTerminal() || maxRoundsReached()) break;

      if (round > 1) reEvaluatePassingStories();  // re-run gates, flip regressions

      const stories = (loopMode === 'convergent')
        ? allActiveStories()       // convergent: every story
        : getFailingStories();     // backlog: only failing

      const groups = groupStories(stories);  // group field → parallel

      for (const group of groups) {
        // stories within a group run in parallel
        for (const story of group) {
          const result = await agent.run(buildPrompt(story, ...));
          const validation = await validator.validate(...);
          updateStoryPasses(story, validation);
        }
      }

      // convergent: exit when zero changes + all pass
      // backlog: exit when all pass or zero fixes
    }

    await finalizeRun();
    return buildResult();
  }
}
```

---

## 23. Configuration

```ts
export const RalphConfigSchema = z.object({
  agent: z.enum(['claude-code']).default('claude-code'),
  agentCmd: z.string().optional(),
  agentModel: z.string().optional(),
  contextMode: z.enum(['continue', 'fresh']).default('continue'),
  loopMode: z.enum(['backlog', 'convergent']).default('convergent'),
  timeoutMinutes: z.number().min(1).max(120).default(20),
  maxRounds: z.number().optional(),
  maxIterations: z.number().optional(),
  maxCostUsd: z.number().optional(),
  warnCostUsd: z.number().optional(),
  maxTokensSession: z.number().optional(),
  costPerIterationThreshold: z.number().optional(),
  cbNoProgressThreshold: z.number().default(3),
  cbSameErrorThreshold: z.number().default(4),
  cbCooldownMinutes: z.number().default(15),
  claimTtlMinutes: z.number().default(45),
  storyMaxConsecutiveFailures: z.number().default(3),
  protectedPaths: z.array(z.string()).optional(),
  allowedTools: z.array(z.string()).optional(),
  verbose: z.boolean().default(false),
});
```

Resolution: Flag > env var > `.ralph/.ralphrc` > defaults

---

## 24. CLI Surface

```bash
ralph run [--prompt "..." | --context-mode fresh | --max-cost 20 | --max-iterations 50]
ralph status [--run <runId>]
ralph logs
ralph cost
ralph resume <runId>
ralph hint --run <runId> "message"
ralph pause --run <runId>
ralph init
ralph import requirements.md
ralph dry-run
ralph workflow save <name>
ralph workflow use <name>
ralph workflow list
```

---

## 25. Failure Modes

| Failure | Mitigation |
|---|---|
| Agent loops without progress | CB + max iterations + budget caps |
| False completion | Validation gate + acceptance criteria check |
| Protected file modified | Prompt instruction + post-run validation |
| Process interrupted mid-iteration | Atomic state flush, TTL claim cleanup |
| Two loops claim same story | `claims.json` file lock |
| Different stories touch same file | Accepted v0.1 limitation |
| Claim never released after crash | TTL + PID checks |
| Cost estimation drift | Central pricing table, labeled as estimates |
| Agent output schema changes | Central parser + fixture tests + startup version check |
| Long session degrades | Fresh mode available, session expiry |
| Flaky validation | Output logged, repeated failures trip CB |

**Biggest accepted limitation:** v0.1 prevents same-story collisions but not same-file collisions across stories.

---

## 26. Testing Strategy

**Unit tests:** parser, config loader, state writer, circuit breaker, exit detector, validator, claims manager, stale claim pruning, resume logic, hint consumption.

**Integration tests:** happy path, interrupted resume, budget stop, CB trip, dual-loop no duplicate claim, stale claim recovery, protected path violation.

**Coverage goal:** 80%+

---

## 27. Implementation Phases

| Phase | Items | Milestone |
|---|---|---|
| 1 — Core loop | Scaffold, config, CC adapter, state types/writer, orchestrator, signals, basic CLI | One loop runs safely with durable state |
| 2 — Safety | Budget tracking, CB, protected paths, validation, exit detection | Unattended single-loop is safe |
| 3 — Concurrency | claims.json, file locking, stale pruning, resume+claims, concurrency tests | 2–3 loops no duplicate claims |
| 4 — Polish | Fresh context, hints, dry-run, README, log quality | v0.1 ready |
