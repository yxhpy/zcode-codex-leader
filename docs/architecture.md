# Architecture

## Goal

Make ZCode/Codex a pure **leader/owner** that never does substantive implementation itself. All code generation, code parsing, visual understanding, image generation, and MCP tool work is dispatched to a **resident codex app-server worker**. The CLI cold-start (tens of seconds per call) is eliminated by keeping one worker process alive for the whole session.

## Components

```
                       ┌─────────────────────────────────────────┐
                       │  codex app-server worker (resident)     │
                       │  --listen ws://127.0.0.1:0 (loopback)   │
                       │  detached, survives across hook calls   │
                       └───────────────▲─────────────────────────┘
                                       │ WebSocket (newline-free JSON-RPC frames)
                       ┌───────────────┴───────────────┐
                       │  app_server_pool.ts           │
                       │  ensureServer / runTurn /     │
                       │  callMcpTool / bumpDispatch   │
                       └───────▲───────────────▲───────┘
                               │               │
              ┌────────────────┘               └────────────────┐
              │                                                 │
   ┌──────────┴──────────┐                          ┌────────────┴──────────┐
   │ leader_hook.ts      │                          │ codex_bridge.ts       │
   │ (4 hook events)     │                          │ (compact dispatch)    │
   ├─────────────────────┤                          ├───────────────────────┤
   │ session-start:      │                          │ auto                  │
   │  inject constitution│                          │ ask / ask-file        │
   │  + ensureServer     │                          │ parse / web / vision  │
   │ watchdog:           │                          │ generate-image        │
   │  keep worker alive  │                          │ test / exec / mcp-tool│
   │ pre-tool-use:       │                          │ agy / gpt-pro         │
   │  block writes,      │                          │ (gpt-pro supports     │
   │  allow reads+bridge │                          │  start/poll/collect/  │
   │ user-prompt-submit: │                          │  cancel; compact      │
   │  append reminder    │                          │  output + evidence)  │
   │ stop:               │                          └───────────────────────┘
   │  evidence gate      │
   └─────────────────────┘
```

## Transport choice

The worker listens on `ws://127.0.0.1:0` (loopback, OS-assigned port). The actual URL is parsed from the worker's stderr (`listening on: ws://127.0.0.1:PORT`) and persisted to `session.json`. Clients (hooks and the bridge) connect over WebSocket per call.

Why WebSocket over stdio/unix-socket:
- **Multi-client**: hooks and the bridge are separate short-lived processes; they all connect to the same resident worker.
- **Process decoupling**: the worker is `detached` + `unref`'d, so it survives the SessionStart hook that launched it. stdio would tie it to one parent's pipes.
- **Cross-platform**: loopback WebSocket works on macOS, Linux, and Windows without socket-path quirks.
- **Verified**: handshake ~17ms; `imageGeneration`, `webSearch`, `namespaceTools` capabilities all returned correctly.

WebSocket frames are **whole JSON-RPC messages** (not newline-delimited like stdio). The client splits on `\n` as a tolerance for occasional batches, but each frame is normally one complete message.

## Hook contracts (confirmed against the codex binary)

| Event | stdin (snake_case) | Block mechanism | Inject mechanism |
|-------|--------------------|-----------------|------------------|
| `SessionStart` | `cwd`, `source`, `session_id` | — | `hookSpecificOutput.additionalContext` |
| `PreToolUse` | `tool_name`, `tool_input` | exit 2 + stderr reason | — |
| `UserPromptSubmit` | `prompt` | exit 2 + stderr | `hookSpecificOutput.revisedPrompt` |
| `Stop` | `last_assistant_message` | exit 2 + stderr | — |

Exit codes: `0` = success/allow; `2` = block (stderr must carry the reason); other non-zero = error. `suppressOutput:true` keeps hook stdout out of the user's view.

Environment: `${PLUGIN_ROOT}` (and `${CLAUDE_PLUGIN_ROOT}` alias) is the installed plugin dir; `${PLUGIN_DATA}` is a per-plugin writable state dir (fallback `~/.codex/zcode-codex-leader-data`).

## Enforcement model

