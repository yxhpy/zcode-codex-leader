# zcode-codex-leader

> Force ZCode/Codex into **leader-only mode**. It orchestrates; a resident **codex app-server worker** does all the substantive work — code generation, code parsing, visual understanding, image generation, and MCP tool calls — with sub-second handshake and no CLI cold-start.

A Codex/ZCode plugin that turns the agent into a pure owner/leader. A `PreToolUse` hook **physically blocks** direct edits and write commands; the only legal implementation channel is `codex_bridge.ts`, which dispatches to a session-resident `codex app-server` worker. A `Stop` hook enforces a `Plugin evidence:` line before completion is allowed.

## Why

Calling `codex` as a CLI per task is slow (tens of seconds of cold start each time) and lets the leader silently "do it itself" instead of orchestrating. This plugin solves both:

- **Speed**: one resident `codex app-server` worker stays up for the whole session. Handshake ~17ms; every dispatch reuses it.
- **Discipline**: the leader literally cannot edit files or run write commands — the gate blocks them. The only way to produce code/images is to dispatch a bounded packet to the worker and then verify the result.

## What the worker can do (all verified)

| Capability | Bridge command | How it works |
|------------|----------------|--------------|
| Bridge-controlled implementation | `auto --request-file <file>` | One compact ZCode call; Codex implements/tests/reviews and writes structured result JSON to an artifact |
| Code generation / parsing | `ask <prompt>` | `turn/start` with text input; optional `--output-schema` constrains structured output; stdout is compact by default (`RESULT_FILE` + summary) |
| Code grounded in an image | `ask <prompt> --image <path>` | `turn/start` with `localImage` + text input |
| Visual understanding | `vision <image-path> <question>` | `turn/start` with `localImage` (detail: high) + question |
| Image generation | `generate-image <prompt> [--out <path>]` | `turn/start`; captures `imageGeneration` item, saves base64 PNG |
| Test execution (sandboxed/model-assisted) | `test <prompt> [-- <cmd>] [--browser]` | One-shot worker with workspace-write sandbox (+optional browser); runs tests in isolation |
| Deterministic local command | `exec -- <cmd>` | Direct build/test/install/git/cache/deploy runner, no LLM tokens; full logs go to `RESULT_FILE` |
| MCP tool direct call | `mcp-tool <server> <tool> [--args <json>]` | `mcpServer/tool/call` (bypasses a turn) |

Measured on a MacBook (gpt-5.5): handshake 17ms, code turn ~11s, vision ~11s, image generation ~21s, producing a real 1254×1254 PNG. To protect ZCode main-token usage, substantive bridge commands now write full output to artifacts and print only `RESULT_FILE:<path>`, a <=120-word `SUMMARY:`, and `Plugin evidence:` by default (`--print-full` is debug-only).
Resilience (0.5.0): resident thread reuse (no per-dispatch cold start), wedge watchdog (90s post-tool quiet -> interrupt, vs old 5min blind wait), OAuth failure classification.
Worker lifecycle hardening (0.6.0): closes the dual-process blind spot where a half-dead worker (node launcher pid A dead, codex binary pid B still serving WS) was reused and hung `turn/start` for the full 120s RPC ceiling. Now `ensureServer` pre-checks pid A liveness before trusting the WS, RPC timeouts are per-method (turn/start 12s, default 60s), a `turn/start` timeout raises `WorkerStaleError` which `runTurn` turns into an automatic kill + restart + single retry (turn done turns a hard 120s hang into ~5s self-heal). Orphaned workers from crashed sessions are reaped on `SessionStart` and on every reconnect via a ppid-chain fingerprint match. Turn completion switched from `while()+sleep()` polling to event-driven (`turn/completed` / WS close / post-tool-quiet / parent-pid-gone / ceiling, first wins), mirroring the official codex-plugin-cc `captureTurn` model.
Approval-hang fix (0.6.1): the resident worker previously inherited codex's default approval policy, so any dispatch that ran a dangerous shell op (`rm`, `mv`, network) blocked forever in app-server mode — there is no TTY and no human to answer the approval prompt, so `turn/start` hung until the RPC ceiling and the whole dispatch timed out. This is the actual root cause behind the "second turn hangs" reports: the first turn (e.g. a probe) returned text-only, but any follow-up that touched the filesystem with a destructive command wedged. Now `workerArgs` passes `approval_policy=never` + `sandbox_mode=workspace-write` explicitly via `-c`, which is required because codex has a known bug ([openai/codex#27617](https://github.com/openai/codex/issues/27617)) where `approval_policy` in `config.toml` is ignored unless set on the command line. Verified: `rm -f probe.txt` + `apply_patch ADD` now returns DONE in ~10s instead of hanging.

## DAG run management (0.8.0)

