#!/usr/bin/env -S node --experimental-strip-types

import { spawn } from "child_process";
import { randomUUID } from "node:crypto";
import { existsSync, accessSync, constants, readFileSync, statSync, writeFileSync, unlinkSync, mkdirSync, renameSync, readdirSync, openSync, closeSync } from "node:fs";
import path, { basename, extname, isAbsolute, resolve } from "node:path";
import { pluginDataDir } from "./app_server_pool.ts";

type RunResult = {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
};

type GptProStatus = "starting" | "submitted" | "running" | "generating" | "timed-out" | "completed" | "failed" | "stale" | "cancelled";

type GptProTask = {
  schemaVersion?: 1 | 2;
  taskId?: string;
  command?: "ask" | "continue";
  conversationUrl?: string;
  conversationId?: string;
  prompt?: string;
  promptFile?: string;
  files?: string[];
  baselineCount?: number;
  sentAt?: number;
  createdAt?: number;
  updatedAt?: number;
  startedAt?: number;
  submittedAt?: number;
  finishedAt?: number;
  timeoutSec?: number;
  deadlineAt?: number;
  absoluteCeilingAt?: number;
  pid?: number;
  heartbeatAt?: number;
  status: GptProStatus;
  outPath?: string;
  resultPath?: string;
  partialPath?: string;
  logPath?: string;
  partialText?: string;
  summary?: string;
  lastError?: string;
  exitCode?: number | null;
};

type AskArgs = {
  prompt: string;
  files: string[];
  out?: string;
  timeoutSec: number;
  force?: boolean;
  url?: string;
};

type WaitOutcome = {
  status: "completed" | "timed-out";
  text: string;
  lastText: string;
  finalDeadline: number;
};

const FALLBACK_OPENCLI = "/opt/homebrew/bin/opencli";
const MAX_FILE_BYTES = 200 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function isImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

const CHATGPT_URL = "https://chatgpt.com";
const MAX_AUTO_EXTEND_MS = 1800000; // hard ceiling for dynamic deadline extension (30 min beyond initial timeout)
const ASSISTANT_COUNT_JS = "(()=>document.querySelectorAll('[data-message-author-role=assistant]').length)()";
const EXTRACT_CONVERSATION_URL_JS =
  "(()=>{return JSON.stringify({url:location.href,pathname:location.pathname});})()";
const EXTRACT_NEW_ASSISTANT_JS =
  "(()=>{const m=[...document.querySelectorAll('[data-message-author-role=assistant]')];const count=m.length;return JSON.stringify({count,text:count?m[count-1].innerText:''});})()";
const IS_GENERATING_JS =
  "(()=>Boolean(document.querySelector('button[data-testid=\"stop-button\"],button[aria-label*=\"停止\"],button[aria-label*=\"Stop\"]')))()";
const SUBMIT_PROMPT_JS =
  "(()=>{const b=document.querySelector('[data-testid=\"send-button\"],button[aria-label*=\"发送\"],button[aria-label*=\"Send\"]');if(!b)return JSON.stringify({ok:false,error:'missing send button'});if(b.disabled||b.getAttribute('aria-disabled')==='true')return JSON.stringify({ok:false,error:'send button disabled'});b.click();return JSON.stringify({ok:true});})()";
const PROMPT_SENT_JS =
  "(()=>{const generating=Boolean(document.querySelector('button[data-testid=\"stop-button\"],button[aria-label*=\"停止\"],button[aria-label*=\"Stop\"]'));const assistantCount=document.querySelectorAll('[data-message-author-role=assistant]').length;const composer=(document.querySelector('#prompt-textarea')?.innerText||'').trim();return JSON.stringify({sent:generating||assistantCount>0||location.pathname.startsWith('/c/'),generating,assistantCount,composerLength:composer.length});})()";
const CLEAR_COMPOSER_JS =
  "(()=>{const el=document.querySelector('#prompt-textarea');if(!el)return JSON.stringify({ok:false,error:'missing composer'});el.innerHTML='';el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward',data:null}));const textarea=document.querySelector('textarea[name=\"prompt-textarea\"]');if(textarea){textarea.value='';textarea.dispatchEvent(new Event('input',{bubbles:true}));}const input=document.querySelector('#upload-files');if(input){input.files=new DataTransfer().files;input.dispatchEvent(new Event('change',{bubbles:true}));}for(const b of [...document.querySelectorAll('[aria-label*=\"移除文件\"],[aria-label*=\"Remove file\"],[aria-label*=\"remove file\"]')]){b.click();}return JSON.stringify({ok:true});})()";

function legacyTaskPath(): string {
  return path.join(pluginDataDir(), "gpt-pro-task.json");
}

function taskDir(): string {
  return path.join(pluginDataDir(), "gpt-pro", "tasks");
}

function latestTaskPointerPath(): string {
  return path.join(pluginDataDir(), "gpt-pro", "latest-task.json");
}

function startLockPath(): string {
  return path.join(pluginDataDir(), "gpt-pro", "start.lock");
}

function safeTaskId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
  if (!cleaned) throw new Error("invalid empty gpt-pro task id");
  return cleaned;
}

function taskPathForId(taskId: string): string {
  return path.join(taskDir(), `${safeTaskId(taskId)}.json`);
}

function taskPath(): string {
  return process.env.GPT_PRO_TASK_FILE || legacyTaskPath();
}

function normalizeTask(raw: any): GptProTask | null {
  if (!raw || typeof raw !== "object") return null;
  if (!raw.status) raw.status = raw.conversationUrl ? "generating" : "starting";
  if (!raw.schemaVersion) raw.schemaVersion = 1;
  return raw as GptProTask;
}

