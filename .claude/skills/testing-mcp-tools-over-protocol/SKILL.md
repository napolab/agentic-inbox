---
name: testing-mcp-tools-over-protocol
description: Use when a change touches the inbox MCP server (workers/mcp/index.ts, workers/lib/tools.ts, or anything an MCP tool calls), when asked to "MCP のテスト" / test or verify an MCP tool, or when about to conclude the MCP layer is untestable because EmailMCP extends McpAgent / needs the Workers runtime or because `pnpm dev` is broken.
---

# Testing MCP Tools Over the Protocol

## Overview

`EmailMCP` **is** testable in Node. Only `agents/mcp` (which imports `cloudflare:workers`) needs stubbing. This harness then drives the real tool registrations, real zod schemas and real MCP SDK via `tools/list` / `tools/call` over an in-memory transport, with fake Cloudflare bindings recording every side effect.

Calling `toolSendEmail()` directly is **not** an MCP test: it skips the zod input schema, and the SDK's zod silently strips unknown arguments. Before PR #14, `send_email` accepted `attachments` and sent mail without them — invisible to function-level tests.

## Procedure (every MCP change)

1. **Add or extend a test** in `tests/<feature>.test.mts` (keep them — the folder is the regression suite). Cover:
   - `tools/list`: the new/changed parameter's JSON Schema (type, required/optional).
   - `tools/call` happy path: assert side effects via `log.sent` / `log.r2` / `callsTo("createEmail")`.
   - Rejects: `isError === true`, recovery hint text, **and no side effects**.
   - The unchanged path still works (backward compatibility).
2. **Run with a control** (a temporary detached worktree of the ref, removed on exit):
   ```bash
   git fetch origin main
   bash .claude/skills/testing-mcp-tools-over-protocol/run.sh --control origin/main
   ```
3. **Read both runs.** Working tree: all pass. Control, per test:
   - Test of **new behavior** (the thing this change adds or fixes) → must FAIL on control. If it passes, it isn't exercising the change — fix the test.
   - **Regression guard** of behavior the base already has (ordering, no side effects on error) → passing on control is expected; say so in the report.
4. **Report** protocol-level results, plus what stays unverified: real `EMAIL` binding / MIME delivery, Cloudflare Access + OAuth, deployed server (verify after merge + deploy).

## Harness quick reference (`harness/setup.mts`)

| API | Purpose |
|---|---|
| `setup({ emails, stub, ai, env })` | Connected client; `emails` feed fake DO `getEmail` (default none → "not found") |
| `call(name, args)` | `{ isError, text, json }` |
| `client.listTools()` | Raw `tools/list` |
| `log.sent` / `log.r2` / `log.calls` | `EMAIL.send` messages, `BUCKET.put` `[key, bytes]`, DO `[method, args]` |
| `callsTo("createEmail")` | Argument lists for one DO method |
| `MAILBOX`, `b64(str)`, `repoImport(rel)` | Valid mailbox, base64 helper, import from repo under test |

Fake DO throws `"<method>" is not mocked` for unmocked methods — add it via `setup({ stub: { method } })`. `env.AI.run` throws by default. MCP send/draft paths never call it (bodies go out verbatim); pass `ai` to simulate the verifier when testing that they stay untouched.

## Common mistakes

| Mistake | Fix |
|---|---|
| "McpAgent needs the Workers runtime, so skip the MCP layer" | `run.sh` loads the stub via `harness/register.mjs` |
| Testing only `workers/lib/tools.ts` functions | Go through `call()` so zod + wiring run |
| No control run | Always `--control origin/main` (or the PR base) |
| Writing the test in scratchpad and discarding it | Commit it under `tests/` |
| Asserting only the response | Also assert `log.*` side effects (and their absence on reject) |
