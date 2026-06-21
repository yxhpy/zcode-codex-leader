#!/usr/bin/env -S node --experimental-strip-types
// leader_hook.ts — single hook entry point. Dispatches on argv[1] (the event
// name passed from hooks.json) and reads the JSON payload from stdin.
//
// Events:
//   session-start       inject the leader constitution + ensure the worker is up
//   pre-tool-use        hard-block write tools; allow reads + codex_bridge.ts dispatch
//   user-prompt-submit  append a leader reminder to the user's prompt
//   stop                evidence gate: refuse completion without Plugin evidence

import { readFileSync } from "node:fs";
import { constitution } from "./constitution.ts";
import { readSession, stopServer, reapOrphanWorkersOnStartup } from "./app_server_pool.ts";

// Read the full stdin as a JSON object. Hooks receive a single JSON payload.
function readStdinJson(): any {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// Emit a hook output that injects `additionalContext` into the agent context.
// suppressOutput:true keeps the hook's own stdout out of the user's view.
function emitContext(additionalContext: string): void {
  process.stdout.write(JSON.stringify({
    suppressOutput: true,
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
  }) + "\n");
}

// Block: exit code 2 with a reason on stderr. This is the universal, binary-confirmed
// block mechanism for all hook events.
function block(reason: string): never {
  process.stderr.write(reason + "\n");
  process.exit(2);
}

// --- session-start ---------------------------------------------------------
function onSessionStart(): void {
  const input = readStdinJson();
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.env.PLUGIN_ROOT || process.cwd();

  // Inject the constitution into context. That is the ONLY job of this hook —
  // it must return fast (zcode/codex wait on it). The resident worker is NOT
  // started here; codex_bridge.ts starts it lazily on the first dispatch.
  // (Starting it here previously caused hook timeouts: the worker spawn +
  // WebSocket probe kept the event loop alive past the hook's timeout.)
  emitContext(constitution(pluginRoot));
  // Best-effort: reap any resident workers leaked by a previous crashed zcode
  // session. Cheap (one `ps` + a SIGKILL per orphan, ~5ms), synchronous, and
  // keeps a crash from accumulating one leaked dual-process worker per run —
  // each holds a loopback port and a ChatGPT concurrency slot.
  try { reapOrphanWorkersOnStartup(); } catch {}
  process.exit(0);
}

// --- pre-tool-use ----------------------------------------------------------
// Tool names observed in this harness: Read, Glob, Grep, Bash, Edit, Write,
// NotebookEdit, TodoWrite, WebFetch, Task/Agent. We block write-class tools and
// write-class Bash, allow everything read-only plus the bridge dispatch channel.
// Read is gated by file extension below (image/code/text-allowlist), so it is
// NOT in this blanket-allow set. WebFetch/WebSearch are blocked — web research
// is dispatched to codex_bridge.ts web.
const READONLY_TOOLS = new Set(["Glob", "Grep", "TodoWrite", "Task", "Agent"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "NotebookEditDeleteCells"]);

// Web tools: leader must not fetch the web itself. Dispatched via codex_bridge web.
const WEB_TOOLS = new Set(["WebSearch", "WebFetch"]);

// Image files that the Read tool renders visually to the model. Reading these
// is visual understanding, which the leader must dispatch to codex_bridge.ts
// vision — never ingest directly.
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tiff", "tif", "avif", "heic", "heif"]);

// Source-code files. Reading these is code understanding, which the leader
// must dispatch to codex_bridge.ts parse — never ingest directly. Covers the
// common compiled/script/markup/stylesheet languages; unusual extensions fall
// through to the text-allowlist check below.
const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "py", "pyi", "pyw",
  "go", "rs", "c", "h", "cpp", "cc", "cxx", "hpp", "hh", "hxx",
  "java", "kt", "kts", "scala", "sc",
  "cs", "rb", "php", "swift", "dart",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "sql", "graphql", "gql",
  "html", "htm", "css", "scss", "sass", "less", "styl",
  "vue", "svelte", "astro",
  "lua", "r", "jl",
  "clj", "cljs", "cljc", "elm", "hs", "lhs", "ml", "mli", "fs", "fsi", "fsx",
  "ex", "exs", "erl", "lisp", "cl", "scm",
  "zig", "nim", "v", "d",
  "asm", "s",
  "proto", "thrift",
]);

// Text/config/doc files the leader MAY Read directly (planning, results, status,
// verification of config). Anything not in CODE_EXTENSIONS/IMAGE_EXTENSIONS and
// not here is treated as non-allowlisted text and routed to parse too.
const TEXT_ALLOWLIST = new Set([
  "md", "markdown", "mdx",
  "txt", "text", "log", "logs",
  "json", "jsonc", "json5",
  "yaml", "yml",
  "toml", "ini", "cfg", "conf", "config", "properties",
  "csv", "tsv",
  "xml",
  "env", "editorconfig", "gitignore", "gitattributes", "gitmodules",
  "dockerignore", "npmignore", "prettierignore", "eslintignore",
  "lock", "map",
  "rst", "adoc", "tex", "org",
  "diff", "patch",
  "license", "licence", "authors", "contributors", "changes", "changelog", "news",
]);

