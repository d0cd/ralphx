# Ralph Redesign — Convergent Loop Model

## Problem

Our current design uses `status: 'todo' | 'done'` — a task queue. Once a story is marked done, it's never re-evaluated. This means:
- Cross-story regressions are missed
- The loop can't converge to a fixed point
- "10 audits" doesn't mean "10 clean audits"

The original Ralph uses `passes: boolean` which is re-evaluated each iteration. But both snarktank/ralph and ralphX trust the agent to set `passes` honestly, with no independent verification.

## Design Principles

1. **The loop verifies, not the agent.** Quality gates are run by the orchestrator, not delegated to the agent. The agent writes code; the loop decides if it passes.

2. **`passes` is derived, not declared.** A story passes when its acceptance criteria are met AND all quality gates pass AND no protected paths are violated. The agent doesn't set `passes` — the loop computes it.

3. **Convergence = zero-fix round.** The loop exits when a full round evaluates all stories and none need work. Not when the agent says "done."

4. **Fresh context every iteration.** Prevents drift. State lives in files, not the context window.

5. **One story per iteration.** Keeps scope bounded and diffs reviewable.

## Key Changes from Current Design

### 1. Story schema: add `passes` back

```ts
interface Story {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
  status: 'active' | 'deferred';  // human intent only
  passes: boolean;                 // loop-computed, not agent-set
  lastCheckedAt?: string;
  lastError?: string;
}
```

- `status` is for humans: "active" means the loop should work on it, "deferred" means skip it
- `passes` is for the loop: computed from quality gates after each iteration
- The agent never writes `passes` directly — the loop does after validation

### 2. Iteration cycle changes

Current:
```
claim story → run agent → validate → if pass: mark done, release claim → next
```

New:
```
find first story where passes=false AND status=active
  → run agent on it
  → run quality gates (typecheck, lint, test)
  → set passes = (gates pass AND no protected path violations)
  → commit if passes flipped to true
  → record iteration
  → continue to next story with passes=false
```

### 3. Convergence detection

```
round = one pass through all active stories
if all active stories have passes=true at the start of a round:
  exit with 'converged'
if a full round completes with zero stories flipped from false→true:
  exit with 'no_progress' (circuit breaker territory)
```

New exit reason: `'converged'` — the fixed point.

### 4. Re-evaluation

After any iteration modifies code, ALL stories should have their `passes` re-checked in the next round. This catches cross-story regressions.

Simple approach: at the start of each round, re-run quality gates. If any story that was `passes=true` now fails gates, flip it back to `passes=false`.

### 5. Progress tracking: `progress.md` replaces raw state

Add a `progress.md` file (like Ralph's `progress.txt`) that the agent reads for context and the loop appends to after each iteration. This is the inter-iteration memory.

Format:
```markdown
## Iteration 3 — [story-2] Add auth middleware
- Implemented JWT validation in middleware/auth.ts
- Tests pass, typecheck clean
- Note: had to update the User type to include tokenExpiry

## Codebase Patterns
- Tests are in tests/ mirroring src/ structure
- Use zod for all runtime validation
- Atomic file writes via temp+rename pattern
```

The loop manages the "Iteration N" entries. The agent is instructed to update the "Codebase Patterns" section if it discovers reusable knowledge.

### 6. Quality gate verification is independent

The loop runs quality gates itself — not the agent. This is already true in our design. The key change is that gate results directly control `passes`, not agent exit codes.

```
passes = qualityGates.allPass()
       && protectedPaths.noneViolated()
       && diffSanity.ok()
```

The agent's exit code and output are inputs to the circuit breaker (was there progress?), not to completion (did it pass?).

### 7. Circuit breaker refinements

Track per-story failure count:
```ts
interface StoryAttempt {
  storyId: string;
  attempts: number;
  consecutiveFailures: number;
  lastError?: string;
}
```

If a story fails N consecutive times, skip it for this round and move on. Report it as blocked. This prevents burning all iterations on one stuck story.

### 8. What we keep from current design

- StateWriter with atomic writes ✓
- Signal handler for graceful shutdown ✓
- Cost tracking and budget limits ✓
- Validator with quality gates + protected paths ✓
- Circuit breaker (enhanced per-story) ✓
- Hint injection ✓
- Logger ✓
- Claude Code SDK adapter ✓
- All CLI commands ✓

### 9. What we change

| Component | Current | New |
|-----------|---------|-----|
| Story completion | `status: done` (permanent) | `passes: boolean` (re-evaluated) |
| Who decides "done" | Agent exit code + validation | Loop-computed from gates only |
| Loop exit | All stories `done` or max iterations | All stories `passes=true` (convergence) or max iterations |
| Re-evaluation | Never | Every round re-checks all stories |
| Progress memory | None | `progress.md` append log |
| Per-story tracking | None | Attempt count, consecutive failures |
| Stuck detection | Global circuit breaker only | Per-story skip after N failures |

### 10. What we do better than snarktank/ralph and ralphX

| Feature | snarktank/ralph | ralphX | Our redesign |
|---------|----------------|--------|-------------|
| Convergence verification | Trust agent (magic string) | Trust agent (magic string) | Loop-computed from gates |
| Quality gates | Agent runs them (prompt instruction) | Agent runs them (prompt instruction) | Loop runs them independently |
| Cost tracking | None | None | Per-iteration with budget caps |
| Circuit breaker | None | None | Global + per-story |
| Timeout | None | None | Per-iteration with graceful kill |
| Rollback | None | None | Future: git checkpoint per iteration |
| Progress memory | `progress.txt` (unbounded) | `progress.txt` (unbounded) | `progress.md` (structured, compactable) |
| Structured output | Grep for magic string | Grep for magic string | SDK streaming with typed messages |
| Resumability | None (restart from scratch) | None | Durable run state, `ralph resume` |

## Implementation Plan

### Phase 1: Core convergence refactor
1. Update `Story` type: add `passes: boolean`, change `status` to `'active' | 'deferred'`
2. Update loop: find stories by `passes=false`, not `status=todo`
3. Update loop: set `passes` from validation result, not agent exit code
4. Add round tracking: detect when all stories pass
5. Add `'converged'` exit reason
6. Update tests

### Phase 2: Re-evaluation and regression detection
7. At round start: re-run quality gates for all `passes=true` stories
8. Flip `passes` back to `false` if gates fail
9. Add `progress.md` append after each iteration
10. Update tests

### Phase 3: Per-story circuit breaker
11. Track attempt count per story
12. Skip stories that fail N consecutive times in a round
13. Report blocked stories
14. Update tests

Estimated scope: ~200 lines of loop.ts changes, ~100 lines of new tests, type updates.