The bridge now supports persistent, resumable DAG-based task runs. A run decomposes a request into bounded packets with explicit dependencies; state is durably persisted to SQLite, so an interrupted run can be resumed in a later session.

| Command | What it does |
|---------|--------------|
| `plan <request-file>` | Generate a candidate DAG plan via a read-only planner packet |
| `run --plan <plan.json>` | Execute an approved DAG plan to completion (SLW join point) |
| `run --run <run_id>` / `resume --run <run_id>` | Resume an interrupted run |
| `status --run <run_id> [--json]` | Query run state from the SQLite store |

State lives in `/runs.sqlite` alongside `session.json`. The packet state machine (`planned → ready → dispatched → accepted/rejected/stale`) uses optimistic CAS transitions; dependency failures cascade `stale` to downstream packets. Evidence is recorded per-packet and aggregated into a ledger hash that the Stop hook verifies against the DB — closing the forgery hole where the leader could previously emit a fabricated `Plugin evidence:` line.

Worker lifecycle is now epoch-aware: each resident worker restart increments `workerEpoch` and enforces a windowed restart budget (3 restarts per 10 minutes, exponential backoff) to prevent crash loops. Late-arriving output from a superseded epoch is rejected.

Run `node --experimental-strip-types scripts/run_store.ts` for a built-in self-check, or `node --experimental-strip-types scripts/chaos_test.ts` for the full fault-tolerance suite (CAS conflicts, stale cascades, resume-after-crash, ledger tamper detection, deadlock handling, priority ordering).

## Model tier routing (0.5.0)

The bridge routes each dispatch to the right model instead of one-model-fits-all:

| Tier | Model | Effort | Use for |
|------|-------|--------|----------|
| `fast` | gpt-5.4-mini | low | Parsing, explorer, simple Q&A, summaries |
| `balanced` (default) | gpt-5.5 | medium | Regular codegen |
| `strong` | gpt-5.5 | high | Code review, debugging, complex refactor |

Pass `--tier` to force, `--task-kind` to infer, or `--model`/`--effort` for full manual control. This aligns with codex native subagent conventions.

## Install

Requires: `codex` CLI (v0.141.0+) on PATH or at `~/.hermes/node/bin/codex`, and Node.js 22+ (for native `WebSocket` and `--experimental-strip-types`).

This plugin works on **both Codex and ZCode** — they share the same hook format (`SessionStart` / `PreToolUse` / `UserPromptSubmit` / `Stop`) and the same hook execution contract (`additionalContext`, `revisedPrompt`, exit-code-2 blocking). The plugin ships both `.codex-plugin/plugin.json` and `.zcode-plugin/plugin.json` manifests. ZCode auto-discovers `hooks/hooks.json`; the ZCode manifest intentionally does not declare a `hooks` field to avoid duplicate-hook validation errors.

### Install on Codex

```bash
# Add this repo as a marketplace
codex plugin marketplace add https://github.com/yxhpy/zcode-codex-leader

# Install the plugin
codex plugin add zcode-codex-leader@zcode-codex-leader
```

### Install on ZCode

ZCode 0.14.8 lists and loads plugins only from the `zcode-plugins-official` marketplace namespace — the `local` namespace is NOT shown by `zcode plugins list` and will not load. The installer manages the official namespace for you: it copies the plugin into the official cache, strips the Codex-only `.codex-plugin` manifest from the ZCode cache copy, registers a `source: "filesystem"` marketplace entry, enables `zcode-codex-leader@zcode-plugins-official`, and removes any stale copy of this plugin from the `local` namespace.

```bash
git clone https://github.com/yxhpy/zcode-codex-leader /tmp/zcl
cd /tmp/zcl
node scripts/install-zcode.mjs
```

Restart ZCode (or start a new session) so the hooks take effect.

### Upgrading

**ZCode** — pull the new release and re-run the installer. It is idempotent and safe to re-run: it removes older cache version directories for this plugin (keeping only the new version), updates the marketplace entry to point at the new version's cache path, and re-enables the plugin.

```bash
cd /tmp/zcl                 # your clone of this repo
git pull
node scripts/install-zcode.mjs
```

Then restart ZCode.

> Do **not** manually copy the plugin into a new version-numbered directory. Manual copy-based upgrades leave stale sibling directories (e.g. an old `0.3.0/` next to the new `0.4.0/`), and ZCode reports `plugin_duplicate_id` when the same plugin id appears in more than one cache directory. The installer cleans those up for you.

**Codex** — remove and re-add the plugin so Codex re-reads the current manifest:

```bash
codex plugin remove zcode-codex-leader@zcode-codex-leader
codex plugin add zcode-codex-leader@zcode-codex-leader
```

