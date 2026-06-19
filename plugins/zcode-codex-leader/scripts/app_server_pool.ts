#!/usr/bin/env -S node --experimental-strip-types
// app_server_pool.ts — manages a resident codex app-server worker.
//
// Transport: the worker listens on ws://127.0.0.1:0 (loopback only). The actual
// port is parsed from the worker's stderr ("listening on: ws://127.0.0.1:PORT")
// and persisted to session.json. All clients (hooks, bridge) connect over
// WebSocket, which supports multi-client fanout and process decoupling.
//
// Lifecycle: SessionStart spawns the worker detached (it survives the hook).
// ensureServer() lazily starts/revives it if missing or dead. Each client opens
// a short-lived WebSocket per call; the worker stays resident across calls.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// codex binary resolution: prefer the hermes-installed node bin, fall back to PATH.
function codexBinary(): string {
  const hermes = path.join(os.homedir(), ".hermes/node/bin/codex");
  if (existsSync(hermes)) return hermes;
  return "codex";
}

export function pluginDataDir(): string {
  // PLUGIN_DATA is injected by codex for hooks; fall back to a per-user dir.
  const dir = process.env.PLUGIN_DATA || path.join(os.homedir(), ".codex/zcode-codex-leader-data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

type SessionState = {
  pid: number;
  wsUrl: string;        // e.g. ws://127.0.0.1:57128
  healthUrl: string;    // e.g. http://127.0.0.1:57128/healthz
  startedAt: number;
  threadId?: string;    // deprecated: threads are now per-dispatch (ephemeral)
  dispatchCount: number;
};

function sessionPath(): string {
  return path.join(pluginDataDir(), "session.json");
}

export function readSession(): SessionState | null {
  try {
    if (!existsSync(sessionPath())) return null;
    const s = JSON.parse(readFileSync(sessionPath(), "utf8")) as SessionState;
    if (!s || !s.wsUrl || !s.pid) return null;
    return s;
  } catch {
    return null;
  }
}

function writeSession(s: SessionState): void {
  writeFileSync(sessionPath(), JSON.stringify(s, null, 2));
}

export function bumpDispatch(): number {
  const s = readSession();
  if (!s) return 0;
  s.dispatchCount = (s.dispatchCount || 0) + 1;
  writeSession(s);
  return s.dispatchCount;
}

// Probe whether the worker is alive by opening a WebSocket and handshaking.
// More reliable than healthz (which can be slow or empty on this build).
async function isAlive(s: SessionState): Promise<boolean> {
  try {
    const c = await AppServerClient.connect(s.wsUrl, 1500);
    try {
      const r = await Promise.race([
        c.call("initialize", { clientInfo: { name: "probe", version: "0.1" }, capabilities: { experimentalApi: true } }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("probe timeout")), 2000)),
      ]);
      return !!(r as any)?.result;
    } finally {
      c.close();
    }
  } catch {
    return false;
  }
}

