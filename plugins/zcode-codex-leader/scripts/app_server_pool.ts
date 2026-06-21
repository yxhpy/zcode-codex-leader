#!/usr/bin/env -S node --experimental-strip-types
// app_server_pool.ts - manages a resident codex app-server worker.
//
// Transport: the worker listens on ws://127.0.0.1:0 (loopback only). The actual
// port is parsed from the worker's stderr and persisted to session.json. Clients
// connect over WebSocket; the worker stays resident across calls.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function codexBinary(): string {
  const hermes = path.join(os.homedir(), ".hermes/node/bin/codex");
  if (existsSync(hermes)) return hermes;
  return "codex";
}

// Kill an entire worker process group. codex spawns a dual-process worker
// (node launcher pid A + codex binary pid B); killing only A leaks B because B
// gets reparented to init and keeps serving WebSocket. spawn(detached:true) makes
// the child a process-group leader (pgid == pid), so -pid kills the whole group.
// Tolerate single-pid fallback for old sessions spawned before detached:true.
function killProcessGroup(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try { process.kill(-pid, signal); } catch {}
  try { process.kill(pid, signal); } catch {}
}

export function pluginDataDir(): string {
  const dir = process.env.PLUGIN_DATA || path.join(os.homedir(), ".codex/zcode-codex-leader-data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export const MODEL_TIERS = {
  fast: { model: "gpt-5.4-mini", effort: "low", serviceTier: "fast" },
  balanced: { model: "gpt-5.5", effort: "medium", serviceTier: "default" },
  strong: { model: "gpt-5.5", effort: "high", serviceTier: "default" },
} as const;

type ModelTierName = keyof typeof MODEL_TIERS;
type ModelRoutingOpts = {
  model?: string;
  effort?: string;
  serviceTier?: string;
  tier?: string;
  taskKind?: string;
};
type ResolvedModelOpts = {
  model?: string;
  effort?: string;
  serviceTier?: string;
};
type RunTurnOpts = ModelRoutingOpts & {
  cwd?: string;
  outputSchema?: object;
};

function isModelTierName(value: string | undefined): value is ModelTierName {
  return value === "fast" || value === "balanced" || value === "strong";
}

function inferModelTier(opts: ModelRoutingOpts = {}): ModelTierName {
  if (isModelTierName(opts.tier)) return opts.tier;
  const taskKind = opts.taskKind?.toLowerCase();
  if (taskKind === "codegen" || taskKind === "review" || taskKind === "debug" || taskKind === "refactor") return "strong";
  if (taskKind === "explore" || taskKind === "parse" || taskKind === "qa" || taskKind === "summary") return "fast";
  return "balanced";
}

export function resolveModelOpts(opts: ModelRoutingOpts = {}): ResolvedModelOpts {
  const resolved: ResolvedModelOpts = { ...MODEL_TIERS[inferModelTier(opts)] };
  if (opts.model) resolved.model = opts.model;
  if (opts.effort) resolved.effort = opts.effort;
  if (opts.serviceTier) resolved.serviceTier = opts.serviceTier;
  return Object.fromEntries(
    Object.entries(resolved).filter(([, value]) => typeof value === "string" && value.length > 0),
  ) as ResolvedModelOpts;
}

type SessionState = {
  pid: number;
  wsUrl: string;
  healthUrl: string;
  startedAt: number;
  threadId?: string;
  dispatchCount: number;
};

let residentChild: ChildProcess | undefined;
let residentThreadStale = false;

const NOTIFICATION_POLL_TIMEOUT_MS = 250;
const POST_TOOL_QUIET_TIMEOUT_MS = 90000;
const DEFAULT_TURN_CEILING_MS = 300000;
const AUTH_FAILURE_HINT = "Codex authentication failed — your ChatGPT/Codex login looks expired or invalid. Run `codex login` to refresh, then retry.";

const AUTH_FAILURE_PATTERNS = [
  "invalid_grant",
  "refresh token",
  "token has expired",
  "expired token",
  "not authenticated",
  "unauthenticated",
  "unauthorized",
  "401 unauthorized",
  "re-authenticate",
  "please log in",
  "please login",
  "oauth",
  "no auth profile",
];

export function classifyCodexError(message: string, stderrLines: string[] = []): string | null {
  const haystack = [message, ...stderrLines].join("\n").toLowerCase();
  return AUTH_FAILURE_PATTERNS.some((pattern) => haystack.includes(pattern)) ? AUTH_FAILURE_HINT : null;
}

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

function unlinkSession(): void {
  try { unlinkSync(sessionPath()); } catch {}
}

export function bumpDispatch(): number {
  const s = readSession();
  if (!s) return 0;
  s.dispatchCount = (s.dispatchCount || 0) + 1;
  writeSession(s);
  return s.dispatchCount;
}

async function isAlive(s: SessionState): Promise<boolean> {
  try {
    const c = await AppServerClient.connect(s.wsUrl, 1500);
    try {
      const r = await Promise.race([
        c.call("initialize", { clientInfo: { name: "probe", version: "0.1" }, capabilities: { experimentalApi: true } }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("probe timeout")), 2000)),
      ]);
      return !!(r as any)?.result;
    } finally {
      c.close();
    }
  } catch {
    return false;
  }
}