**Hard enforcement** (can't be bypassed by prompt):
- PreToolUse gate physically blocks `Edit`/`Write`/`NotebookEdit` and write-class `Bash`. The only write/produce path is `codex_bridge.ts`.
- Stop gate refuses completion (exit 2) when `dispatchCount > 0` and the final message has no `Plugin evidence:` line.

**Soft enforcement** (prompt-level, reinforces the hard layer):
- SessionStart injects the leader constitution into context.
- UserPromptSubmit appends a leader reminder to each prompt.

## Session state

`session.json` (in `PLUGIN_DATA`) holds: `pid`, `wsUrl`, `healthUrl`, `startedAt`, `dispatchCount`. Threads are **per-dispatch ephemeral** (not reused across calls) — reusing a long-lived thread was observed to leave turns without a `turn/completed` notification. ZCode (the leader) holds cross-packet context itself, so per-dispatch threads match the bounded-packet model.

## GPT-Pro background tasks (0.8.7+)

`gpt-pro start ask/continue` creates a detached worker process with its own task file under `PLUGIN_DATA/gpt-pro/tasks/<task-id>.json`, result artifact under `PLUGIN_DATA/gpt-pro/results/<task-id>.txt`, and log under `PLUGIN_DATA/gpt-pro/logs/<task-id>.log`. The start call returns immediately with `TASK_ID`, `TASK_FILE`, `RESULT_FILE`, `POLL_CMD`, `COLLECT_CMD`, and `CANCEL_CMD`; later foreground `poll`/`collect`/`cancel` calls read or update the durable task file. This is the explicit exception to same-turn synchronous waiting, added because ChatGPT Pro generations can exceed the ZCode Bash 600s ceiling.

Legacy foreground `gpt-pro ask/continue` still exists for short/manual use, but long Pro work should use start/poll/collect.

## Model tier routing (0.5.0)

The bridge picks a model per dispatch instead of one-model-fits-all. Tiers are defined in `MODEL_TIERS` in app_server_pool.ts:

| Tier | Model | Effort | service_tier | Use for |
|------|-------|--------|--------------|---------|
| fast | gpt-5.4-mini | low | fast | parsing, explorer, Q&A, summaries |
| balanced (default) | gpt-5.5 | medium | default | regular codegen |
| strong | gpt-5.5 | high | default | review, debug, complex refactor |

Selection priority: explicit `--model`/`--effort` > `--tier` > `--task-kind` inference > balanced. This mirrors codex's native subagent conventions (e.g. `~/.codex/agents/explorer.toml` uses gpt-5.4-mini/fast while `code-reviewer.toml` uses gpt-5.5/high).

## Watchdog and resilience (0.5.0)

Three reliability improvements over 0.4.x:

1. **Thread reuse**: the resident worker now keeps ONE non-ephemeral thread across dispatches (cached in session.json.threadId), eliminating per-dispatch thread/start cold start. Self-heals if codex reports the thread missing. Set `FORCE_EPHEMERAL_THREAD=1` to revert to the old ephemeral behavior.

2. **Wedge watchdog**: replaces the 50ms spin loop with tiered timeouts:
   - 250ms poll interval (was 50ms - less CPU spin)
   - 90s post-tool quiet timeout (if a tool completes and codex goes silent for 90s, issue turn/interrupt and retire the thread)
   - 300s hard turn ceiling (unchanged)
   - subprocess liveness check each iteration (dead worker -> immediate partial return)

3. **OAuth failure classification**: JSON-RPC errors and stderr are scanned for token-refresh failure patterns (invalid_grant, refresh token, token has expired, 401 unauthorized, etc.). On match, the user gets a clear "Run `codex login`" hint instead of a raw RPC error. Mirrors hermes-agent's `_classify_oauth_failure`.

## Gate improvements (0.5.0)

The PreToolUse Bash gate was too strict (blocked `codex --version`, `readlink`, `file`, `test`). Now:
- **Expanded allowlist**: read-only inspection commands (version queries for node/python/go/rustc/swift/make/docker/codex, readlink, file, test, uname, git config --get, npm ls/view, etc.) are allowed directly.
- **Dangerous-op blacklist**: a backstop regex catches write/destructive ops (rm -rf, git commit/push/merge, npm install, curl -X POST, chmod, sudo, kill -9, etc.) even if they start with an allowlisted word. Checked BEFORE the allowlist.
- Order: bridge path -> dangerous blacklist -> readonly allowlist -> block.

## Failure modes

- **Worker dead on arrival / crashed**: `ensureServer` probes via WebSocket+initialize; on failure it clears `session.json` and starts a fresh worker. The bridge does this lazily on every call, so a dead worker self-heals.
- **Worker can't bind a port**: `startWorker` rejects after 8s; the hook logs a non-fatal warning and lets the bridge try again on first dispatch.
- **Turn hangs**: `runTurn` has a 5-min ceiling; beyond that it returns whatever was collected.
- **No image generation item returned**: `generate-image` exits 2 with the worker's text output on stderr, so the leader can react.
