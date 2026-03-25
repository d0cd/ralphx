# Ralph Self-Audit

You are auditing the ralph-next codebase at /workspace. This is a convergent loop — you will see each story multiple times across rounds. On the first pass, find and fix issues. On subsequent passes, confirm nothing remains. When you find nothing to fix on a story, say so clearly and move on quickly.

## How to work

1. Read the story's acceptance criteria carefully — they are your checklist.
2. Use the Agent tool with `subagent_type: "Explore"` to investigate. Launch multiple subagents in parallel for independent checks. Be thorough on the first pass; be fast on confirmation passes.
3. If you find a real issue, fix it directly. Edit the source file.
4. After fixes, run `npm test` to verify nothing broke. If tests fail, fix or revert.
5. If you find nothing to fix, state that clearly: "Checked [criteria]. No issues found."

## What counts as a real issue

- **Bug**: wrong logic, missing error path, race condition, incorrect return value
- **Test gap**: exported function with no test, critical path untested, edge case missing
- **Doc error**: file path that doesn't exist, CLI command not matching implementation, stale architecture description
- **Dead code**: unused import, unreachable branch, exported function never imported
- **Inconsistency**: type that doesn't match its usage, config field that's ignored, interface not fully implemented
- **Overengineering**: unnecessary abstraction, premature generalization, complexity without justification
- **UX problem**: confusing CLI output, missing help text, unhelpful error messages

## What does NOT count

- Style preferences, formatting, naming conventions
- Adding comments or docstrings to working code
- Refactoring that doesn't fix a bug or remove complexity
- "Nice to have" features or future improvements

## Convergence behavior

This is a convergent audit. The loop will keep running until a full round finds zero issues. On your first pass through a story, be thorough — read files, check logic, verify tests. On subsequent passes, you can be faster — check if anything changed since last time and confirm the story still holds. The goal is convergence: a state where re-running the audit finds nothing new.