function workerArgs(imageGeneration: boolean): string[] {
  return [
    "app-server", "--listen", "ws://127.0.0.1:0",
    "-c", "features.plugins=false",
    "-c", "mcp_servers={}",
    "-c", "mcp_servers.node_repl.enabled=false",
    "-c", "features.apps=false",
    "-c", "features.browser_use=false",
    "-c", "features.browser_use_external=false",
    "-c", "features.computer_use=false",
    "-c", "features.in_app_browser=false",
    "-c", `features.image_generation=${imageGeneration ? "true" : "false"}`,
    "-c", "features.skill_mcp_dependency_install=false",
    "-c", "features.tool_suggest=false",
    "-c", "features.memories=false",
    "-c", "features.multi_agent=false",
    "-c", "features.plugin_hooks=false",
    "-c", "features.goals=false",
  ];
}

async function spawnWorker(imageGeneration: boolean, persist: boolean): Promise<{ state: SessionState; child: ChildProcess }> {
  const child: ChildProcess = spawn(codexBinary(), workerArgs(imageGeneration), {
    stdio: ["pipe", "pipe", "pipe"],
    detached: persist,
    env: { ...process.env },
  });
  if (persist) child.unref();

  const wsUrl = await new Promise<string>((resolve, reject) => {
    let acc = "";
    const tail = () => acc.slice(-2000);
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`timed out waiting for worker to print ws URL (stderr tail):\n${tail()}`));
    }, 8000);
    child.stderr?.on("data", (d: Buffer) => {
      acc += d.toString();
      const m = acc.match(/ws:\/\/127\.0\.0\.1:\d+/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`worker exited before binding (code=${code}, stderr tail):\n${tail()}`));
    });
  });

  const state: SessionState = {
    pid: child.pid!,
    wsUrl,
    healthUrl: `${wsUrl.replace("ws://", "http://")}/healthz`,
    startedAt: Date.now(),
    dispatchCount: 0,
  };
  if (persist) writeSession(state);
  return { state, child };
}

async function startWorker(): Promise<SessionState> {
  const { state, child } = await spawnWorker(false, true);
  residentChild = child;
  try {
    return await ensureResidentThread(state, process.cwd());
  } catch (e) {
    try { killProcessGroup(child.pid!); } catch {}
    unlinkSession();
    residentChild = undefined;
    throw e;
  }
}