function readTaskFile(filePath = taskPath()): GptProTask | null {
  try {
    if (!existsSync(filePath)) return null;
    return normalizeTask(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

function readTask(): GptProTask | null {
  return readTaskFile(taskPath());
}

function writeTaskFile(filePath: string, t: GptProTask): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const next: GptProTask = { ...t, updatedAt: Date.now() };
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, filePath);
}

function writeTask(t: GptProTask): void {
  writeTaskFile(taskPath(), t);
}

function patchTaskFile(filePath: string, patch: Partial<GptProTask>): GptProTask {
  const existing = readTaskFile(filePath) || { status: "starting" as GptProStatus };
  const next = { ...existing, ...patch } as GptProTask;
  writeTaskFile(filePath, next);
  return next;
}

function patchTask(patch: Partial<GptProTask>): GptProTask {
  return patchTaskFile(taskPath(), patch);
}

function isPidAlive(pid?: number): boolean {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const TERMINAL_TASK_STATUSES = new Set<GptProStatus>(["completed", "timed-out", "failed", "stale", "cancelled"]);

function isTerminalTaskStatus(status?: string): boolean {
  return TERMINAL_TASK_STATUSES.has(status as GptProStatus);
}

function touchTaskHeartbeat(status?: GptProStatus): void {
  const task = readTask();
  if (!task || isTerminalTaskStatus(task.status)) return;
  task.heartbeatAt = Date.now();
  task.pid = process.pid;
  if (status) task.status = status;
  writeTask(task);
}

function clearTask(): void {
  try { unlinkSync(taskPath()); } catch {}
}

function absolutePathMaybe(p?: string): string | undefined {
  if (!p) return undefined;
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

function isBackgroundWorker(): boolean {
  return process.env.GPT_PRO_BACKGROUND_WORKER === "1";
}

// ponytail: incremental-flush state for SIGTERM recovery. waitForAssistantReply updates this on every grow-flush so a SIGTERM handler can do one final save before exit.
let pendingPartial: { text: string; out?: string } | null = null;

// ponytail: incremental flush — write the current cumulative assistant text to the --out file (overwrite) and to the task file's partialText field. Called on every content GROWTH inside the polling loop so a kill mid-generation still leaves recoverable content on disk. Does NOT touch stdout (stdout emits a pointer only, see writeAssistantOutput).
function flushPartial(text: string, out?: string): void {
  if (!text) return;
  pendingPartial = { text, out };
  const absoluteOut = absolutePathMaybe(out);
  if (absoluteOut) {
    try {
      mkdirSync(path.dirname(absoluteOut), { recursive: true });
      writeFileSync(absoluteOut, text, "utf8");
    } catch (e) {
      process.stderr.write(`gpt-pro: incremental flush to ${absoluteOut} failed: ${(e as Error).message}\n`);
    }
  }
  const task = readTask();
  if (task && task.status !== "completed") {
    task.partialText = text;
    task.partialPath = absoluteOut || task.partialPath;
    task.outPath = absoluteOut || task.outPath;
    task.heartbeatAt = Date.now();
    if (task.status === "starting" || task.status === "submitted") task.status = "running";
    writeTask(task);
  }
}

function usage(): string {
  return [
    "Usage:",
    "  gpt_pro.ts help",
    "  gpt_pro.ts status",
    "  gpt_pro.ts start ask [<prompt> | --prompt-file <file>] [--file <path> ...] [--out <file>] [--timeout <sec>]",
    "  gpt_pro.ts start continue [--task-id <id> | --url <url>] [--timeout <sec>] [--out <file>]",
    "  gpt_pro.ts poll [--task-id <id> | --task-file <file>]",
    "  gpt_pro.ts collect [--task-id <id> | --task-file <file>] [--partial]",
    "  gpt_pro.ts cancel [--task-id <id> | --task-file <file>]",
    "      Background mode: start returns TASK_ID/TASK_FILE/RESULT_FILE immediately;",
    "      poll/collect/cancel read or update task files and keep stdout compact.",
    "  gpt_pro.ts ask [<prompt> | --prompt-file <file>] [--file <path> ...] [--out <file>] [--timeout <sec>]",
    "  gpt_pro.ts continue [--url <url>] [--timeout <sec>] [--out <file>]",
    "      Foreground compatibility mode. Resume a timed-out gpt-pro conversation: reopen its saved /c/<id> URL and",
    "      wait for the SAME reply instead of re-dispatching the prompt. ask refuses",
    "      to re-dispatch while an unfinished task (generating/timed-out, within 2h)",
    "      is on record; pass --force to ask to discard it.",
    "",
    "Environment:",
    "  OPENCLI_BIN  Path to opencli binary. Defaults to PATH lookup, then /opt/homebrew/bin/opencli.",
  ].join("\n");
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

function summarizeTaskText(text: string, maxWords = 80): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "(no output)";
  return normalized.split(" ").slice(0, maxWords).join(" ");
}

function printLine(key: string, value: unknown): void {
  if (value === undefined || value === null || value === "") return;
  process.stdout.write(`${key}:${String(value)}\n`);
}

function canExecute(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveOpencliBin(): string {
  if (process.env.OPENCLI_BIN) {
    return process.env.OPENCLI_BIN;
  }

  const pathValue = process.env.PATH || "";
  for (const entry of pathValue.split(":")) {
    if (!entry) {
      continue;
    }
    const candidate = resolve(entry, "opencli");
    if (existsSync(candidate) && canExecute(candidate)) {
      return candidate;
    }
  }

  return FALLBACK_OPENCLI;
}

const opencliBin = resolveOpencliBin();

function runCommand(bin: string, args: string[], timeoutMs = 60000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      encoding: "utf8",
      shell: false,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
    }, timeoutMs);
    const finish = (status: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: stdout || "",
        stderr: stderr || "",
        status: timedOut ? null : status,
        error: error || (timedOut ? new Error(`command timed out after ${timeoutMs}ms`) : undefined),
      });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 10 * 1024 * 1024) {
        stdout = stdout.slice(-5 * 1024 * 1024);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 10 * 1024 * 1024) {
        stderr = stderr.slice(-5 * 1024 * 1024);
      }
    });
    child.on("close", (code: number | null) => finish(code));
    child.on("error", (e: Error) => finish(null, e));
  });
}

function opencliTimeoutMs(args: string[]): number {
  if (args[0] === "doctor") {
    return 15000;
  }
  if (args[0] === "browser") {
    switch (args[1]) {
      case "state":
      case "wait":
      case "type":
      case "keys":
      case "click":
      case "open":
        return 30000;
      case "eval":
        return 45000;
    }
  }
  return 60000;
}

async function runOpencli(args: string[], timeoutMs = opencliTimeoutMs(args)): Promise<RunResult> {
  return await runCommand(opencliBin, args, timeoutMs);
}

async function runOpencliWithinDeadline(args: string[], deadline: number): Promise<RunResult> {
  requireBeforeDeadline(deadline, `opencli ${args.join(" ")}`);
  const remainingMs = Math.max(1, deadline - Date.now());
  return await runOpencli(args, Math.min(opencliTimeoutMs(args), remainingMs));
}

function outputOf(result: RunResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

function commandFailed(result: RunResult): boolean {
  return Boolean(result.error) || result.status !== 0;
}

function isBridgeConnected(result: RunResult): boolean {
  if (commandFailed(result)) {
    return false;
  }
  const text = outputOf(result);
  if (/\bnot\s+connected(?:\s+in)?\b/i.test(text) || /\bdisconnected\b/i.test(text)) {
    return false;
  }
  return /\bBridge\b[\s\S]*\bconnected\b/i.test(text) || /\bconnected\b/i.test(text);
}

async function stateText(deadline?: number): Promise<RunResult> {
  const args = ["browser", "state"];
  return deadline === undefined ? await runOpencli(args) : await runOpencliWithinDeadline(args, deadline);
}

function findComposerIndex(state: string): string | null {
  const lines = state.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/\[(\d+)\]<[^>]*\bid=prompt-textarea\b[^>]*\brole=textbox\b/i);
    if (match) {
      return match[1];
    }
  }

  for (const line of lines) {
    const match = line.match(/\[(\d+)\]<[^>]*\brole=textbox\b[^>]*\bid=prompt-textarea\b/i);
    if (match) {
      return match[1];
    }
  }

  return null;
}

function parseStatusState(state: string): { loggedIn: boolean; plan: "pro" | false } {
  const lines = state.split(/\r?\n/);
  const profileIndex = lines.findIndex((line) => /accounts-profile-button/i.test(line));
  if (profileIndex === -1) {
    return { loggedIn: false, plan: false };
  }

  const nearby = lines.slice(Math.max(0, profileIndex - 5), profileIndex + 8).join("\n");
  return {
    loggedIn: true,
    plan: /\bPro\b/i.test(nearby) ? "pro" : false,
  };
}

async function statusCommand(): Promise<number> {
  const doctor = await runOpencli(["doctor"]);
  const bridge = isBridgeConnected(doctor);
  let loggedIn = false;
  let plan: "pro" | false = false;

  try {
    const opened = await runOpencli(["browser", "open", CHATGPT_URL]);
    if (commandFailed(opened)) {
      throw new Error(opened.error?.message || opened.stderr || "opencli browser open failed");
    }

    const waited = await runOpencli(["browser", "wait", "time", "5"]);
    if (commandFailed(waited)) {
      throw new Error(waited.error?.message || waited.stderr || "opencli browser wait failed");
    }

    const state = await stateText();
    if (commandFailed(state)) {
      throw new Error(state.error?.message || state.stderr || "opencli browser state failed");
    }

    const parsed = parseStatusState(state.stdout || state.stderr);
    loggedIn = parsed.loggedIn;
    plan = parsed.plan;

    process.stdout.write(`${JSON.stringify({ bridge, loggedIn, plan })}\n`);
    return bridge ? 0 : 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(message);
    process.stdout.write(`${JSON.stringify({ bridge, loggedIn, plan, error: message })}\n`);
    return 2;
  }
}

function parseAskArgs(args: string[]): AskArgs {
  let prompt: string | undefined;
  let promptFile: string | undefined;
  const files: string[] = [];
  let out: string | undefined;
  let force = false;
  let url: string | undefined;
  let timeoutSec = 900;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--force") {
      force = true;
      continue;
    }

    if (arg === "--url") {
      const value = args[i + 1];
      if (!value) {
        throw new Error("missing value for --url");
      }
      url = value;
      i += 1;
      continue;
    }

    if (arg === "--prompt-file") {
      const value = args[i + 1];
      if (!value) {
        throw new Error("missing value for --prompt-file");
      }
      promptFile = value;
      i += 1;
      continue;
    }

    if (arg === "--out") {
      const value = args[i + 1];
      if (!value) {
        throw new Error("missing value for --out");
      }
      out = value;
      i += 1;
      continue;
    }

    if (arg === "--file") {
      const value = args[i + 1];
      if (!value) {
        throw new Error("missing value for --file");
      }
      files.push(value);
      i += 1;
      continue;
    }

    if (arg === "--timeout") {
      const value = args[i + 1];
      if (!value) {
        throw new Error("missing value for --timeout");
      }
      timeoutSec = Number(value);
      if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
        throw new Error("--timeout must be a positive number of seconds");
      }
      i += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`unknown argument: ${arg}`);
    }

    if (prompt !== undefined) {
      throw new Error(`unknown argument: ${arg}`);
    }
    prompt = arg;
  }

  if (promptFile) {
    prompt = readFileSync(promptFile, "utf8");
  }

  if ((prompt === undefined || prompt.length === 0) && files.length === 0) {
    throw new Error("missing prompt or file");
  }

  return { prompt: prompt || "", files, out, timeoutSec, force, url };
}

