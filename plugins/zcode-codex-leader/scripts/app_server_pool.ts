#!/usr/bin/env -S node --experimental-strip-types
// app_server_pool.ts - manages a resident codex app-server worker.
//
// Transport: the worker listens on ws://127.0.0.1:0 (loopback only). The actual
// port is parsed from the worker's stderr and persisted to session.json. Clients
// connect over WebSocket; the worker stays resident across calls.

import { spawn, execSync, type ChildProcess } from "node:child_process";
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

// Probe whether a pid is alive (signal 0 = existence probe, no signal sent).
// Closes the dual-process blind spot: codex worker = node launcher (pid A =
// session.pid) + codex binary (pid B = the real WS server). If A dies but B
// keeps serving WS, isAlive() still returns true — yet the worker's turn loop
// is already wedged, so the next turn/start hangs. Checking pid A first lets
// ensureServer fail fast and spawn a fresh worker.
function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Find leaked resident workers from previous crashed sessions. The worker
// fingerprint is "app-server" + "--listen ws://127.0.0.1" + our feature-flag
// cocktail; "features.goals=false" is unique to this plugin's workers, so other
// codex app-server processes (Codex.app, VSCode, hermes login) never match.
//
// A worker is a dual process: launcher pid A + codex binary pid B (A's child,
// same process group). Both match the fingerprint, so we spare the whole live
// group: keepPid plus every pid whose ppid chain still reaches keepPid. When A
// is dead, its B is reparented to init (ppid=1) and becomes a true orphan —
// exactly what we want to reap. NOTE: assumes a single resident worker per
// host; concurrent zcode sessions using this plugin would see each other's
// worker as orphans.
function listOrphanWorkers(keepPid: number | null): number[] {
  let out = "";
  try {
    out = execSync("ps -eo pid=,ppid=,command=", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return [];
  }
  // Map pid -> ppid for live-process ancestry walks, and the matching worker
  // pids (fingerprint hit) to spare/kill.
  const ppidOf = new Map<number, number>();
  const matched: number[] = [];
  for (const line of out.split("\n")) {
    if (!line.includes("app-server")) continue;
    if (!line.includes("ws://127.0.0.1")) continue;
    if (!line.includes("features.goals=false")) continue;
    const parts = line.trim().split(/\s+/);
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (Number.isFinite(ppid)) ppidOf.set(pid, ppid);
    matched.push(pid);
  }
  // A pid is "live group" (spared) if keepPid is alive and the pid is keepPid
  // itself or a descendant via the ppid chain. We rebuild ppidOf from ps each
  // call, so a dead A simply won't appear as anyone's ancestor — its B (now
  // ppid=1) is correctly classified as an orphan.
  const liveGroup = new Set<number>();
  if (keepPid !== null && isPidAlive(keepPid)) {
    for (const pid of matched) {
      let cur: number = pid;
      const guard = new Set<number>();
      while (Number.isFinite(cur) && cur > 0 && !guard.has(cur)) {
        guard.add(cur);
        if (cur === keepPid) { liveGroup.add(pid); break; }
        cur = ppidOf.get(cur) ?? 0;
      }
    }
  }
  return matched.filter((pid) => !liveGroup.has(pid));
}

function reapOrphanWorkers(keepPid: number | null): number {
  const orphans = listOrphanWorkers(keepPid);
  for (const pid of orphans) {
    try { killProcessGroup(pid, "SIGKILL"); } catch {}
  }
  return orphans.length;
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

// ponytail: restart budget — window-based, prevents crash loop. global lock, per-worker if throughput matters.
const RESTART_WINDOW_MS = 10 * 60 * 1000;        // 10 min window
const RESTART_MAX_IN_WINDOW = 3;                  // max 3 restarts per window
const RESTART_INITIAL_BACKOFF_MS = 1000;
const RESTART_MAX_BACKOFF_MS = 30_000;

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
  workerEpoch: number;
  restartCount: number;
  restartedAt: number;
  threadId?: string;
  dispatchCount: number;
  // True for one-shot workers (image / test) spawned with their own process and
  // NOT persisted to session.json. runTurnOnState's resident-epoch-staleness
  // guard must be skipped for transient workers, because it compares the
  // worker's turnEpoch against the on-disk resident workerEpoch — which for a
  // freshly-spawned transient worker is always 1, while the resident session's
  // epoch climbs across restarts, so the guard would always fire and kill every
  // transient turn. See issue: generate-image always fails with
  // "worker epoch advanced" once the resident worker has restarted.
  transient?: boolean;
};

let residentChild: ChildProcess | undefined;
let residentThreadStale = false;

const NOTIFICATION_POLL_TIMEOUT_MS = 250;
const POST_TOOL_QUIET_TIMEOUT_MS = 90000;
const DEFAULT_TURN_CEILING_MS = 300000;
const AUTH_FAILURE_HINT = "Codex authentication failed — your ChatGPT/Codex login looks expired or invalid. Run `codex login` to refresh, then retry.";

// Raised when the resident worker is wedged (turn/start timed out). runTurn
// catches it, kills the stale worker, and retries once via ensureServer.
// Turns the old 120s hard hang into ~12s + respawn.
class WorkerStaleError extends Error {
  workerEpoch?: number;

  constructor(message: string, workerEpoch?: number) {
    super(message);
    this.name = "WorkerStaleError";
    this.workerEpoch = workerEpoch;
  }
}

export class WorkerUnavailableError extends Error {
  readonly restartCount?: number;
  readonly startedAt?: number;

  constructor(message: string, info?: { restartCount: number; startedAt: number }) {
    super(message);
    this.name = "WorkerUnavailableError";
    if (info) {
      this.restartCount = info.restartCount;
      this.startedAt = info.startedAt;
    }
  }
}

// Per-method RPC ceilings. The old code used a flat 120s for every RPC, so a
// half-dead worker (WS up, turn loop stuck) made turn/start block the full 120s.
// turn/start / thread/start return in well under a second normally; a timeout
// there is a reliable wedge signal, so we keep them short and let rpcTurn turn
// the timeout into a WorkerStaleError for fast kill+restart.
const RPC_TIMEOUTS_MS: Record<string, number> = {
  initialize: 5_000,
  "thread/start": 8_000,
  "thread/name/set": 5_000,
  "turn/start": 12_000,
  "turn/interrupt": 3_000,
  "mcpServer/tool/call": 30_000,
  "account/read": 10_000,
  "config/read": 10_000,
};
const DEFAULT_RPC_TIMEOUT_MS = 60_000;

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
    s.workerEpoch = Number.isFinite(s.workerEpoch) && s.workerEpoch > 0 ? s.workerEpoch : 1;
    s.restartCount = Number.isFinite(s.restartCount) && s.restartCount >= 0 ? s.restartCount : 0;
    s.restartedAt = Number.isFinite(s.restartedAt) && s.restartedAt >= 0 ? s.restartedAt : 0;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    // approval_policy=never: dangerous ops (rm, mv, network) would otherwise block
    // waiting for a human reviewer that never comes in app-server mode (no TTY),
    // hanging turn/start until the RPC ceiling. This MUST be passed via -c:
    // codex has a known bug (#27617) where approval_policy in config.toml is
    // ignored by the CLI, so the user's global setting can't save us. Paired
    // with sandbox_mode below so the worker can write but can't escape the
    // workspace without us knowing.
    "-c", "approval_policy=never",
    // sandbox_mode=workspace-write: let the worker edit files and run commands
    // inside the project cwd without prompting. Matches the test worker's
    // default and the leader-only contract (all writes go through this worker).
    "-c", "sandbox_mode=\"workspace-write\"",
    "-c", "features.plugins=false",
    "-c", "mcp_servers={}",
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
    workerEpoch: 1,
    restartCount: 0,
    restartedAt: Date.now(),
    dispatchCount: 0,
    // spawnWorker(false, false) is the image-worker path (called by runImageTurn
    // via spawnWorker(true, false)); it is NOT the resident worker, so mark it
    // transient so the epoch-staleness guard is skipped for it.
    transient: !persist,
  };
  if (persist) writeSession(state);
  return { state, child };
}

