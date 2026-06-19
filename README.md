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
| Code generation / parsing | `ask <prompt>` | `turn/start` with text input; optional `--output-schema` constrains structured output |
| Code grounded in an image | `ask <prompt> --image <path>` | `turn/start` with `localImage` + text input |
| Visual understanding | `vision <image-path> <question>` | `turn/start` with `localImage` (detail: high) + question |
| Image generation | `generate-image <prompt> [--out <path>]` | `turn/start`; captures `imageGeneration` item, saves base64 PNG |
| MCP tool direct call | `mcp-tool <server> <tool> [--args <json>]` | `mcpServer/tool/call` (bypasses a turn) |

Measured on a MacBook (gpt-5.5): handshake 17ms, code turn ~11s, vision ~11s, image generation ~21s, producing a real 1254×1254 PNG.

## Install

Requires: `codex` CLI (v0.141.0+) on PATH or at `~/.hermes/node/bin/codex`, and Node.js 22+ (for native `WebSocket` and `--experimental-strip-types`).

This plugin works on **both Codex and ZCode** — they share the same hook format (`SessionStart` / `PreToolUse` / `UserPromptSubmit` / `Stop`) and the same hook execution contract (`additionalContext`, `revisedPrompt`, exit-code-2 blocking). The plugin ships both `.codex-plugin/plugin.json` and `.zcode-plugin/plugin.json` manifests.

### Install on Codex

```bash
# Add this repo as a marketplace
codex plugin marketplace add https://github.com/yxhpy/zcode-codex-leader

# Install the plugin
codex plugin add zcode-codex-leader@zcode-codex-leader
```

### Install on ZCode

ZCode has no `marketplace add` command, so installation is a manual copy + register:

```bash
# 1. Clone the plugin into ZCode's plugin cache
ZCACHE="$HOME/.zcode/cli/plugins/cache/zcode-plugins-official/zcode-codex-leader/0.4.0"
mkdir -p "$ZCACHE"
git clone https://github.com/yxhpy/zcode-codex-leader /tmp/zcl
cp -R /tmp/zcl/plugins/zcode-codex-leader/. "$ZCACHE"/

# 2. Strip the Codex-only manifest. ZCode reads both .zcode-plugin and
#    .codex-plugin, and the .zcode-plugin manifest intentionally omits the
#    "hooks" field (ZCode auto-scans hooks/hooks.json; declaring it would
#    trigger "Duplicate plugin hooks file ignored"). Removing .codex-plugin
#    avoids any cross-product confusion. Codex install uses .codex-plugin
#    and is unaffected since this copy is ZCode-only.
rm -rf "$ZCACHE/.codex-plugin"

# 3. Register it in the official marketplace manifest
node -e '
const fs=require("fs"),p=process.env.HOME+"/.zcode/cli/plugins/marketplaces/zcode-plugins-official/marketplace.json";
const d=JSON.parse(fs.readFileSync(p,"utf8"));
const e={cachePath:process.env.HOME+"/.zcode/cli/plugins/cache/zcode-plugins-official/zcode-codex-leader/0.4.0",name:"zcode-codex-leader",source:"filesystem",version:"0.4.0"};
d.plugins=[...d.plugins.filter(x=>x.name!=="zcode-codex-leader"),e];
fs.writeFileSync(p,JSON.stringify(d,null,2));
'

# 4. Enable it
zcode plugins enable zcode-codex-leader
# (if `zcode` is not on PATH, invoke the CLI directly:
#  node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs plugins enable zcode-codex-leader)
```

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
2. **Dispatch** each packet via `codex_bridge.ts`:
   ```bash
   node --experimental-strip-types "$PLUGIN_ROOT/scripts/codex_bridge.ts" ask "write a Python merge sort"
   ```
3. **Ingest & judge** each result — accept, reject, or mark stale.
4. **Verify** the final state with read-only checks.
5. **Report** with a `Plugin evidence:` line per dispatched capability (copied from the bridge output).

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
│   │   ├── codex_bridge.ts               # dispatch channel (ask/vision/generate-image/mcp-tool)
│   │   ├── app_server_pool.ts            # resident worker management (ws transport)
│   │   └── constitution.ts               # leader constitution text
│   └── skills/codex-leader/SKILL.md      # usage skill auto-loaded by the agent
└── docs/architecture.md                  # design + contracts
```

## Configuration

State lives in `$PLUGIN_DATA` (default `~/.codex/zcode-codex-leader-data/`):
- `session.json` — resident worker pid, WebSocket URL, dispatch count.
- `gen-<ts>.png` — generated images (unless `--out` is given).

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