function requireSuccess(result: RunResult, label: string): void {
  if (!commandFailed(result)) {
    return;
  }

  const details = [
    result.error?.message,
    result.stderr.trim(),
    result.stdout.trim(),
    result.status === null ? "exit status: null" : `exit status: ${result.status}`,
  ]
    .filter(Boolean)
    .join("\n");
  throw new Error(`${label} failed${details ? `\n${details}` : ""}`);
}

function requireBeforeDeadline(deadline: number, label = "operation"): void {
  if (Date.now() >= deadline) {
    throw new Error(`timed out before ${label}`);
  }
}

async function readAssistantSnapshot(deadline?: number): Promise<{ count: number; text: string } | null> {
  const args = ["browser", "eval", EXTRACT_NEW_ASSISTANT_JS];
  const evaluated = deadline === undefined ? await runOpencli(args) : await runOpencliWithinDeadline(args, deadline);
  if (commandFailed(evaluated)) {
    log(`opencli browser eval failed: ${evaluated.error?.message || evaluated.stderr || evaluated.status}`);
    return null;
  }
  try {
    const payload = JSON.parse(evaluated.stdout.trim()) as { count?: number; text?: string };
    return {
      count: typeof payload.count === "number" ? payload.count : 0,
      text: typeof payload.text === "string" ? payload.text.trim() : "",
    };
  } catch {
    log(`assistant extraction returned invalid JSON\n${evaluated.stdout.trim() || evaluated.stderr.trim()}`);
    return null;
  }
}

function writeAssistantOutput(text: string, out?: string): void {
  if (out) {
    // ponytail: long-output stability — when --out is set, the full text lives in the file (durable, survives process kill). stdout emits ONLY a pointer so codex_bridge.ts never has to pipe megabytes of text through Bash's 600s ceiling. The leader reads the result from the file.
    const absoluteOut = absolutePathMaybe(out)!;
    mkdirSync(path.dirname(absoluteOut), { recursive: true });
    writeFileSync(absoluteOut, text, "utf8");
    const task = readTask();
    if (task) {
      task.outPath = absoluteOut;
      task.resultPath = absoluteOut;
      task.partialPath = absoluteOut;
      task.partialText = text;
      task.summary = summarizeTaskText(text);
      task.heartbeatAt = Date.now();
      writeTask(task);
    }
    process.stdout.write(`RESULT_FILE:${absoluteOut}\n`);
    process.stderr.write(`gpt-pro: result saved to ${absoluteOut}\n`);
  } else {
    // backward-compat: no --out → full text to stdout (still subject to transport limits; long tasks should use --out)
    process.stdout.write(`${text}\n`);
  }
}

async function waitForAssistantReply(params: {
  deadline: number;
  absoluteCeiling: number;
  baselineCount: number;
  sentAt: number;
  prevPartial?: string;
  out?: string;
}): Promise<WaitOutcome> {
  let deadline = params.deadline;
  const resumeMode = Object.prototype.hasOwnProperty.call(params, "prevPartial");
  const generationStartDeadline = Math.min(deadline, params.sentAt + 30000);
  let sawGenerating = false;
  let lastText = "";
  let currentText = "";
  let currentCount = params.baselineCount;
  let stableReads = 0;

  let lastFlushedText = "";
  const updateSnapshot = (snapshot: { count: number; text: string }): void => {
    currentCount = snapshot.count;
    currentText =
      snapshot.count > params.baselineCount || (resumeMode && snapshot.count >= params.baselineCount)
        ? snapshot.text
        : "";
    // ponytail: flush incrementally on content growth — page jitter can momentarily shorten currentText, so only write when it genuinely grew past the last flush. This is what makes a SIGTERM/timeout kill recoverable: the most recent grown snapshot is already on disk.
    if (currentText && currentText !== lastFlushedText && currentText.length > lastFlushedText.length) {
      flushPartial(currentText, params.out);
      lastFlushedText = currentText;
    }
  };
  const acceptable = (text: string): boolean => {
    if (!text) {
      return false;
    }
    return params.prevPartial === undefined || text !== params.prevPartial;
  };
  const currentDeadline = (): number => (Date.now() < deadline ? deadline : params.absoluteCeiling);

  while (Date.now() < generationStartDeadline) {
    touchTaskHeartbeat("running");
    const generating = await runOpencliWithinDeadline(["browser", "eval", IS_GENERATING_JS], deadline);
    if (!commandFailed(generating) && generating.stdout.trim() === "true") {
      sawGenerating = true;
      break;
    }
    if (commandFailed(generating)) {
      log(`opencli browser eval failed: ${generating.error?.message || generating.stderr || generating.status}`);
    }

    const snapshot = await readAssistantSnapshot(deadline);
    if (snapshot) {
      updateSnapshot(snapshot);
    }

    if (Date.now() < generationStartDeadline) {
      const waited = await runOpencliWithinDeadline(["browser", "wait", "time", "2"], deadline);
      if (commandFailed(waited)) {
        log(`opencli browser wait failed: ${waited.error?.message || waited.stderr || waited.status}`);
      }
    }
  }

  while (Date.now() < params.absoluteCeiling) {
    touchTaskHeartbeat("running");
    const operationDeadline = currentDeadline();
    const generating = await runOpencliWithinDeadline(["browser", "eval", IS_GENERATING_JS], operationDeadline);
    if (!commandFailed(generating) && generating.stdout.trim() === "true") {
      sawGenerating = true;
      if (Date.now() >= deadline && Date.now() < params.absoluteCeiling) {
        deadline = Math.min(params.absoluteCeiling, deadline + 120000);
        log(`extending deadline (still generating): +120s, new total budget ${Math.round((deadline - params.sentAt) / 1000)}s`);
      }
      const waited = await runOpencliWithinDeadline(["browser", "wait", "time", "2"], deadline);
      if (commandFailed(waited)) {
        log(`opencli browser wait failed: ${waited.error?.message || waited.stderr || waited.status}`);
      }
      continue;
    }
    if (commandFailed(generating)) {
      log(`opencli browser eval failed: ${generating.error?.message || generating.stderr || generating.status}`);
    }

    const snapshot = await readAssistantSnapshot(operationDeadline);
    if (snapshot) {
      updateSnapshot(snapshot);
    }

    if (sawGenerating) {
      if (acceptable(currentText)) {
        writeAssistantOutput(currentText, params.out);
        return { status: "completed", text: currentText, lastText, finalDeadline: deadline };
      }
    } else if (currentText) {
      stableReads = currentText === lastText ? stableReads + 1 : 1;
      lastText = currentText;
      if (stableReads >= 3 && Date.now() - params.sentAt >= 20000 && acceptable(currentText)) {
        writeAssistantOutput(currentText, params.out);
        return { status: "completed", text: currentText, lastText, finalDeadline: deadline };
      }
    }

    if (Date.now() < deadline) {
      const waited = await runOpencliWithinDeadline(["browser", "wait", "time", "2"], deadline);
      if (commandFailed(waited)) {
        log(`opencli browser wait failed: ${waited.error?.message || waited.stderr || waited.status}`);
      }
    } else if (Date.now() < params.absoluteCeiling) {
      // Past the initial deadline but within the auto-extend window: avoid a
      // tight spin while waiting for the next generating/stable check.
      const waited = await runOpencliWithinDeadline(["browser", "wait", "time", "2"], params.absoluteCeiling);
      if (commandFailed(waited)) {
        log(`opencli browser wait failed: ${waited.error?.message || waited.stderr || waited.status}`);
      }
    }
  }

  return {
    status: "timed-out",
    text: currentText || lastText || "",
    lastText,
    finalDeadline: deadline,
  };
}

function mimeTypeForPath(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".ts":
    case ".tsx":
      return "text/x-typescript";
    case ".js":
    case ".jsx":
      return "text/javascript";
    case ".py":
      return "text/x-python";
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "text/plain";
  }
}