// Bash commands that are effectively read-only and safe for the leader to run
// directly (context gathering, verification). Anything else in Bash must go
// through codex_bridge.ts. Tolerates absolute-path forms (/bin/cat, /usr/bin/grep)
// and leading env-var assignments (FOO=bar ls ...).
const READONLY_BASH = /^(?:[A-Z_][A-Z0-9_]*=\S+\s+)*(?:\/(?:usr\/)?bin\/)?(?:(?:ls|cat|head|tail|pwd|echo|which|file|stat|wc|grep|rg|find|fd|tree|du|df|diff|cmp|sort|uniq|cut|tr|basename|dirname|readlink|realpath|uname|env|printenv|whoami|id|hostname|date|uptime|test|\[)(?:\s+.*)?|(?:node|python3?|python|ruby|go|rustc|swift)\s+--version\b|(?:xcodebuild)\s+-version\b|(?:make)\s+(?:-n|-p|--dry-run|--print-data-base)\b|(?:docker)\s+(?:ps|version|inspect\s+--format|images)\b|(?:gh)\s+--version\b|(?:java)\s+-version\b|(?:mvn|gradle|dotnet)\b|(?:git)\s+(?:status|log|diff|show|branch|blame|remote|rev-parse|ls-files|ls-remote|describe|tag|stash\s+list|reflog)(?:\s+.*)?|(?:git)\s+config\s+--get\b|(?:npm)\s+(?:ls|view|outdated|info)\b|(?:yarn)\s+info\b|(?:pnpm)\s+list\b|(?:cargo)\s+(?:tree|metadata)\b|(?:go)\s+(?:version|list|env)\b|(?:codex)\s+(?:--version|--help|help|-h)\b)/;
const DANGEROUS_BASH = /(?:^|\s)(?:rm\s+-?\w*r|rm\s+-rf|rm\s+-fr|rmdir|mv\s+\S+\s*>|cp\s+.*>|tee\s+\S*\/|>\s*\/|>>|git\s+(?:commit|push|merge|rebase|reset|checkout|clean|stash\s+(?:drop|pop)|cherry-pick)|npm\s+(?:install|i|publish|uninstall)|yarn\s+(?:add|remove|publish)|pnpm\s+(?:add|remove|publish)|pip\s+install|pip3\s+install|cargo\s+install|brew\s+(?:install|uninstall|upgrade)|curl\s+.*-X\s*(?:POST|PUT|DELETE|PATCH)|curl\s+.*--data|wget\s+.*-O|chmod|chown|sudo|kill\s+-9|kill\s+-KILL|pkill|killall|launchctl\s+(?:load|unload|bootstrap)|defaults\s+write|mkfs|dd\s+.*of=|shutdown|reboot)\b/;

function onPreToolUse(): void {
  const input = readStdinJson();
  // Field names are snake_case on the wire (tool_name / tool_input).
  const tool: string = input.tool_name || input.toolName || "";
  const toolInput: any = input.tool_input || input.toolInput || {};
  const pluginRoot = process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
  const bridgePath = `${pluginRoot}/scripts/codex_bridge.ts`;

  // 0) Web tools: blocked. Web research is dispatched to codex_bridge.ts web.
  if (WEB_TOOLS.has(tool)) {
    const q: string = (tool === "WebSearch")
      ? (toolInput.query || toolInput.question || toolInput.prompt || "")
      : (toolInput.url || toolInput.prompt || toolInput.question || "");
    const qArg = q ? ` "${q.replace(/"/g, '\\"')}"` : "";
    block(`[Leader Gate] ${tool} is blocked. ZCode must not fetch the web directly — that is research, which is dispatched. Run: node --experimental-strip-types "${bridgePath}" web${qArg}. Reason: leader-only mode.`);
  }

  // 1) Read: gated by extension. Image→vision, code→parse, non-allowlisted→parse,
  //    allowlisted docs/config→allow. The leader stays out of images AND source
  //    code; it only reads docs/config/results it wrote or that are inert.
  if (tool === "Read") {
    const filePath: string = toolInput.file_path || toolInput.filePath || "";
    const ext = filePath.toLowerCase().split(".").pop() || "";
    if (IMAGE_EXTENSIONS.has(ext)) {
      block(`[Leader Gate] Read of image file is blocked: \`${filePath}\`. ZCode must not ingest images directly — that is visual understanding, which is dispatched. Run: node --experimental-strip-types "${bridgePath}" vision "${filePath}" "<your question>". Reason: leader-only mode.`);
    }
    if (CODE_EXTENSIONS.has(ext)) {
      block(`[Leader Gate] Read of source file is blocked: \`${filePath}\`. ZCode must not read code directly — that is code understanding, which is dispatched. Run: node --experimental-strip-types "${bridgePath}" parse "${filePath}" "<your question, or omit for a default summary>". Reason: leader-only mode.`);
    }
    if (!TEXT_ALLOWLIST.has(ext)) {
      block(`[Leader Gate] Read of \`${filePath}\` is blocked: extension \`.${ext}\` is not in the leader read-allowlist (docs/config only). If this is a text/config file, the allowlist may need extending; if it is code or a structured artifact, dispatch understanding to codex_bridge.ts parse: node --experimental-strip-types "${bridgePath}" parse "${filePath}". Reason: leader-only mode.`);
    }
    process.exit(0);
  }
  if (READONLY_TOOLS.has(tool)) process.exit(0);

  // 2) Explicitly write tools: block.
  if (WRITE_TOOLS.has(tool)) {
    block(`[Leader Gate] ${tool} is blocked. ZCode must not edit or write files directly. Dispatch the work to the codex app-server worker via codex_bridge.ts instead. Reason: leader-only mode.`);
  }

  // 3) Bash: allow only the bridge dispatch channel and read-only commands.
  if (tool === "Bash") {
    const cmd: string = typeof toolInput === "string" ? toolInput : (toolInput.command || "");
    // Allow the bridge dispatch channel (the leader's only implementation path).
    if (cmd.includes(bridgePath) || cmd.includes("codex_bridge.ts")) {
      process.exit(0);
    }
    const trimmed = cmd.trim();
    if (DANGEROUS_BASH.test(trimmed)) {
      block(`[Leader Gate] Write/destructive Bash is blocked: \`${cmd}\`. This mutates the system. Dispatch via codex_bridge.ts (ask for code changes, test for running tests). Reason: leader-only mode.`);
    }
    // Allow read-only context/verification commands.
    if (READONLY_BASH.test(trimmed)) {
      process.exit(0);
    }
    // Everything else (rm, mv, cp, npm install, git commit, curl writes, etc.): block.
    block(`[Leader Gate] Bash command not recognized as read-only: \`${cmd}\`. If it is a read-only inspection command, the allowlist may need extending. For implementation/test work, dispatch via codex_bridge.ts. Reason: leader-only mode.`);
  }

  // 4) Unknown tool: default allow (avoid breaking the harness). The constitution
  //    and the explicit blocks above carry the real enforcement.
  process.exit(0);
}

// --- user-prompt-submit ----------------------------------------------------
function onUserPromptSubmit(): void {
  const input = readStdinJson();
  const prompt: string = input.prompt || input.userPrompt || input.message || "";

  // If the prompt is already a dispatch instruction, don't double-annotate.
  if (prompt.includes("codex_bridge.ts") || prompt.includes("[Leader reminder]")) {
    process.exit(0);
  }

  const reminder = `\n\n[Leader reminder] You are the owner. Do NOT implement, edit files, or run write commands directly — reads and planning are allowed. Decompose the request into bounded packets and dispatch each to the codex app-server worker via codex_bridge.ts (ask / vision / generate-image / mcp-tool). Accept, reject, or mark each result stale after re-checking. Your final summary MUST include a "Plugin evidence:" line per dispatched capability.`;

  // Return a revised prompt (append the reminder). hookSpecificOutput.revisedPrompt
  // is the binary-confirmed rewrite field for UserPromptSubmit.
  process.stdout.write(JSON.stringify({
    suppressOutput: true,
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", revisedPrompt: prompt + reminder },
  }) + "\n");
  process.exit(0);
}

// --- stop ------------------------------------------------------------------
// Evidence gate: if work was dispatched this session (dispatchCount > 0) but the
// final assistant message has no "Plugin evidence:" line, refuse completion.
function onStop(): void {
  const input = readStdinJson();
  const lastMessage: string = input.last_assistant_message || input.lastAssistantMessage || "";
  const session = readSession();
  const dispatchCount = session?.dispatchCount || 0;

  if (dispatchCount === 0) {
    // Pure planning / Q&A session — no evidence required.
    process.exit(0);
  }

  const evidenceRe = /^[-*]?\s*plugin\s+evidence\s*:/im;
  if (evidenceRe.test(lastMessage)) {
    process.exit(0);
  }

  block(`[Evidence Gate] ${dispatchCount} dispatch(es) were performed this session but the completion summary has no "Plugin evidence:" line. Name each dispatched capability (ask / vision / generate-image / mcp-tool) with the exact command, turn id, or artifact path, then complete again. The gate refuses completion when dispatched work lacks evidence — even if you report it as done.`);

  // Best-effort cleanup of the resident worker on session stop.
  try { void stopServer(); } catch {}
}

// --- dispatch --------------------------------------------------------------
async function main(): Promise<void> {
  const event = process.argv[2] || "";
  switch (event) {
    case "session-start":      return onSessionStart();
    case "pre-tool-use":       return onPreToolUse();
    case "user-prompt-submit": return onUserPromptSubmit();
    case "stop":               return onStop();
    default:
      process.stderr.write(`leader_hook: unknown event "${event}"\n`);
      process.exit(1);
  }
}

main().catch((e) => {
  process.stderr.write(`leader_hook: ${e?.message || String(e)}\n`);
  process.exit(1);
});