> `codex plugin marketplace upgrade` only works for Git-type marketplaces. The default marketplace registration for this repo is local (filesystem), so to upgrade you remove the installed plugin and re-add it; Codex re-reads the current `.codex-plugin/plugin.json` from the marketplace source directory on re-add. If you registered the marketplace as a Git source instead, use `codex plugin marketplace upgrade zcode-codex-leader` then `codex plugin add zcode-codex-leader@zcode-codex-leader`.

### Troubleshooting: duplicate plugin id

`plugin_duplicate_id · zcode-codex-leader@zcode-plugins-official` means ZCode found the same plugin id in more than one cache directory — typically an old version directory left behind by a manual copy-based upgrade. Fix it by re-running the installer, which removes all older version directories for this plugin:

```bash
cd /tmp/zcl
git pull
node scripts/install-zcode.mjs
```

If you previously installed into the `local` namespace (which ZCode 0.14.8 does not load), the installer removes that legacy copy automatically. Pass `--keep-local` only if you intentionally want to preserve it.

After install, the next Codex/ZCode session automatically:
1. Injects the leader constitution into context (`SessionStart`).
2. Starts a resident app-server worker.
3. Hard-blocks direct edits/writes (`PreToolUse`).
4. Annotates each prompt with a leader reminder (`UserPromptSubmit`).
5. Refuses completion without `Plugin evidence:` when work was dispatched (`Stop`).

> Note: ZCode loads plugins at app startup. If ZCode is already running, restart it (or start a new session) so the newly enabled plugin's hooks take effect.

## How the leader works

Once installed, ZCode operates in a strict dispatch loop:

1. **Decompose** the request into bounded packets (objective, allowed paths, do/do-not, evidence, stop condition).
2. **Dispatch** via `codex_bridge.ts` (prefer one compact `auto` call for normal implementation):
   ```bash
   node --experimental-strip-types "$PLUGIN_ROOT/scripts/codex_bridge.ts" auto --request-file /tmp/request.md
   # or a lower-level packet:
   node --experimental-strip-types "$PLUGIN_ROOT/scripts/codex_bridge.ts" ask "write a Python merge sort"
   ```
3. **Use deterministic `exec` for commands** like build/test/install/git/cache when no model reasoning is needed; use `--external --approved` only after user approval for deploy/push/paid/external side effects.
4. **Use GPT-Pro background tasks for long Pro work**: `gpt-pro start ask ...` returns `TASK_ID`/`TASK_FILE`/`RESULT_FILE`, then `gpt-pro poll` / `gpt-pro collect` / `gpt-pro cancel` synchronize without blocking on the Bash 600s ceiling.
5. **Ingest & judge** each compact result — accept, reject, or mark stale. Read the `RESULT_FILE` artifact only when needed for verification.
6. **Verify** the final state with read-only checks.
7. **Report** with a `Plugin evidence:` line per dispatched capability (copied from the bridge output).

Trying to `Edit`/`Write`/`rm`/`git commit` directly hits the gate:
```
[Leader Gate] Edit is blocked. ZCode must not edit or write files directly.
Dispatch the work to the codex app-server worker via codex_bridge.ts instead.
```

## Repository layout

```
zcode-codex-leader/
├── catalog.json                          # marketplace catalog
├── .agents/plugins/marketplace.json      # marketplace metadata
├── plugins/zcode-codex-leader/
│   ├── .codex-plugin/plugin.json         # plugin manifest
│   ├── hooks/hooks.json                  # 4 hook event registrations
│   ├── scripts/
│   │   ├── leader_hook.ts                # hook entry (session-start/pre-tool-use/user-prompt-submit/stop)
│   │   ├── codex_bridge.ts               # dispatch channel (auto/ask/exec/gpt-pro/vision/generate-image/mcp-tool)
│   │   ├── app_server_pool.ts            # resident worker management (ws transport)
│   │   └── constitution.ts               # leader constitution text
│   └── skills/codex-leader/SKILL.md      # usage skill auto-loaded by the agent
└── docs/architecture.md                  # design + contracts
```

## Configuration

State lives in `$PLUGIN_DATA` (default `~/.codex/zcode-codex-leader-data/`):
- `session.json` — resident worker pid, WebSocket URL, dispatch count.
- `gen-<ts>.png` — generated images (unless `--out` is given).
- `gpt-pro/tasks/<task-id>.json` — durable GPT-Pro background task metadata.
- `gpt-pro/results/<task-id>.txt` — GPT-Pro full/partial answer artifacts.
- `gpt-pro/logs/<task-id>.log` — detached GPT-Pro worker stdout/stderr logs.

To force-restart the worker: delete `session.json` (or kill the `codex app-server --listen ws://127.0.0.1:0` process); it self-heals on the next dispatch.

## Disabling

Uninstall the plugin:
```bash
codex plugin remove zcode-codex-leader
```
Or remove the marketplace:
```bash
codex plugin marketplace remove zcode-codex-leader
```

## License

MIT
