# Changelog

## 0.1.0 (2026-03-25)

Initial release.

### Features

- **Convergent coding loop** — runs AI agent iterations until all stories pass quality gates or no progress is made
- **Workspace isolation** — multiple independent loops on the same repo via `ralphx init <workspace>`
- **Budget guardrails** — max iterations, max cost (USD), and timeout limits
- **Circuit breaker** — skips stories that fail repeatedly
- **Resumable runs** — pause and resume loops with full state preservation
- **Hint injection** — send guidance to a running loop mid-flight
- **PRD import** — parse markdown requirements into structured `prd.json`
- **Workflow templates** — save and reuse workspace configurations across projects
- **Progress reporting** — markdown progress output and structured logging
- **Protected paths** — prevent the agent from modifying sensitive files
- **Atomic state writes** — durable run state via temp+rename

### Supported Agents

- Claude Code (via `@anthropic-ai/claude-agent-sdk`)