async function startWorker(restartMeta?: Pick<SessionState, "workerEpoch" | "restartCount" | "restartedAt">): Promise<SessionState> {
  const { state, child } = await spawnWorker(false, true);
  if (restartMeta) {
    state.workerEpoch = restartMeta.workerEpoch;
    state.restartCount = restartMeta.restartCount;
    state.restartedAt = restartMeta.restartedAt;
    writeSession(state);
  }
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

// Best-effort sweep of leaked resident workers from previous crashed sessions.
// Called from leader_hook onSessionStart so every new zcode session starts
// clean, instead of accumulating one leaked dual-process worker per crash. The
// keepPid is read live from session.json: if a worker is still alive and owned
// by the current session it is spared (whole live group via ppid-chain walk);
// everything else matching the worker fingerprint is SIGKILLed. Returns the
// number of orphaned pids reaped. NOTE: concurrent zcode sessions using this
// plugin on the same host would see each other's live worker as an orphan —
// see the listOrphanWorkers caveat.
export function reapOrphanWorkersOnStartup(): number {
  const s = readSession();
  return reapOrphanWorkers(s?.pid ?? null);
}

export async function ensureServer(): Promise<SessionState> {
  const s = readSession();
  // Pre-check the launcher pid BEFORE trusting the WebSocket (see isPidAlive).
  // Without this, a half-dead worker (pid A gone, pid B still serving WS) passes
  // isAlive() and gets reused — the next turn/start then hangs until the RPC
  // ceiling. Checking pid A first fails fast so we spawn a fresh worker.
  if (s && isPidAlive(s.pid) && await isAlive(s)) {
    if (s.threadId && !residentThreadStale) return s;
    const withThread = await ensureResidentThread(s, process.cwd());
    residentThreadStale = false;
    return withThread;
  }
  // The session worker is dead or stale: kill it (best effort) and preserve
  // session metadata long enough for restart budget/backoff.
  let restartMeta: Pick<SessionState, "workerEpoch" | "restartCount" | "restartedAt"> | undefined;
  if (s) {
    const now = Date.now();
    const restartCountInWindow = now - s.restartedAt < RESTART_WINDOW_MS ? s.restartCount : 0;
    if (restartCountInWindow >= RESTART_MAX_IN_WINDOW) {
      throw new WorkerUnavailableError("restart budget exhausted", {
        restartCount: restartCountInWindow,
        startedAt: s.startedAt,
      });
    }
    const backoff = Math.min(
      RESTART_MAX_BACKOFF_MS,
      RESTART_INITIAL_BACKOFF_MS * 2 ** Math.min(restartCountInWindow, 5),
    );
    try { killProcessGroup(s.pid, "SIGKILL"); } catch {}
    await sleep(backoff);
    restartMeta = {
      workerEpoch: s.workerEpoch + 1,
      restartCount: restartCountInWindow + 1,
      restartedAt: now,
    };
    writeSession({ ...s, ...restartMeta });
  }
  residentChild = undefined;
  // Reap leaked workers from previous crashed sessions before spawning a new
  // one, so they stop holding ChatGPT concurrency slots and loopback ports.
  reapOrphanWorkers(null);
  return startWorker(restartMeta);
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
    const timeoutMs = RPC_TIMEOUTS_MS[method] ?? DEFAULT_RPC_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`rpc timeout: ${method}`));
        }
      }, timeoutMs);
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