// Start a fresh detached worker, parse its ws URL from stderr, persist state.
// Returns the new session state, or throws on failure.
//
// The worker is deliberately stripped to its core capability set: shell, file
// read/write/edit, and search. All Codex plugins, MCP servers, memories,
// multi-agent spawning, plugin hooks, goals, built-in apps, browser/computer-use,
// image generation, and tool suggestions are disabled via -c config overrides so
// the worker cannot invoke external tools (browser, computer-use, cloudflare,
// codex apps, node_repl, etc.) that would slow it down or pollute its output.
async function startWorker(): Promise<SessionState> {
  const bin = codexBinary();
  const workerArgs = [
    "app-server", "--listen", "ws://127.0.0.1:0",
    // --- Disable all plugins (browser, chrome, computer-use, cloudflare, documents, etc.)
    "-c", "features.plugins=false",
    // --- Disable MCP servers; node_repl must be explicitly disabled because
    // --- Codex merges mcp_servers overrides instead of replacing the table.
    "-c", "mcp_servers={}",
    "-c", "mcp_servers.node_repl.enabled=false",
    // --- Disable built-in app/browser/computer-use surfaces that can expose extra MCP tools
    "-c", "features.apps=false",
    "-c", "features.browser_use=false",
    "-c", "features.browser_use_external=false",
    "-c", "features.computer_use=false",
    "-c", "features.in_app_browser=false",
    "-c", "features.image_generation=false",
    "-c", "features.skill_mcp_dependency_install=false",
    "-c", "features.tool_suggest=false",
    // --- Disable memories (avoids stale context injection)
    "-c", "features.memories=false",
    // --- Disable multi-agent spawning (worker must not spawn sub-agents)
    "-c", "features.multi_agent=false",
    // --- Disable plugin hooks on the worker (hooks are a leader concern)
    "-c", "features.plugin_hooks=false",
    // --- Disable goals (worker receives bounded packets, not goals)
    "-c", "features.goals=false",
  ];
  const child: ChildProcess = spawn(bin, workerArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,          // survive parent exit
    env: { ...process.env },
  });
  child.unref();

  const wsUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for worker to print ws URL")), 8000);
    let acc = "";
    child.stderr?.on("data", (d: Buffer) => {
      acc += d.toString();
      const m = acc.match(/ws:\/\/127\.0\.0\.1:\d+/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`worker exited before binding (code=${code})`));
    });
  });

  const healthUrl = wsUrl.replace("ws://", "http://").replace(/$/, "") + "/healthz";
  const state: SessionState = {
    pid: child.pid!,
    wsUrl,
    healthUrl,
    startedAt: Date.now(),
    dispatchCount: 0,
  };
  writeSession(state);
  return state;
}

// Ensure a live worker exists; (re)start if missing or dead.
export async function ensureServer(): Promise<SessionState> {
  const s = readSession();
  if (s && await isAlive(s)) return s;
  // stale state — clear and start fresh
  try { unlinkSync(sessionPath()); } catch {}
  return startWorker();
}

// One-shot WebSocket JSON-RPC client. Opens a connection, sends requests,
// resolves responses by id, and feeds notifications to onNotification.
// Returns when the caller's work is done (controlled via shouldClose).
type JsonRpcMsg = { jsonrpc?: "2.0"; id?: string; method?: string; params?: any; result?: any; error?: any };

