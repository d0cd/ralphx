const AGENT_HELP = `
ralphx — Agent Setup Guide
===========================

ralphx runs autonomous coding loops with quality gates, budget limits,
and convergence detection. This guide has everything you need to create
a workspace and run the tool.

## Creating a Workspace

No command needed. Create the directory and files directly:

  mkdir -p .ralphx/audit
  # Write prd.json and PROMPT.md (see schemas below)
  ralphx run audit

The runs/ directory is created automatically on first run.
Alternatively, use \`ralphx import requirements.md audit\` to generate
prd.json from a markdown file with ## headings for each story.

## Workspace Layout

.ralphx/<workspace>/
├── prd.json       Required. Task definitions and acceptance criteria.
├── PROMPT.md      Required. Instructions for the coding loop.
├── AGENT.md       Optional. Repo-specific agent guidance.
└── .ralphxrc      Optional. Config overrides (defaults are sensible).

## prd.json

A story defines a unit of work with acceptance criteria. The loop runs
the agent on each story and uses quality gates to verify the result.

Fields:
  version            "1.0"
  projectName        Project identifier (string)
  stories[]          Array of story objects:
    id               Unique string identifier (e.g., "auth", "tests")
    title            Short description
    description      Detailed description of what needs to be done
    acceptanceCriteria   Array of strings — verification checks
    priority         Number (lower = higher priority)
    status           "active" or "deferred"
    passes           Set to false initially
  qualityGates       Commands that run at end of each round:
    typecheck        e.g., "npx tsc --noEmit" (optional)
    test             e.g., "npm test" (optional)
    lint             e.g., "npx eslint ." (optional)

Minimal example:

  {
    "version": "1.0",
    "projectName": "my-audit",
    "stories": [
      {
        "id": "docs",
        "title": "Documentation accuracy",
        "description": "Verify docs match the implementation.",
        "acceptanceCriteria": [
          "Confirm README describes the actual CLI commands",
          "Confirm no references to deleted files"
        ],
        "priority": 1,
        "status": "active",
        "passes": false
      }
    ],
    "qualityGates": {
      "typecheck": "npx tsc --noEmit",
      "test": "npm test"
    }
  }

### Writing Acceptance Criteria

Write criteria as verification questions, not implementation mandates:

  Good: "Confirm config resolution produces correct results"
  Bad:  "Add config validation"

  Good: "Confirm error messages include the next action to take"
  Bad:  "Add helpful error messages"

The agent checks each criterion and reaches a verdict:
  - No issue: state what was checked and why it's fine
  - Real issue: fix it
  - Known tradeoff: describe why the current design is acceptable

## .ralphxrc

All fields are optional. Defaults shown in parentheses.

  agentCmd             Agent CLI command ("claude")
  agentModel           Model override (e.g., "claude-sonnet-4-6")
  contextMode          "continue" or "fresh" ("continue")
  loopMode             "convergent" or "backlog" ("convergent")
  timeoutMinutes       Per-iteration timeout, 1-120 (20)
  maxIterations        Total iteration limit (unlimited)
  maxRounds            Total round limit (unlimited)
  maxCostUsd           Budget cap in USD (unlimited)
  warnCostUsd          Cost warning threshold (none)
  convergenceThreshold Clean rounds needed to converge (1)
  cbNoProgressThreshold  No-progress iterations before circuit breaker (3)
  cbSameErrorThreshold   Same-error iterations before circuit breaker (4)
  storyMaxConsecutiveFailures  Failures before skipping a story (3)
  protectedPaths       Files the agent should not modify ([".ralphx/**", ".env", ".env.*"])
  verbose              Show agent progress events (false)

Minimal example:

  {
    "agentModel": "claude-sonnet-4-6",
    "maxCostUsd": 10.00,
    "maxIterations": 30,
    "convergenceThreshold": 2
  }

Config resolution: CLI flags > env vars (RALPH_MAX_COST_USD, etc.) > .ralphxrc > defaults.

## PROMPT.md

Instructions the agent reads at the start of each iteration. Example:

  # Codebase Audit

  You are auditing this codebase. For each acceptance criterion,
  investigate and reach a verdict: no issue, real issue, or known
  tradeoff. Fix real issues directly. Run tests after any edit.

  ## What to fix
  - Wrong logic, incorrect return values, missing error paths
  - Docs that don't match the code
  - Dead code (unused imports, unreachable branches)

  ## What NOT to fix
  - Style preferences or formatting
  - Adding comments to working code
  - Theoretical concerns that aren't problems in practice

## AGENT.md

Repo-specific guidance the agent reads once. Example:

  # Agent Instructions
  - TypeScript strict mode, ESM
  - Tests: npm test (vitest)
  - Type check: npx tsc --noEmit
  - Build: npm run build
  - Smallest change that solves the problem

## Commands

  ralphx run <workspace>                     Start the loop
  ralphx run <workspace> --max-cost 5.00     With budget cap
  ralphx run <workspace> --verbose           Show progress
  ralphx run <workspace> --resume <runId>    Resume paused run
  ralphx status <workspace>                  Latest run status
  ralphx status <workspace> --json          Run state as JSON
  ralphx cost <workspace>                    Token usage and cost
  ralphx cost <workspace> --json            Cost data as JSON
  ralphx logs <workspace>                    Loop log output
  ralphx diff <workspace>                    Show what the loop changed
  ralphx diff <workspace> --stat            File summary only
  ralphx dry-run <workspace>                 Preview config and validate PRD
  ralphx dry-run <workspace> --json         Config + validation as JSON
  ralphx import <file> <workspace>           Generate prd.json from markdown
  ralphx hint <workspace> "msg" --run <id>   Inject hint for next iteration
  ralphx pause <workspace> --run <id>        Request loop to pause

## Loop Modes

  convergent (default)   Re-run ALL active stories each round. Converges
                         when N consecutive rounds produce zero changes and
                         all gates pass. Best for audits and verification.

  backlog                Only run FAILING stories. Stops when all pass.
                         Best for feature work and bug fixes.

## How the Loop Works

1. Each round, the agent works through stories sequentially.
2. Quality gates (typecheck, test, lint) run once at end of round.
3. If gates pass and no story changed state, that's a "clean round."
4. Convergence = N consecutive clean rounds (convergenceThreshold).
5. Protected paths are included in the agent prompt and checked as
   warnings (not failures) at loop exit.

## Exit Codes and Run State

Exit code 0 = converged. Exit code 1 = anything else.

The run state file at .ralphx/<workspace>/runs/<id>/run-state.json
contains the full result. Key fields:

  status           "running", "complete", "paused", "interrupted", "crashed"
  exitReason       "converged", "no_progress", "max_iterations",
                   "budget_exceeded", "circuit_breaker_terminal", "interrupted"
  iteration        Total iterations completed
  round            Total rounds completed
  cost.estimatedCostUsd   Estimated total cost

To check programmatically:

  ralphx status audit --json | jq '.exitReason'
  ralphx cost audit --json | jq '.cost.estimatedCostUsd'
  ralphx dry-run audit --json | jq '.valid'
`;

export function printAgentHelp(): void {
  process.stdout.write(AGENT_HELP.trimStart());
}