async function uploadFiles(filePaths: string[], deadline: number): Promise<void> {
  requireBeforeDeadline(deadline, "clear uploads");
  const clearJs = `(()=>{const i=document.querySelector('#upload-files');if(i){const dt=new DataTransfer();i.files=dt.files;i.dispatchEvent(new Event('change',{bubbles:true}));}return JSON.stringify({ok:true,remaining:i&&i.files?i.files.length:0});})()`;
  const cleared = await runOpencliWithinDeadline(["browser", "eval", clearJs], deadline);
  requireSuccess(cleared, "opencli browser eval clear uploads");
  requireBeforeDeadline(deadline, "wait after clear uploads");
  requireSuccess(await runOpencliWithinDeadline(["browser", "wait", "time", "2"], deadline), "opencli browser wait after clear uploads");
  let clearPayload: { remaining?: number };
  try {
    clearPayload = JSON.parse(cleared.stdout.trim());
  } catch {
    throw new Error(`clear uploads returned invalid JSON\n${cleared.stdout.trim() || cleared.stderr.trim()}`);
  }
  if ((clearPayload.remaining || 0) > 0) {
    log(`warning: could not fully clear existing attachments, remaining=${clearPayload.remaining}`);
  }

  for (const filePath of filePaths) {
    requireBeforeDeadline(deadline, `upload ${basename(filePath)}`);
    const stat = statSync(filePath);
    const name = basename(filePath);
    const mimeType = mimeTypeForPath(filePath);
    const image = isImagePath(filePath);
    if (image) {
      // ponytail: images are binary — read as Buffer, base64-encode, reconstruct as Uint8Array in the browser. Bypasses the text-only NUL check and uses a larger 10MB limit.
      if (stat.size > MAX_IMAGE_BYTES) {
        throw new Error(`image too large for --file (max 10MB): ${filePath} (${stat.size} bytes)`);
      }
      const b64 = readFileSync(filePath).toString("base64");
      const js = `(()=>{const i=document.querySelector('#upload-files');if(!i)return JSON.stringify({ok:false,error:'missing #upload-files'});const dt=new DataTransfer();for(const file of Array.from(i.files||[])){dt.items.add(file);}const b64=${JSON.stringify(b64)};const bin=atob(b64);const bytes=new Uint8Array(bin.length);for(let k=0;k<bin.length;k++){bytes[k]=bin.charCodeAt(k);}dt.items.add(new File([bytes],${JSON.stringify(name)},{type:${JSON.stringify(mimeType)}}));i.files=dt.files;i.dispatchEvent(new Event('change',{bubbles:true}));return JSON.stringify({ok:true,name:${JSON.stringify(name)},size:${stat.size}});})()`;
      const uploaded = await runOpencliWithinDeadline(["browser", "eval", js], deadline);
      requireSuccess(uploaded, `opencli browser eval upload image ${name}`);
      let payload: { ok?: boolean; error?: string };
      try {
        payload = JSON.parse(uploaded.stdout.trim());
      } catch {
        throw new Error(`upload image ${name} returned invalid JSON\n${uploaded.stdout.trim() || uploaded.stderr.trim()}`);
      }
      if (!payload.ok) {
        throw new Error(`upload image ${name} failed${payload.error ? `: ${payload.error}` : ""}`);
      }
      requireBeforeDeadline(deadline, `wait after upload ${name}`);
      requireSuccess(await runOpencliWithinDeadline(["browser", "wait", "time", "2"], deadline), "opencli browser wait after upload");
      continue;
    }
    // text path (original logic)
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`file too large for --file (max 200KB): ${filePath} (${stat.size} bytes)`);
    }
    const prefix = readFileSync(filePath).subarray(0, 8192);
    if (prefix.includes(0x00)) {
      throw new Error(`binary file not supported by --file (text only): ${filePath}`);
    }
    const content = readFileSync(filePath, "utf8");
    const js = `(()=>{const i=document.querySelector('#upload-files');if(!i)return JSON.stringify({ok:false,error:'missing #upload-files'});const dt=new DataTransfer();for(const file of Array.from(i.files||[])){dt.items.add(file);}dt.items.add(new File([${JSON.stringify(content)}],${JSON.stringify(name)},{type:${JSON.stringify(mimeType)}}));i.files=dt.files;i.dispatchEvent(new Event('change',{bubbles:true}));return JSON.stringify({ok:true,name:${JSON.stringify(name)},size:${Buffer.byteLength(content, "utf8")}});})()`;
    const uploaded = await runOpencliWithinDeadline(["browser", "eval", js], deadline);
    requireSuccess(uploaded, `opencli browser eval upload ${name}`);
    let payload: { ok?: boolean; error?: string };
    try {
      payload = JSON.parse(uploaded.stdout.trim());
    } catch {
      throw new Error(`upload ${name} returned invalid JSON\n${uploaded.stdout.trim() || uploaded.stderr.trim()}`);
    }
    if (!payload.ok) {
      throw new Error(`upload ${name} failed${payload.error ? `: ${payload.error}` : ""}`);
    }
    requireBeforeDeadline(deadline, `wait after upload ${name}`);
    requireSuccess(await runOpencliWithinDeadline(["browser", "wait", "time", "2"], deadline), "opencli browser wait after upload");
  }

  requireBeforeDeadline(deadline, "upload verification");
  const expectedNames = filePaths.map((filePath) => basename(filePath));
  const verifyJs = `(()=>{const input=document.querySelector('#upload-files');const filesLength=input&&input.files?input.files.length:0;const bodyText=document.body?document.body.innerText:'';const elements=[...document.querySelectorAll('[aria-label]')].map((el)=>el.getAttribute('aria-label')||'');const hasRemove=elements.some((label)=>label.includes('移除')||label.includes('Remove')||label.includes('remove'));const names=${JSON.stringify(expectedNames)};const missingNames=names.filter((name)=>!bodyText.includes(name)&&!elements.some((label)=>label.includes(name)));return JSON.stringify({filesLength,expected:${filePaths.length},hasRemove,missingNames});})()`;
  const verified = await runOpencliWithinDeadline(["browser", "eval", verifyJs], deadline);
  requireSuccess(verified, "opencli browser eval upload verification");
  let payload: { filesLength?: number; expected?: number; hasRemove?: boolean; missingNames?: string[] };
  try {
    payload = JSON.parse(verified.stdout.trim());
  } catch {
    throw new Error(`upload verification returned invalid JSON\n${verified.stdout.trim() || verified.stderr.trim()}`);
  }
  if (payload.filesLength !== filePaths.length) {
    throw new Error(`upload verification failed: files.length=${payload.filesLength}, expected=${filePaths.length}`);
  }
  if (!payload.hasRemove && payload.missingNames && payload.missingNames.length > 0) {
    throw new Error(`upload verification failed: missing uploaded file UI for ${payload.missingNames.join(", ")}`);
  }
}

async function sendPrompt(deadline: number): Promise<void> {
  requireBeforeDeadline(deadline, "send prompt");
  requireSuccess(await runOpencliWithinDeadline(["browser", "keys", "Enter"], deadline), "opencli browser keys Enter");
  requireBeforeDeadline(deadline, "wait after Enter");
  requireSuccess(await runOpencliWithinDeadline(["browser", "wait", "time", "1"], deadline), "opencli browser wait after Enter");

  requireBeforeDeadline(deadline, "prompt sent check");
  const sentCheck = await runOpencliWithinDeadline(["browser", "eval", PROMPT_SENT_JS], deadline);
  requireSuccess(sentCheck, "opencli browser eval prompt sent check");
  let sentPayload: { sent?: boolean; composerLength?: number };
  try {
    sentPayload = JSON.parse(sentCheck.stdout.trim());
  } catch {
    throw new Error(`prompt sent check returned invalid JSON\n${sentCheck.stdout.trim() || sentCheck.stderr.trim()}`);
  }
  if (sentPayload.sent || sentPayload.composerLength === 0) {
    return;
  }

  let lastError = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    requireBeforeDeadline(deadline, "click send");
    const submitted = await runOpencliWithinDeadline(["browser", "eval", SUBMIT_PROMPT_JS], deadline);
    requireSuccess(submitted, "opencli browser eval click send");
    let submitPayload: { ok?: boolean; error?: string };
    try {
      submitPayload = JSON.parse(submitted.stdout.trim());
    } catch {
      throw new Error(`click send returned invalid JSON\n${submitted.stdout.trim() || submitted.stderr.trim()}`);
    }
    if (submitPayload.ok) {
      return;
    }
    lastError = submitPayload.error || "unknown error";
    requireBeforeDeadline(deadline, "wait for send button");
    requireSuccess(await runOpencliWithinDeadline(["browser", "wait", "time", "1"], deadline), "opencli browser wait for send button");
  }
  throw new Error(`click send failed${lastError ? `: ${lastError}` : ""}`);
}