export async function ensureServer(): Promise<SessionState> {
  const s = readSession();
  if (s && await isAlive(s)) {
    if (s.threadId && !residentThreadStale) return s;
    const withThread = await ensureResidentThread(s, process.cwd());
    residentThreadStale = false;
    return withThread;
  }

  unlinkSession();
  residentChild = undefined;
  return startWorker();
}

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
      client.ws.addEventListener("error", (e: any) => {
        clearTimeout(timer);
        reject(new Error(`ws error: ${e?.message || e}`));
      }, { once: true });
    });

    client.ws.addEventListener("message", (ev: MessageEvent) => {
      const data = ev.data as string;
      for (const line of data.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as JsonRpcMsg;
          if (msg.id && client.pending.has(msg.id)) {
            client.pending.get(msg.id)!(msg);
            client.pending.delete(msg.id);
          } else if (msg.method) {
            client.handlers.forEach((handler) => handler(msg));
          }
        } catch {
          // Ignore non-JSON frames.
        }
      }
    });
    return client;
  }

  call(method: string, params: any = {}): Promise<JsonRpcMsg> {
    const id = String(++this.idc);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`rpc timeout: ${method}`));
        }
      }, 120000);
      (timer as any).unref?.();

      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });

      try {
        this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  notify(method: string, params: any = {}): void {
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  onNotification(fn: (m: JsonRpcMsg) => void): void {
    this.handlers.push(fn);
  }

  close(): void {
    try { this.ws.close(); } catch {}
  }
}

function safeJson(value: any): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatRpcError(method: string, error: any): string {
  if (!error) return `${method} failed`;
  if (typeof error === "string") return `${method}: ${error}`;
  if (typeof error?.message === "string") {
    const code = error.code === undefined ? "" : ` code=${error.code}`;
    const data = error.data === undefined ? "" : ` data=${safeJson(error.data)}`;
    return `${method}:${code} ${error.message}${data}`.trim();
  }
  return `${method}: ${safeJson(error)}`;
}

function throwIfRpcError(method: string, resp: JsonRpcMsg): void {
  if (!resp.error) return;
  const message = formatRpcError(method, resp.error);
  const classified = classifyCodexError(message);
  if (classified) throw new Error(classified);
  throw new Error(message);
}

async function callRpc(client: AppServerClient, method: string, params: any = {}): Promise<JsonRpcMsg> {
  try {
    const resp = await client.call(method, params);
    throwIfRpcError(method, resp);
    return resp;
  } catch (e: any) {
    const classified = classifyCodexError(e?.message || String(e));
    if (classified) throw new Error(classified);
    throw e;
  }
}

async function callRpcAllowError(client: AppServerClient, method: string, params: any = {}): Promise<JsonRpcMsg> {
  try {
    return await client.call(method, params);
  } catch (e: any) {
    const classified = classifyCodexError(e?.message || String(e));
    if (classified) throw new Error(classified);
    throw e;
  }
}

async function initializeClient(client: AppServerClient): Promise<void> {
  await callRpc(client, "initialize", {
    clientInfo: { name: "zcode-bridge", version: "0.1" },
    capabilities: { experimentalApi: true },
  });
  client.notify("notifications/initialized");
}

function extractThreadId(resp: JsonRpcMsg): string | undefined {
  const result = resp.result || {};
  return result.thread?.id || result.thread?.sessionId || result.threadId || result.sessionId || result.id;
}

async function startThread(client: AppServerClient, cwd: string, ephemeral: boolean): Promise<string> {
  let resp: JsonRpcMsg;
  try {
    resp = await callRpcAllowError(client, "thread/start", { ephemeral, cwd });
  } catch (e: any) {
    const message = e?.message || String(e);
    const classified = classifyCodexError(message);
    if (classified) throw new Error(classified);
    throw e;
  }

  if (resp.error) {
    const message = formatRpcError("thread/start", resp.error);
    const classified = classifyCodexError(message);
    throw new Error(classified || message);
  }

  const threadId = extractThreadId(resp);
  if (!threadId) throw new Error("thread/start returned no thread id");
  return threadId;
}

function cacheResidentThread(state: SessionState, threadId: string): void {
  state.threadId = threadId;
  writeSession(state);
}

function clearCachedThread(state: SessionState): void {
  delete state.threadId;
  writeSession(state);
}

async function ensureResidentThread(state: SessionState, cwd: string): Promise<SessionState> {
  const client = await AppServerClient.connect(state.wsUrl);
  try {
    await initializeClient(client);
    const threadId = await startThread(client, cwd, false);
    cacheResidentThread(state, threadId);
    residentThreadStale = false;
    return state;
  } catch (e: any) {
    const classified = classifyCodexError(e?.message || String(e));
    if (classified) throw new Error(classified);
    throw e;
  } finally {
    client.close();
  }
}

function isThreadMissingError(message: string): boolean {
  return /unknown thread|thread not found/i.test(message);
}

function isWorkerAlive(): boolean {
  if (!residentChild) return true;
  return residentChild.exitCode === null;
}

function isToolShapedItem(item: any): boolean {
  const candidates = [
    item?.type,
    item?.name,
    item?.toolName,
    item?.tool,
    item?.command,
  ].map((value) => String(value || "").toLowerCase());
  return candidates.some((value) =>
    value.includes("tool") ||
    value.includes("command") ||
    value.includes("shell") ||
    value.includes("exec") ||
    value.includes("mcp") ||
    value.includes("patch") ||
    value.includes("edit") ||
    value.includes("file") ||
    value.includes("search")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpcTurn(
  client: AppServerClient,
  state: SessionState,
  turnParams: any,
  cwd: string,
  ephemeralThread: boolean,
): Promise<JsonRpcMsg> {
  let resp = await callRpcAllowError(client, "turn/start", turnParams);
  if (!resp.error) return resp;

  const message = formatRpcError("turn/start", resp.error);
  const classified = classifyCodexError(message);
  if (classified) throw new Error(classified);

  if (!isThreadMissingError(message)) {
    throw new Error(message);
  }

  residentThreadStale = true;
  if (!ephemeralThread) clearCachedThread(state);

  const threadId = await startThread(client, cwd, ephemeralThread);
  turnParams.threadId = threadId;
  if (!ephemeralThread) {
    cacheResidentThread(state, threadId);
    residentThreadStale = false;
  }

  resp = await callRpcAllowError(client, "turn/start", turnParams);
  throwIfRpcError("turn/start", resp);
  return resp;
}

function sendTurnInterrupt(client: AppServerClient, turnId: string): void {
  if (!turnId || turnId === "unknown") return;
  void callRpcAllowError(client, "turn/interrupt", { turnId }).catch(() => {});
}

export type TurnResult = {
  turnId: string;
  messages: string[];
  imageGeneration: Array<{ status: string; result: string; savedPath?: string }>;
  rawItems: any[];
  tier?: string;
  model?: string;
};

async function runTurnOnState(
  state: SessionState,
  input: any[],
  opts: RunTurnOpts = {},
  timeoutMs = DEFAULT_TURN_CEILING_MS,
): Promise<TurnResult> {
  const client = await AppServerClient.connect(state.wsUrl);
  const cwd = opts.cwd || process.cwd();
  const tier = inferModelTier(opts);
  const modelOpts = resolveModelOpts(opts);
  const notificationPollMs = NOTIFICATION_POLL_TIMEOUT_MS;
  const postToolQuietMs = POST_TOOL_QUIET_TIMEOUT_MS;
  const turnCeiling = timeoutMs || DEFAULT_TURN_CEILING_MS;

  try {
    await initializeClient(client);

    // Default to ephemeral threads. Codex app-server has a bug where a resident
    // thread accepts the first turn/start but hangs on the second (process alive,
    // healthz up, but turn/start never returns). codex_bridge dispatches are
    // stateless, so reusing a thread buys nothing and triggers the hang. Set
    // FORCE_RESIDENT_THREAD=1 to opt back in once codex fixes the bug.
    const useResidentThread = !!state.threadId && process.env.FORCE_RESIDENT_THREAD === "1";
    const threadId = useResidentThread ? state.threadId! : await startThread(client, cwd, true);
    const ephemeralThread = !useResidentThread;

    const messages: string[] = [];
    const imageGeneration: Array<{ status: string; result: string; savedPath?: string }> = [];
    const rawItems: any[] = [];
    let done = false;
    let lastToolCompletionAt = 0;
    let workerDied = false;
    let lastNotificationAt = Date.now();

    // Detect mid-turn worker death via the WebSocket itself. The old
    // isWorkerAlive() check reads a module-level residentChild that is undefined
    // across codex_bridge CLI invocations, so it never fired. The WS close/error
    // events fire regardless of which process spawned the worker.
    client.ws.addEventListener("close", () => { workerDied = true; });
    client.ws.addEventListener("error", () => { workerDied = true; });

    client.onNotification((m) => {
      const now = Date.now();
      lastNotificationAt = now;

      if (m.method === "item/completed") {
        const item = m.params?.item || {};
        rawItems.push(item);
        if (item.type === "agentMessage" && typeof item.text === "string") {
          messages.push(item.text);
        } else if (item.type === "imageGeneration") {
          imageGeneration.push({
            status: item.status,
            result: item.result || "",
            savedPath: item.savedPath || undefined,
          });
        }
        if (isToolShapedItem(item)) lastToolCompletionAt = now;
      } else if (m.method === "turn/completed") {
        done = true;
      }
    });

    const turnParams: any = { threadId, input };
    if (opts.cwd) turnParams.cwd = opts.cwd;
    if (opts.outputSchema) turnParams.outputSchema = opts.outputSchema;
    if (modelOpts.model) turnParams.model = modelOpts.model;
    if (modelOpts.effort) turnParams.effort = modelOpts.effort;
    if (modelOpts.serviceTier) turnParams.serviceTier = modelOpts.serviceTier;

    const turnResp = await rpcTurn(client, state, turnParams, cwd, ephemeralThread);
    const turnId = turnResp.result?.turn?.id || turnResp.result?.turnId || "unknown";
    const startedAt = Date.now();

    let breakReason: string | null = null;
    while (!done && Date.now() - startedAt < turnCeiling) {
      if (workerDied) { breakReason = "workerDied"; break; }
      // Dual-process guard: codex runs as node-launcher (pid A, recorded in
      // session) + codex-binary (pid B, the WS server). Killing A alone does not
      // close the WS (B keeps serving), so workerDied never fires. Polling pid A
      // liveness catches the half-death where A is gone but the WS still looks
      // open — a stale worker that will hang the next turn/start.
      if (state.pid) {
        try { process.kill(state.pid, 0); } catch { breakReason = "parentPidGone"; break; }
      }
      if (!isWorkerAlive()) { breakReason = "isWorkerAlive=false"; break; }

      const now = Date.now();
      if (lastToolCompletionAt && now - lastToolCompletionAt > postToolQuietMs) {
        sendTurnInterrupt(client, turnId);
        residentThreadStale = true;
        breakReason = "postToolQuiet";
        break;
      }

      await sleep(notificationPollMs);
    }

    if (breakReason && !done) {
      const elapsedMs = Date.now() - startedAt;
      const quietMs = Date.now() - lastNotificationAt;
      process.stderr.write(
        `[worker-hang] reason=${breakReason} elapsed=${Math.round(elapsedMs / 1000)}s lastNotification=${Math.round(quietMs / 1000)}s ago done=${done} turnId=${turnId}\n`,
      );
    }

    return {
      turnId,
      messages,
      imageGeneration,
      rawItems,
      tier,
      model: modelOpts.model,
    };
  } finally {
    client.close();
  }
}

export async function runTurn(input: any[], opts: RunTurnOpts = {}): Promise<TurnResult> {
  const state = await ensureServer();
  return runTurnOnState(state, input, opts, DEFAULT_TURN_CEILING_MS);
}

export async function runImageTurn(
  input: any[],
  opts: { model?: string; cwd?: string; outputSchema?: object; effort?: string; timeoutMs?: number } = {},
): Promise<TurnResult> {
  const { state, child } = await spawnWorker(true, false);
  try {
    return await runTurnOnState(state, input, opts, opts.timeoutMs || 900000);
  } finally {
    try { killProcessGroup(child.pid!); } catch {}
    setTimeout(() => { try { killProcessGroup(child.pid!, "SIGKILL"); } catch {} }, 2000).unref?.();
  }
}

export async function runTestTurn(
  input: any[],
  opts: {
    cwd?: string;
    outputSchema?: object;
    timeoutMs?: number;
    browser?: boolean;
    fullAccess?: boolean;
  } = {},
): Promise<TurnResult> {
  function testWorkerArgs(browser: boolean, fullAccess: boolean): string[] {
    const sandboxMode = browser || fullAccess ? "danger-full-access" : "workspace-write";
    const args = [
      ...workerArgs(false),
      "-c", `sandbox_mode="${sandboxMode}"`,
    ];

    if (browser) {
      args.push(
        "-c", "features.browser_use=true",
        "-c", "features.browser_use_external=true",
        "-c", "features.plugins=true",
        "-c", 'plugins={"browser@openai-bundled":{"enabled":true},"chrome@openai-bundled":{"enabled":true}}',
      );
    }

    return args;
  }

  const child: ChildProcess = spawn(codexBinary(), testWorkerArgs(!!opts.browser, !!opts.fullAccess), {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    env: { ...process.env },
  });

  const wsUrl = await new Promise<string>((resolve, reject) => {
    let acc = "";
    const tail = () => acc.slice(-2000);
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`timed out waiting for worker to print ws URL (stderr tail):\n${tail()}`));
    }, 8000);
    child.stderr?.on("data", (d: Buffer) => {
      acc += d.toString();
      const m = acc.match(/ws:\/\/127\.0\.0\.1:\d+/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`worker exited before binding (code=${code}, stderr tail):\n${tail()}`));
    });
  });

  const state: SessionState = {
    pid: child.pid!,
    wsUrl,
    healthUrl: `${wsUrl.replace("ws://", "http://")}/healthz`,
    startedAt: Date.now(),
    dispatchCount: 0,
  };

  try {
    return await runTurnOnState(state, input, opts, opts.timeoutMs || 600000);
  } finally {
    try { killProcessGroup(child.pid!); } catch {}
    setTimeout(() => { try { killProcessGroup(child.pid!, "SIGKILL"); } catch {} }, 2000).unref?.();
  }
}

export async function callMcpTool(
  server: string,
  tool: string,
  args: any,
  useThread: boolean,
): Promise<any> {
  const state = await ensureServer();
  const client = await AppServerClient.connect(state.wsUrl);
  try {
    await initializeClient(client);

    let threadId: string | undefined;
    if (useThread) {
      threadId = await startThread(client, process.cwd(), true);
    }

    const resp = await callRpc(client, "mcpServer/tool/call", {
      server,
      tool,
      arguments: args,
      ...(threadId ? { threadId } : {}),
    });
    return resp.result;
  } finally {
    client.close();
  }
}

export async function stopServer(): Promise<void> {
  const s = readSession();
  if (!s) return;
  killProcessGroup(s.pid);
  // Escalate to SIGKILL after a grace period. A worker that ignores SIGTERM
  // would otherwise be leaked (the old code only sent SIGTERM once).
  setTimeout(() => { try { killProcessGroup(s.pid, "SIGKILL"); } catch {} }, 2000).unref?.();
  unlinkSession();
  residentChild = undefined;
  residentThreadStale = false;
}
