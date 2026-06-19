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
   │ (4 hook events)     │                          │ (4 dispatch commands) │
   ├─────────────────────┤                          ├───────────────────────┤
   │ session-start:      │                          │ ask                   │
   │  inject constitution│                          │ vision                │
   │  + ensureServer     │                          │ generate-image        │
   │ pre-tool-use:       │                          │ mcp-tool              │
   │  block writes,      │                          │ (each bumps           │
   │  allow reads+bridge │                          │  dispatchCount,       │
   │ user-prompt-submit: │                          │  prints evidence line)│
   │  append reminder    │                          └───────────────────────┘
   │ stop:               │
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

## Failure modes

- **Worker dead on arrival / crashed**: `ensureServer` probes via WebSocket+initialize; on failure it clears `session.json` and starts a fresh worker. The bridge does this lazily on every call, so a dead worker self-heals.
- **Worker can't bind a port**: `startWorker` rejects after 8s; the hook logs a non-fatal warning and lets the bridge try again on first dispatch.
- **Turn hangs**: `runTurn` has a 5-min ceiling; beyond that it returns whatever was collected.
- **No image generation item returned**: `generate-image` exits 2 with the worker's text output on stderr, so the leader can react.