async function clearComposer(deadline?: number): Promise<void> {
  const args = ["browser", "eval", CLEAR_COMPOSER_JS];
  const cleared = deadline === undefined ? await runOpencli(args) : await runOpencliWithinDeadline(args, deadline);
  requireSuccess(cleared, "opencli browser eval clear composer");
  let payload: { ok?: boolean; error?: string };
  try {
    payload = JSON.parse(cleared.stdout.trim());
  } catch {
    throw new Error(`clear composer returned invalid JSON\n${cleared.stdout.trim() || cleared.stderr.trim()}`);
  }
  if (!payload.ok) {
    throw new Error(`clear composer failed${payload.error ? `: ${payload.error}` : ""}`);
  }
}

async function getComposerIndex(deadline?: number): Promise<string | null> {
  const first = await stateText(deadline);
  if (!commandFailed(first)) {
    const found = findComposerIndex(outputOf(first));
    if (found) {
      return found;
    }
  } else {
    log(`opencli browser state failed: ${first.error?.message || first.stderr || first.status}`);
  }

  const second = await stateText(deadline);
  if (commandFailed(second)) {
    log(`opencli browser state retry failed: ${second.error?.message || second.stderr || second.status}`);
    return null;
  }

  return findComposerIndex(outputOf(second));
}