export class AppServerClient {
  private ws: WebSocket;
  private idc = 0;
  private pending = new Map<string, (m: JsonRpcMsg) => void>();
  private handlers: Array<(m: JsonRpcMsg) => void> = [];

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
  }

  static async connect(wsUrl: string, timeoutMs = 5000): Promise<AppServerClient> {
    const client = new AppServerClient(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ws connect timeout to ${wsUrl}`)), timeoutMs);
      client.ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      client.ws.addEventListener("error", (e: any) => { clearTimeout(timer); reject(new Error(`ws error: ${e?.message || e}`)); }, { once: true });
    });
    // WebSocket frames are whole JSON-RPC messages (no newline framing).
    client.ws.addEventListener("message", (ev: MessageEvent) => {
      const data = ev.data as string;
      // Tolerate occasional multi-message batches split by newline.
      const lines = data.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as JsonRpcMsg;
          if (msg.id && client.pending.has(msg.id)) {
            client.pending.get(msg.id)!(msg);
            client.pending.delete(msg.id);
          } else if (msg.method) {
            client.handlers.forEach((h) => h(msg));
          }
        } catch { /* ignore non-JSON */ }
      }
    });
    return client;
  }

  call(method: string, params: any = {}): Promise<JsonRpcMsg> {
    const id = String(++this.idc);
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`rpc timeout: ${method}`)); } }, 120000);
    });
  }

  notify(method: string, params: any = {}): void {
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  onNotification(fn: (m: JsonRpcMsg) => void): void { this.handlers.push(fn); }

  close(): void {
    try { this.ws.close(); } catch {}
  }
}

// High-level: run a turn on the resident worker's thread, drain notifications
// until turn/completed. Returns collected message text and image-generation items.
export type TurnResult = {
  turnId: string;
  messages: string[];                                   // agentMessage.text values
  imageGeneration: Array<{ status: string; result: string; savedPath?: string }>;
  rawItems: any[];
};

export async function runTurn(
  input: any[],
  opts: { model?: string; cwd?: string; outputSchema?: object; effort?: string } = {},
): Promise<TurnResult> {
  const state = await ensureServer();
  const client = await AppServerClient.connect(state.wsUrl);

  try {
    // initialize handshake (idempotent-ish; worker tolerates repeat clients)
    await client.call("initialize", { clientInfo: { name: "zcode-bridge", version: "0.1" }, capabilities: { experimentalApi: true } });
    client.notify("notifications/initialized");

    // Start a fresh ephemeral thread per dispatch. Each dispatch is a bounded
    // packet by the leader constitution, so cross-turn state is not needed;
    // ZCode (the leader) holds context itself. Ephemeral threads self-clean,
    // and reuse of a long-lived thread was observed to leave turns without a
    // turn/completed notification.
    const thr = await client.call("thread/start", { ephemeral: true, cwd: opts.cwd || process.cwd() });
    const threadId: string = thr.result?.thread?.id;
    if (!threadId) throw new Error("thread/start returned no thread id");

    const messages: string[] = [];
    const imageGeneration: any[] = [];
    const rawItems: any[] = [];
    let done = false;

    client.onNotification((m) => {
      if (m.method === "item/completed") {
        const it = m.params?.item || {};
        rawItems.push(it);
        if (it.type === "agentMessage" && typeof it.text === "string") {
          messages.push(it.text);
        } else if (it.type === "imageGeneration") {
          imageGeneration.push({ status: it.status, result: it.result || "", savedPath: it.savedPath || undefined });
        }
      } else if (m.method === "turn/completed") {
        done = true;
      }
    });

    const turnParams: any = { threadId, input };
    if (opts.model) turnParams.model = opts.model;
    if (opts.cwd) turnParams.cwd = opts.cwd;
    if (opts.effort) turnParams.effort = opts.effort;
    if (opts.outputSchema) turnParams.outputSchema = opts.outputSchema;

    const turnResp = await client.call("turn/start", turnParams);
    const turnId = turnResp.result?.turn?.id || "unknown";

    // drain until turn/completed (with a hard ceiling)
    const start = Date.now();
    while (!done && Date.now() - start < 300000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    return { turnId, messages, imageGeneration, rawItems };
  } finally {
    client.close();
  }
}

// Direct MCP tool call (bypasses a turn).
export async function callMcpTool(
  server: string,
  tool: string,
  args: any,
  useThread: boolean,
): Promise<any> {
  const state = await ensureServer();
  const client = await AppServerClient.connect(state.wsUrl);
  try {
    await client.call("initialize", { clientInfo: { name: "zcode-bridge", version: "0.1" }, capabilities: { experimentalApi: true } });
    client.notify("notifications/initialized");

    let threadId: string | undefined;
    if (useThread) {
      const thr = await client.call("thread/start", { ephemeral: true, cwd: process.cwd() });
      threadId = thr.result?.thread?.id;
    }

    const resp = await client.call("mcpServer/tool/call", {
      server, tool, arguments: args, ...(threadId ? { threadId } : {}),
    });
    return resp.result;
  } finally {
    client.close();
  }
}

// Manual stop of the resident worker (e.g. for cleanup / Stop hook).
export async function stopServer(): Promise<void> {
  const s = readSession();
  if (!s) return;
  try { process.kill(s.pid, "SIGTERM"); } catch {}
  try { unlinkSync(sessionPath()); } catch {}
}