function stringifyStructured(value: any): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function extractAssistantTextFromItem(item: any): string | null {
  if (!item || item.type === "userMessage" || item.role === "user") return null;
  if (typeof item.text === "string" && item.text.trim()) return item.text;
  if (typeof item.output_text === "string" && item.output_text.trim()) return item.output_text;
  if (typeof item.finalText === "string" && item.finalText.trim()) return item.finalText;
  if (Array.isArray(item.content)) {
    const parts = item.content
      .map((part: any) => typeof part?.text === "string" ? part.text : (typeof part?.output_text === "string" ? part.output_text : ""))
      .filter((text: string) => text.trim().length > 0);
    if (parts.length > 0) return parts.join("\n");
  }
  const type = String(item.type || "").toLowerCase();
  if (type.includes("structured") || type.includes("output") || type.includes("final")) {
    return stringifyStructured(item.output ?? item.value ?? item.result ?? item.data ?? item.content);
  }
  return null;
}


async function rpcTurn(
  client: AppServerClient,
  state: SessionState,
  turnParams: any,
  cwd: string,
  ephemeralThread: boolean,
): Promise<JsonRpcMsg> {
  let resp: JsonRpcMsg;
  try {
    resp = await callRpcAllowError(client, "turn/start", turnParams);
  } catch (e: any) {
    // turn/start timed out — the worker is half-dead (WS up, turn loop wedged).
    // Mark it stale and let runTurn kill+restart+retry instead of waiting the
    // full turn ceiling. This is the main path that used to hang for 120s.
    if (/rpc timeout: turn\/start/i.test(e?.message || "")) {
      residentThreadStale = true;
      if (!ephemeralThread) clearCachedThread(state);
      throw new WorkerStaleError(`turn/start timed out — worker wedged: ${e?.message || e}`, state.workerEpoch);
    }
    throw e;
  }
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
  workerEpoch?: number;
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
  const turnEpoch = state.workerEpoch;

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
    const seenItemIds = new Set<string>();
    let done = false;
    let lastToolCompletionAt = 0;
    let workerDied = false;
    let lastNotificationAt = Date.now();
    let turnId = "unknown";

    // Event-driven turn completion (mirrors the official codex-plugin-cc
    // captureTurn model: resolve a single promise when the turn finishes, instead
    // of while()+sleep() polling). The turn ends on the first of:
    //   - turn/completed notification (normal path)
    //   - worker WS close/error (worker died cleanly, e.g. B exited)
    //   - postToolQuiet: 90s of silence after the last tool call (send interrupt)
    //   - parentPidGone: launcher A died mid-turn (half-dead B, WS still open)
    //   - ceiling: hard turnCeiling timeout (last resort)
    // The onNotification handler and WS listeners are registered BEFORE rpcTurn
    // so a worker death during turn/start itself is captured here, not lost.
    const turnFinished = new Promise<{ reason: string | null }>((resolve) => {
      let settled = false;
      const finish = (reason: string | null) => {
        if (settled) return;
        settled = true;
        resolve({ reason });
      };

      // Worker death via the WebSocket itself (clean exit of the codex binary).
      client.ws.addEventListener("close", () => { workerDied = true; finish("workerDied"); });
      client.ws.addEventListener("error", () => { workerDied = true; finish("workerDied"); });

      // Notification stream: collect items, mark done on turn/completed, and
      // arm a postToolQuiet timer that fires if the worker goes silent for 90s
      // after finishing a tool (a common hang where the turn loop stalls but the
      // WS stays open). The timer is reset on every tool completion.
      let postToolTimer: ReturnType<typeof setTimeout> | null = null;
      const armPostToolQuiet = () => {
        if (postToolQuietMs <= 0) return;
        if (postToolTimer) clearTimeout(postToolTimer);
        postToolTimer = setTimeout(() => {
          if (settled || done || workerDied) return;
          sendTurnInterrupt(client, turnId);
          residentThreadStale = true;
          finish("postToolQuiet");
        }, postToolQuietMs);
        postToolTimer.unref?.();
      };

      const collectItem = (item: any) => {
        const itemKey = item?.id ? String(item.id) : "";
        if (itemKey && seenItemIds.has(itemKey)) return;
        if (itemKey) seenItemIds.add(itemKey);
        rawItems.push(item);
        const text = extractAssistantTextFromItem(item);
        if (text) {
          messages.push(text);
        }
        if (item?.type === "imageGeneration") {
          imageGeneration.push({
            status: item.status,
            result: item.result || "",
            savedPath: item.savedPath || undefined,
          });
        }
        if (isToolShapedItem(item)) {
          lastToolCompletionAt = Date.now();
          armPostToolQuiet();
        }
      };

      client.onNotification((m) => {
        const now = Date.now();
        // The epoch-staleness guard detects a resident-worker restart by
        // comparing this turn's epoch against the on-disk resident epoch.
        // It is meaningless — and actively harmful — for transient workers
        // (image / test), which own their own process and never share the
        // resident session.json epoch. For them turnEpoch (1) would always be
        // less than the resident epoch (climbs across restarts), so the guard
        // would fire on every notification and abort every transient turn.
        if (!state.transient) {
          const currentEpoch = readSession()?.workerEpoch ?? turnEpoch;
          if (currentEpoch > turnEpoch) {
            residentThreadStale = true;
            finish("workerEpochChanged");
            return;
          }
        }
        lastNotificationAt = now;
        if (m.method === "item/completed") {
          collectItem(m.params?.item || {});
        } else if (m.method === "turn/completed") {
          const turn = m.params?.turn || {};
          rawItems.push({ type: "turnCompleted", turn });
          if (Array.isArray(turn.items)) {
            for (const item of turn.items) collectItem(item);
          } else {
            const text = extractAssistantTextFromItem(turn);
            if (text) messages.push(text);
          }
          done = true;
          finish("turn/completed");
        }
      });

      // Dual-process guard: codex runs as node-launcher (pid A = session.pid) +
      // codex-binary (pid B = the WS server). Killing A alone does not close the
      // WS (B keeps serving), so workerDied never fires. The official plugin
      // avoids this because it spawns codex as its own child and gets the exit
      // event directly; this resident model spans CLI invocations and can't, so
      // we poll pid A liveness on a light unref'd interval. If A is gone the
      // worker is wedged — finish and let runTurn's WorkerStaleError retry.
      const livenessTimer = setInterval(() => {
        if (settled || done || workerDied) return;
        if (state.pid && !isPidAlive(state.pid)) { finish("parentPidGone"); return; }
        // isWorkerAlive() reads a module-level residentChild that is undefined
        // across CLI invocations (always returns true), so it never fires here —
        // kept only as a defensive in-process check.
        if (!isWorkerAlive()) finish("isWorkerAlive=false");
      }, notificationPollMs);
      livenessTimer.unref?.();

      // Hard ceiling: last-resort timeout so a wedged turn can never run forever.
      const ceilingTimer = setTimeout(() => finish("ceiling"), turnCeiling);
      ceilingTimer.unref?.();
    });

    const turnParams: any = { threadId, input };
    if (opts.cwd) turnParams.cwd = opts.cwd;
    if (opts.outputSchema) turnParams.outputSchema = opts.outputSchema;
    if (modelOpts.model) turnParams.model = modelOpts.model;
    if (modelOpts.effort) turnParams.effort = modelOpts.effort;
    if (modelOpts.serviceTier) turnParams.serviceTier = modelOpts.serviceTier;

    const turnResp = await rpcTurn(client, state, turnParams, cwd, ephemeralThread);
    turnId = turnResp.result?.turn?.id || turnResp.result?.turnId || "unknown";
    const startedAt = Date.now();

    const { reason: breakReason } = await turnFinished;

    if (breakReason === "workerEpochChanged") {
      throw new WorkerStaleError(`worker epoch advanced from ${turnEpoch}`, turnEpoch);
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
  let state = await ensureServer();
  try {
    const result = await runTurnOnState(state, input, opts, DEFAULT_TURN_CEILING_MS);
    result.workerEpoch = state.workerEpoch;
    return result;
  } catch (e) {
    // A wedged resident worker raises WorkerStaleError from rpcTurn (turn/start
    // timed out). Kill it, let ensureServer apply restart budget/backoff, and
    // retry the turn exactly once.
    if (e instanceof WorkerStaleError) {
      const oldEpoch = e.workerEpoch ?? state.workerEpoch;
      const stale = readSession();
      if (stale && stale.workerEpoch <= oldEpoch) {
        try { killProcessGroup(stale.pid, "SIGKILL"); } catch {}
        residentChild = undefined;
      }
      state = await ensureServer();
      const result = await runTurnOnState(state, input, opts, DEFAULT_TURN_CEILING_MS);
      result.workerEpoch = state.workerEpoch;
      return result;
    }
    throw e;
  }
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
      // Override the default workspace-write from workerArgs when browser or
      // full access is requested. codex applies repeated -c keys last-wins, so
      // this correctly overrides the base sandbox_mode for the test worker.
      ...(browser || fullAccess ? ["-c", `sandbox_mode=\"${sandboxMode}\"`] : []),
    ];

    if (browser) {
      args.push(
        "-c", "features.browser_use=true",
        "-c", "features.browser_use_external=true",
        "-c", "features.plugins=true",
        "-c", 'plugins={"browser@openai-bundled"={enabled=true},"chrome@openai-bundled"={enabled=true}}',
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
    workerEpoch: 1,
    restartCount: 0,
    restartedAt: Date.now(),
    dispatchCount: 0,
    // One-shot test worker is NOT the resident worker; skip the resident-epoch
    // staleness guard (see SessionState.transient).
    transient: true,
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