async function askCommand(args: string[]): Promise<number> {
  let parsed: AskArgs;
  try {
    parsed = parseAskArgs(args);
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    log(usage());
    return 2;
  }

  if (!isBackgroundWorker()) {
    const activeBackground = findActiveTask();
    if (activeBackground && !parsed.force) {
      log(`active gpt-pro background task exists: ${activeBackground.task.taskId || activeBackground.filePath}`);
      printTaskCompact(activeBackground.task, activeBackground.filePath);
      log(`Use gpt-pro poll/collect --task-id ${activeBackground.task.taskId || "<id>"}, or pass --force to discard it.`);
      return 2;
    }
    if (activeBackground && parsed.force) {
      patchTaskFile(activeBackground.filePath, { status: "stale", finishedAt: Date.now(), lastError: "superseded by foreground ask --force" });
    }
  }

  const existing = readTask();
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
  const sameBackgroundTask = isBackgroundWorker() && existing?.taskId && existing.taskId === process.env.GPT_PRO_TASK_ID;
  const existingAgeMs = existing ? Date.now() - (existing.sentAt || existing.createdAt || Date.now()) : 0;
  const existingRecoverable = Boolean(
    existing &&
    existing.status !== "completed" &&
    existing.status !== "failed" &&
    (existing.conversationUrl || !isTerminalTaskStatus(existing.status))
  );
  // ponytail: stale-lock cleanup — if the recorded pid died before ChatGPT assigned a conversation URL,
  // clear and proceed. If a URL exists, do NOT re-ask; continue/poll the same conversation to protect Pro quota.
  if (!sameBackgroundTask && existingRecoverable && !isPidAlive(existing?.pid) && !existing?.conversationUrl && !isTerminalTaskStatus(existing?.status)) {
    const ageMin = Math.round(existingAgeMs / 60000);
    log(`stale gpt-pro task found (status=${existing?.status}, started ${ageMin}m ago, pid ${existing?.pid ?? "unknown"} no longer alive). Clearing lock.`);
    clearTask();
  } else if (!sameBackgroundTask && existingRecoverable && existingAgeMs < TWO_HOURS_MS && !parsed.force) {
    const ageMin = Math.round(existingAgeMs / 60000);
    log(`unfinished gpt-pro task found (status=${existing?.status}, started ${ageMin}m ago, url=${existing?.conversationUrl || "pending"}).`);
    log(existing?.taskId ? `Resume it with: gpt-pro start continue --task-id ${existing.taskId} [--timeout <sec>] [--out <file>]` : `Resume it with: gpt-pro continue [--timeout <sec>] [--out <file>]`);
    log(`Or pass --force to ask to discard it and start a new conversation.`);
    log(`Do NOT re-run ask for the same prompt — that opens a new conversation and wastes the already-spent generation time.`);
    return 2;
  }
  if (!sameBackgroundTask && existing && parsed.force) {
    log("--force: discarding unfinished gpt-pro task.");
    clearTask();
  }

  let deadline = Date.now() + parsed.timeoutSec * 1000;
  const absoluteCeiling = deadline + MAX_AUTO_EXTEND_MS;
  if (isBackgroundWorker()) {
    patchTask({
      status: "starting",
      pid: process.pid,
      heartbeatAt: Date.now(),
      startedAt: Date.now(),
      timeoutSec: parsed.timeoutSec,
      deadlineAt: deadline,
      absoluteCeilingAt: absoluteCeiling,
      outPath: absolutePathMaybe(parsed.out),
    });
  }
  try {
    const doctor = await runOpencliWithinDeadline(["doctor"], deadline);
    if (!isBridgeConnected(doctor)) {
      log("opencli Bridge is not connected.");
      if (doctor.error) {
        log(doctor.error.message);
      }
      if (doctor.stderr.trim()) {
        log(doctor.stderr.trim());
      }
      return 2;
    }

    requireSuccess(await runOpencliWithinDeadline(["browser", "open", CHATGPT_URL], deadline), "opencli browser open");
    requireSuccess(await runOpencliWithinDeadline(["browser", "wait", "time", "5"], deadline), "opencli browser wait");

    const composerIndex = await getComposerIndex(deadline);
    if (!composerIndex) {
      throw new Error("could not find ChatGPT composer element id=prompt-textarea role=textbox");
    }

    await clearComposer(deadline);
    requireSuccess(await runOpencliWithinDeadline(["browser", "wait", "time", "1"], deadline), "opencli browser wait after clear composer");

    if (parsed.files.length > 0) {
      await uploadFiles(parsed.files, deadline);
    }

    const prompt = parsed.prompt || (parsed.files.length > 0 ? "请审查上传的文件。" : "");
    if (prompt) {
      requireSuccess(await runOpencliWithinDeadline(["browser", "type", composerIndex, prompt], deadline), "opencli browser type");
    }

    const baselineCountResult = await runOpencliWithinDeadline(["browser", "eval", ASSISTANT_COUNT_JS], deadline);
    requireSuccess(baselineCountResult, "opencli browser eval assistant baseline count");
    const baselineCount = Number(baselineCountResult.stdout.trim());
    if (!Number.isFinite(baselineCount)) {
      throw new Error(`assistant baseline count returned invalid value\n${baselineCountResult.stdout.trim() || baselineCountResult.stderr.trim()}`);
    }

    await sendPrompt(deadline);

    // Persist the conversation URL as soon as ChatGPT assigns one, so a later
    // `gpt-pro continue` can reopen this exact conversation if we time out or get
    // killed. Poll briefly: the URL changes from / to /c/<id> right after send.
    let conversationUrl = "";
    let conversationId = "";
    for (let attempt = 0; attempt < 8; attempt += 1) {
      requireBeforeDeadline(deadline, "extract conversation url");
      const urlResult = await runOpencliWithinDeadline(["browser", "eval", EXTRACT_CONVERSATION_URL_JS], deadline);
      if (!commandFailed(urlResult)) {
        try {
          const payload = JSON.parse(urlResult.stdout.trim()) as { url?: string; pathname?: string };
          const m = (payload.pathname || "").match(/^\/c\/(.+)$/);
          if (m && payload.url) {
            conversationUrl = payload.url;
            conversationId = m[1];
            break;
          }
        } catch {
          // ignore non-JSON; retry
        }
      }
      if (attempt < 7) {
        requireBeforeDeadline(deadline, "wait for conversation url");
        requireSuccess(await runOpencliWithinDeadline(["browser", "wait", "time", "2"], deadline), "opencli browser wait for conversation url");
      }
    }
    if (conversationUrl) {
      const previousTask = readTask();
      writeTask({
        ...(previousTask || {}),
        schemaVersion: previousTask?.schemaVersion || (isBackgroundWorker() ? 2 : 1),
        taskId: previousTask?.taskId || process.env.GPT_PRO_TASK_ID,
        command: previousTask?.command || "ask",
        conversationUrl,
        conversationId,
        prompt: parsed.prompt,
        files: parsed.files,
        baselineCount,
        sentAt: Date.now(),
        submittedAt: Date.now(),
        heartbeatAt: Date.now(),
        pid: process.pid,
        status: "running",
        timeoutSec: parsed.timeoutSec,
        outPath: absolutePathMaybe(parsed.out) || previousTask?.outPath,
        resultPath: absolutePathMaybe(parsed.out) || previousTask?.resultPath,
      });
    } else {
      log("warning: could not extract conversation /c/<id> URL; resume via `gpt-pro continue` will be unavailable for this dispatch.");
    }

    const sentAt = Date.now();
    const outcome = await waitForAssistantReply({
      deadline,
      absoluteCeiling,
      baselineCount,
      sentAt,
      out: parsed.out,
    });
    if (outcome.status === "completed") {
      const task = readTask();
      if (task) {
        task.status = "completed";
        task.finishedAt = Date.now();
        task.exitCode = 0;
        writeTask(task);
        if (!isBackgroundWorker()) clearTask();
      }
      return 0;
    }
    log("timed out waiting for assistant response to stabilize.");
    if (outcome.text) {
      log("timed out but saving partial assistant response");
      writeAssistantOutput(outcome.text, parsed.out);
    }
    const task = readTask();
    if (task) {
      task.status = "timed-out";
      task.partialText = outcome.text || "";
      task.partialPath = absolutePathMaybe(parsed.out) || task.partialPath;
      task.finishedAt = Date.now();
      task.exitCode = outcome.text ? 0 : 2;
      writeTask(task);
      if (task.conversationUrl) {
        log(`gpt-pro: timed out. Conversation preserved at ${task.conversationUrl}.`);
        log(`Resume with: gpt-pro continue (via codex_bridge). Do NOT re-run ask.`);
      }
    }
    return outcome.text ? 0 : 2;
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

async function continueCommand(args: string[]): Promise<number> {
  let url: string | undefined;
  let timeoutSec = 900;
  let out: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--url") {
      url = args[i + 1];
      if (!url) {
        log("missing value for --url");
        log(usage());
        return 2;
      }
      i += 1;
    } else if (arg === "--timeout") {
      const v = args[i + 1];
      if (!v) {
        log("missing value for --timeout");
        log(usage());
        return 2;
      }
      timeoutSec = Number(v);
      if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
        log("--timeout must be a positive number of seconds");
        return 2;
      }
      i += 1;
    } else if (arg === "--out") {
      out = args[i + 1];
      if (!out) {
        log("missing value for --out");
        log(usage());
        return 2;
      }
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      return 0;
    } else {
      log(`unknown argument: ${arg}`);
      log(usage());
      return 2;
    }
  }

  const task = readTask();
  const conversationUrl = url || task?.conversationUrl;
  const prevPartial = task?.partialText;
  if (!conversationUrl) {
    log("no resumable gpt-pro task: no --url given and no gpt-pro-task.json on disk.");
    log("Run `gpt-pro ask` first; continue only resumes an already-dispatched conversation.");
    return 2;
  }

  let deadline = Date.now() + timeoutSec * 1000;
  const absoluteCeiling = deadline + MAX_AUTO_EXTEND_MS;
  if (isBackgroundWorker()) {
    patchTask({
      status: "starting",
      pid: process.pid,
      heartbeatAt: Date.now(),
      startedAt: Date.now(),
      timeoutSec,
      deadlineAt: deadline,
      absoluteCeilingAt: absoluteCeiling,
      outPath: absolutePathMaybe(out),
    });
  }
  try {
    const doctor = await runOpencliWithinDeadline(["doctor"], deadline);
    if (!isBridgeConnected(doctor)) {
      log("opencli Bridge is not connected.");
      if (doctor.error) log(doctor.error.message);
      if (doctor.stderr.trim()) log(doctor.stderr.trim());
      return 2;
    }

    requireSuccess(await runOpencliWithinDeadline(["browser", "open", conversationUrl], deadline), "opencli browser open conversation");
    requireSuccess(await runOpencliWithinDeadline(["browser", "wait", "time", "5"], deadline), "opencli browser wait");

    // After reload, the page shows the full conversation history. The last
    // assistant message is the (possibly partial) reply we were waiting on.
    // Use the current assistant count as baseline and only accept a reply that
    // differs from any previously-saved partial.
    const baselineResult = await runOpencliWithinDeadline(["browser", "eval", ASSISTANT_COUNT_JS], deadline);
    requireSuccess(baselineResult, "opencli browser eval assistant count on resume");
    const baselineCount = Number(baselineResult.stdout.trim());
    if (!Number.isFinite(baselineCount)) {
      throw new Error(`assistant count on resume returned invalid value\n${baselineResult.stdout.trim() || baselineResult.stderr.trim()}`);
    }

    const sentAt = task?.sentAt || Date.now();
    log(`resuming gpt-pro conversation ${conversationUrl} (baseline assistant count ${baselineCount}${prevPartial ? ", has prior partial" : ""}).`);

    if (task) {
      task.status = "running";
      task.baselineCount = baselineCount;
      task.pid = process.pid;
      task.heartbeatAt = Date.now();
      task.timeoutSec = timeoutSec;
      task.outPath = absolutePathMaybe(out) || task.outPath;
      writeTask(task);
    }

    const outcome = await waitForAssistantReply({
      deadline,
      absoluteCeiling,
      baselineCount,
      sentAt,
      prevPartial,
      out,
    });
    if (outcome.status === "completed") {
      const t = readTask();
      if (t) {
        t.status = "completed";
        t.finishedAt = Date.now();
        t.exitCode = 0;
        writeTask(t);
        if (!isBackgroundWorker()) clearTask();
      }
      return 0;
    }
    log("timed out waiting for assistant response to stabilize on resume.");
    if (outcome.text) {
      log("timed out but saving partial assistant response");
      // writeAssistantOutput already called by the helper when it had accepted
      // a reply; on timed-out we still print any partial we have.
      writeAssistantOutput(outcome.text, out);
    }
    const t = readTask();
    if (t) {
      t.status = "timed-out";
      t.partialText = outcome.text || "";
      t.partialPath = absolutePathMaybe(out) || t.partialPath;
      t.finishedAt = Date.now();
      t.exitCode = outcome.text ? 0 : 2;
      writeTask(t);
      log(`gpt-pro: timed out on resume. Conversation preserved at ${t.conversationUrl}.`);
      log(`Resume again with: gpt-pro continue (via codex_bridge). Do NOT re-run ask.`);
    }
    return outcome.text ? 0 : 2;
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function hasOption(args: string[], option: string): boolean {
  return args.includes(option);
}

function withoutOptions(args: string[], options: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (options.has(arg)) {
      if (args[i + 1] && !args[i + 1].startsWith("--")) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function ensureOption(args: string[], option: string, value: string): string[] {
  return optionValue(args, option) ? args : [...args, option, value];
}

function defaultResultPath(taskId: string): string {
  return path.join(pluginDataDir(), "gpt-pro", "results", `${safeTaskId(taskId)}.txt`);
}

function defaultLogPath(taskId: string): string {
  return path.join(pluginDataDir(), "gpt-pro", "logs", `${safeTaskId(taskId)}.log`);
}

function newTaskId(): string {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function writeLatestTaskPointer(taskId: string, filePath: string): void {
  writeTaskFile(latestTaskPointerPath(), { schemaVersion: 2, taskId, status: "running", resultPath: filePath, updatedAt: Date.now() } as GptProTask);
}

function acquireStartLock(): () => void {
  const filePath = startLockPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  const open = (): number => openSync(filePath, "wx");
  let fd: number;
  try {
    fd = open();
  } catch (error: any) {
    if (error?.code === "EEXIST") {
      try {
        const ageMs = Date.now() - statSync(filePath).mtimeMs;
        if (ageMs > 30_000) {
          unlinkSync(filePath);
          fd = open();
        } else {
          throw new Error("another gpt-pro start is already acquiring the singleton worker lock");
        }
      } catch (inner: any) {
        if (inner?.message) throw inner;
        throw new Error("another gpt-pro start is already acquiring the singleton worker lock");
      }
    } else {
      throw error;
    }
  }
  try { writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`); } catch {}
  return () => {
    try { closeSync(fd); } catch {}
    try { unlinkSync(filePath); } catch {}
  };
}

function latestTaskFile(): string | null {
  const pointer = readTaskFile(latestTaskPointerPath());
  if (pointer?.taskId) {
    const filePath = taskPathForId(pointer.taskId);
    if (existsSync(filePath)) return filePath;
  }
  try {
    const files = readdirSync(taskDir())
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(taskDir(), name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return files[0] || null;
  } catch {
    return existsSync(legacyTaskPath()) ? legacyTaskPath() : null;
  }
}

function resolveTaskFileFromArgs(args: string[]): string | null {
  const explicitFile = optionValue(args, "--task-file");
  if (explicitFile) return absolutePathMaybe(explicitFile)!;
  const taskId = optionValue(args, "--task-id");
  if (taskId) return taskPathForId(taskId);
  return latestTaskFile();
}

function refreshTaskStatus(filePath: string, task: GptProTask): GptProTask {
  if (isTerminalTaskStatus(task.status)) return task;
  const now = Date.now();
  const heartbeatAgeMs = task.heartbeatAt ? now - task.heartbeatAt : Number.POSITIVE_INFINITY;
  const ageMs = now - (task.updatedAt || task.createdAt || task.startedAt || now);
  const pidDead = task.pid ? !isPidAlive(task.pid) : ageMs > 30_000;
  const heartbeatStale = heartbeatAgeMs > 10 * 60 * 1000 && pidDead;
  if (pidDead || heartbeatStale) {
    return patchTaskFile(filePath, {
      status: "stale",
      finishedAt: now,
      lastError: `background worker not alive${task.pid ? ` (pid ${task.pid})` : ""}`,
    });
  }
  return task;
}

function allTaskFiles(): string[] {
  try {
    return readdirSync(taskDir())
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(taskDir(), name));
  } catch {
    return [];
  }
}

function findActiveTask(): { filePath: string; task: GptProTask } | null {
  for (const filePath of allTaskFiles()) {
    const task = readTaskFile(filePath);
    if (!task) continue;
    const refreshed = refreshTaskStatus(filePath, task);
    if (!isTerminalTaskStatus(refreshed.status)) return { filePath, task: refreshed };
  }
  return null;
}

function printTaskCompact(task: GptProTask, filePath: string, includeSummary = true): void {
  const heartbeatAge = task.heartbeatAt ? Math.max(0, Math.round((Date.now() - task.heartbeatAt) / 1000)) : undefined;
  printLine("TASK_ID", task.taskId);
  printLine("STATUS", task.status);
  printLine("TASK_FILE", filePath);
  printLine("RESULT_FILE", task.resultPath || task.outPath);
  printLine("PARTIAL_FILE", task.partialPath);
  printLine("LOG_FILE", task.logPath);
  printLine("CONVERSATION_URL", task.conversationUrl);
  printLine("PID", task.pid);
  printLine("HEARTBEAT_AGE_SEC", heartbeatAge);
  if (includeSummary) printLine("SUMMARY", task.summary || (task.partialText ? summarizeTaskText(task.partialText) : undefined));
  printLine("ERROR", task.lastError);
}

function parseStartContinueArgs(args: string[]): { url?: string; taskId?: string; out?: string; timeoutSec: number } {
  const timeoutValue = optionValue(args, "--timeout");
  const timeoutSec = timeoutValue ? Number(timeoutValue) : 900;
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new Error("--timeout must be a positive number of seconds");
  return {
    url: optionValue(args, "--url"),
    taskId: optionValue(args, "--task-id"),
    out: optionValue(args, "--out"),
    timeoutSec,
  };
}

function spawnDetachedWorker(params: { mode: "ask" | "continue"; args: string[]; taskId: string; taskFile: string; logPath: string }): number {
  mkdirSync(path.dirname(params.logPath), { recursive: true });
  const fd = openSync(params.logPath, "a");
  const scriptPath = new URL(import.meta.url).pathname;
  const entry = process.env.GPT_PRO_TEST_FAKE_WORKER === "1" ? "__fake-worker" : "__worker";
  const child = spawn(process.execPath, ["--experimental-strip-types", scriptPath, entry, params.mode, ...params.args], {
    detached: true,
    stdio: ["ignore", fd, fd],
    cwd: process.cwd(),
    env: {
      ...process.env,
      GPT_PRO_TASK_FILE: params.taskFile,
      GPT_PRO_TASK_ID: params.taskId,
      GPT_PRO_BACKGROUND_WORKER: "1",
    },
  });
  closeSync(fd);
  child.unref();
  return child.pid || 0;
}

async function startCommand(args: string[]): Promise<number> {
  const [mode, ...rest] = args;
  if (mode !== "ask" && mode !== "continue") {
    log("gpt_pro.ts start requires ask or continue");
    log(usage());
    return 2;
  }

  let releaseStartLock: (() => void) | undefined;
  try {
    releaseStartLock = acquireStartLock();
    const force = hasOption(rest, "--force");
    const active = findActiveTask();
    if (active && !force) {
      log(`active gpt-pro background task exists: ${active.task.taskId || active.filePath}`);
      printTaskCompact(active.task, active.filePath);
      return 2;
    }
    if (active && force) {
      patchTaskFile(active.filePath, { status: "stale", finishedAt: Date.now(), lastError: "superseded by start --force" });
    }

    const legacyTask = mode === "ask" ? readTaskFile(legacyTaskPath()) : null;
    const legacyAgeMs = legacyTask ? Date.now() - (legacyTask.sentAt || legacyTask.createdAt || Date.now()) : 0;
    const legacyRecoverable = Boolean(
      legacyTask &&
      legacyTask.status !== "completed" &&
      legacyTask.status !== "failed" &&
      legacyTask.conversationUrl &&
      legacyAgeMs < 2 * 60 * 60 * 1000
    );
    if (legacyRecoverable && !force) {
      log(`recoverable legacy gpt-pro task exists: ${legacyTask!.conversationUrl}`);
      printTaskCompact(legacyTask!, legacyTaskPath());
      log(`Resume it with: gpt-pro start continue --url ${legacyTask!.conversationUrl} [--timeout <sec>] [--out <file>]`);
      log(`Or pass --force to discard it and start a new conversation.`);
      return 2;
    }
    if (legacyRecoverable && force) {
      try { unlinkSync(legacyTaskPath()); } catch {}
    }

    let taskId = newTaskId();
    let taskFile = taskPathForId(taskId);
    let workerArgs = [...rest];
    let outPath = optionValue(rest, "--out");
    let timeoutSec = 900;
    let prompt = "";
    let promptFile: string | undefined;
    let files: string[] = [];
    let conversationUrl: string | undefined;
    let existingTask: GptProTask | null = null;

    if (mode === "ask") {
      const parsed = parseAskArgs(rest);
      timeoutSec = parsed.timeoutSec;
      prompt = parsed.prompt;
      promptFile = optionValue(rest, "--prompt-file");
      files = parsed.files;
      if (!outPath) outPath = defaultResultPath(taskId);
      workerArgs = ensureOption(workerArgs, "--out", outPath);
    } else {
      const parsed = parseStartContinueArgs(rest);
      timeoutSec = parsed.timeoutSec;
      if (parsed.taskId) {
        taskId = safeTaskId(parsed.taskId);
        taskFile = taskPathForId(taskId);
        existingTask = readTaskFile(taskFile);
        if (!existingTask) throw new Error(`unknown gpt-pro task id: ${taskId}`);
        conversationUrl = parsed.url || existingTask.conversationUrl;
        workerArgs = withoutOptions(workerArgs, new Set(["--task-id", "--force"]));
      } else {
        conversationUrl = parsed.url;
      }
      if (!conversationUrl) throw new Error("start continue requires --task-id for a saved task or --url <conversation-url>");
      if (!outPath) outPath = existingTask?.outPath || existingTask?.resultPath || defaultResultPath(taskId);
      workerArgs = ensureOption(withoutOptions(workerArgs, new Set(["--task-id", "--force"])), "--url", conversationUrl);
      workerArgs = ensureOption(workerArgs, "--out", outPath);
    }

    const now = Date.now();
    const logPath = existingTask?.logPath || defaultLogPath(taskId);
    const initialTask: GptProTask = {
      ...(existingTask || {}),
      schemaVersion: 2,
      taskId,
      command: mode,
      status: "starting",
      createdAt: existingTask?.createdAt || now,
      updatedAt: now,
      startedAt: now,
      heartbeatAt: now,
      timeoutSec,
      deadlineAt: now + timeoutSec * 1000,
      absoluteCeilingAt: now + timeoutSec * 1000 + MAX_AUTO_EXTEND_MS,
      prompt,
      promptFile,
      files,
      conversationUrl: conversationUrl || existingTask?.conversationUrl,
      outPath: absolutePathMaybe(outPath),
      resultPath: absolutePathMaybe(outPath),
      logPath,
    };
    writeTaskFile(taskFile, initialTask);
    const pid = spawnDetachedWorker({ mode, args: workerArgs, taskId, taskFile, logPath });
    const startedTask = patchTaskFile(taskFile, { pid, heartbeatAt: Date.now(), startedAt: Date.now() });
    writeLatestTaskPointer(taskId, taskFile);

    printTaskCompact(startedTask, taskFile, false);
    printLine("POLL_CMD", `gpt-pro poll --task-id ${taskId}`);
    printLine("COLLECT_CMD", `gpt-pro collect --task-id ${taskId}`);
    printLine("CANCEL_CMD", `gpt-pro cancel --task-id ${taskId}`);
    return 0;
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return 2;
  } finally {
    if (releaseStartLock) releaseStartLock();
  }
}

async function workerCommand(args: string[]): Promise<number> {
  const [mode, ...rest] = args;
  if (mode !== "ask" && mode !== "continue") {
    log("internal worker requires ask or continue");
    return 2;
  }
  const initialTask = readTask();
  if (initialTask && isTerminalTaskStatus(initialTask.status) && initialTask.status !== "completed") return 0;
  patchTask({ status: "starting", pid: process.pid, heartbeatAt: Date.now(), startedAt: Date.now() });
  let code = 2;
  try {
    code = mode === "ask" ? await askCommand(rest) : await continueCommand(rest);
    const task = readTask();
    if (task && !isTerminalTaskStatus(task.status)) {
      patchTask({ status: code === 0 ? "completed" : "failed", finishedAt: Date.now(), exitCode: code });
    } else if (task) {
      patchTask({ exitCode: code, finishedAt: task.finishedAt || Date.now() });
    }
    return code;
  } catch (error) {
    patchTask({ status: "failed", lastError: error instanceof Error ? error.message : String(error), finishedAt: Date.now(), exitCode: 2 });
    return 2;
  }
}

async function fakeWorkerCommand(args: string[]): Promise<number> {
  const [mode, ...rest] = args;
  const delayMs = Number(process.env.GPT_PRO_FAKE_DELAY_MS || "100");
  const out = absolutePathMaybe(optionValue(rest, "--out") || readTask()?.outPath || defaultResultPath(process.env.GPT_PRO_TASK_ID || "fake"))!;
  const initialTask = readTask();
  if (initialTask && isTerminalTaskStatus(initialTask.status) && initialTask.status !== "completed") return 0;
  patchTask({ status: "running", command: mode === "continue" ? "continue" : "ask", pid: process.pid, heartbeatAt: Date.now(), outPath: out, resultPath: out });
  await new Promise((resolve) => setTimeout(resolve, Number.isFinite(delayMs) ? delayMs : 100));
  if (isTerminalTaskStatus(readTask()?.status) && readTask()?.status !== "completed") return 0;
  mkdirSync(path.dirname(out), { recursive: true });
  const text = `fake gpt-pro ${mode || "ask"} result at ${new Date().toISOString()}`;
  writeFileSync(out, text, "utf8");
  patchTask({ status: "completed", finishedAt: Date.now(), heartbeatAt: Date.now(), resultPath: out, partialPath: out, partialText: text, summary: summarizeTaskText(text), exitCode: 0 });
  return 0;
}

function signalTaskProcess(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid || pid <= 0 || pid === process.pid) return;
  try { process.kill(-pid, signal); } catch {}
  try { process.kill(pid, signal); } catch {}
}

async function pollCommand(args: string[]): Promise<number> {
  const filePath = resolveTaskFileFromArgs(args);
  if (!filePath) {
    log("no gpt-pro task found");
    return 2;
  }
  const task = readTaskFile(filePath);
  if (!task) {
    log(`could not read gpt-pro task: ${filePath}`);
    return 2;
  }
  printTaskCompact(refreshTaskStatus(filePath, task), filePath);
  return 0;
}

async function collectCommand(args: string[]): Promise<number> {
  const filePath = resolveTaskFileFromArgs(args);
  if (!filePath) {
    log("no gpt-pro task found");
    return 2;
  }
  const task = readTaskFile(filePath);
  if (!task) {
    log(`could not read gpt-pro task: ${filePath}`);
    return 2;
  }
  const refreshed = refreshTaskStatus(filePath, task);
  printTaskCompact(refreshed, filePath, false);
  const resultPath = refreshed.resultPath || refreshed.outPath;
  const partialPath = refreshed.partialPath || resultPath;
  if (refreshed.status === "completed" && resultPath && existsSync(resultPath)) {
    printLine("SUMMARY", summarizeTaskText(readFileSync(resultPath, "utf8")));
    return 0;
  }
  if ((refreshed.status === "timed-out" || refreshed.status === "stale" || refreshed.status === "failed" || refreshed.status === "cancelled") && hasOption(args, "--partial") && partialPath && existsSync(partialPath)) {
    printLine("PARTIAL_FILE", partialPath);
    printLine("SUMMARY", summarizeTaskText(readFileSync(partialPath, "utf8")));
    return 0;
  }
  return refreshed.status === "failed" ? 2 : 0;
}

async function cancelCommand(args: string[]): Promise<number> {
  const filePath = resolveTaskFileFromArgs(args);
  if (!filePath) {
    log("no gpt-pro task found");
    return 2;
  }
  const task = readTaskFile(filePath);
  if (!task) {
    log(`could not read gpt-pro task: ${filePath}`);
    return 2;
  }
  if (!isTerminalTaskStatus(task.status)) {
    patchTaskFile(filePath, { status: "cancelled", finishedAt: Date.now(), lastError: "cancelled by user", exitCode: null });
    signalTaskProcess(task.pid, "SIGTERM");
    patchTaskFile(filePath, { status: "cancelled", finishedAt: Date.now(), lastError: "cancelled by user", exitCode: null });
  }
  const cancelled = readTaskFile(filePath) || task;
  printTaskCompact(cancelled, filePath, false);
  return 0;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  if (command === "status") {
    return await statusCommand();
  }

  if (command === "start") {
    return await startCommand(args);
  }

  if (command === "poll") {
    return await pollCommand(args);
  }

  if (command === "collect") {
    return await collectCommand(args);
  }

  if (command === "cancel") {
    return await cancelCommand(args);
  }

  if (command === "__worker") {
    return await workerCommand(args);
  }

  if (command === "__fake-worker") {
    return await fakeWorkerCommand(args);
  }

  if (command === "continue") {
    return await continueCommand(args);
  }

  if (command === "ask") {
    return await askCommand(args);
  }

  log(`unknown command: ${command}`);
  log(usage());
  return 2;
}

// ponytail: on SIGTERM (outer timeout / Bash 600s ceiling) do one final flush of whatever we last saw, then exit 0 so codex_bridge.ts treats it as success and forwards the RESULT_FILE pointer. SIGKILL/-9 and OOM can't be caught — for those, the incremental flush inside updateSnapshot is the safety net (worst case: lose ~2s of generation between snapshots, recoverable via `gpt-pro continue`).
function installSignalFlush(): void {
  const handler = (sig: NodeJS.Signals) => {
    if (pendingPartial?.text) {
      flushPartial(pendingPartial.text, pendingPartial.out);
    }
    const task = readTask();
    if (task && !isTerminalTaskStatus(task.status)) {
      task.status = pendingPartial?.text ? "timed-out" : "stale";
      task.lastError = `received ${sig}`;
      task.finishedAt = Date.now();
      task.exitCode = 0;
      writeTask(task);
    }
    process.exit(0);
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
}
installSignalFlush();

main().then((code) => { process.exitCode = code; }).catch((e) => { process.stderr.write(`${(e as Error).stack || e}\n`); process.exitCode = 1; });
