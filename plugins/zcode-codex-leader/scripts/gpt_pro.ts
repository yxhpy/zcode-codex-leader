#!/usr/bin/env -S node --experimental-strip-types

import { spawnSync } from "child_process";
import { existsSync, accessSync, constants, readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import path, { basename, extname, isAbsolute, resolve } from "node:path";
import { pluginDataDir } from "./app_server_pool.ts";

type RunResult = {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
};

type GptProTask = {
  conversationUrl: string;
  conversationId: string;
  prompt: string;
  baselineCount: number;
  sentAt: number;
  pid?: number;
  heartbeatAt?: number;
  status: "generating" | "timed-out" | "completed";
  partialText?: string;
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

function taskPath(): string {
  return path.join(pluginDataDir(), "gpt-pro-task.json");
}

function readTask(): GptProTask | null {
  try {
    if (!existsSync(taskPath())) return null;
    const t = JSON.parse(readFileSync(taskPath(), "utf8")) as GptProTask;
    if (!t || !t.conversationUrl) return null;
    return t;
  } catch {
    return null;
  }
}

function writeTask(t: GptProTask): void {
  writeFileSync(taskPath(), JSON.stringify(t, null, 2));
}

function isPidAlive(pid?: number): boolean {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function clearTask(): void {
  try { unlinkSync(taskPath()); } catch {}
}

function usage(): string {
  return [
    "Usage:",
    "  gpt_pro.ts help",
    "  gpt_pro.ts status",
    "  gpt_pro.ts ask [<prompt> | --prompt-file <file>] [--file <path> ...] [--out <file>] [--timeout <sec>]",
    "  gpt_pro.ts continue [--url <url>] [--timeout <sec>] [--out <file>]",
    "      Resume a timed-out gpt-pro conversation: reopen its saved /c/<id> URL and",
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

function runCommand(bin: string, args: string[], timeoutMs = 60000): RunResult {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    shell: false,
    maxBuffer: 10 * 1024 * 1024,
    timeout: timeoutMs,
  });

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
    error: result.error,
  };
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

function runOpencli(args: string[], timeoutMs = opencliTimeoutMs(args)): RunResult {
  return runCommand(opencliBin, args, timeoutMs);
}

function runOpencliWithinDeadline(args: string[], deadline: number): RunResult {
  requireBeforeDeadline(deadline, `opencli ${args.join(" ")}`);
  const remainingMs = Math.max(1, deadline - Date.now());
  return runOpencli(args, Math.min(opencliTimeoutMs(args), remainingMs));
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

function stateText(deadline?: number): RunResult {
  const args = ["browser", "state"];
  return deadline === undefined ? runOpencli(args) : runOpencliWithinDeadline(args, deadline);
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

function statusCommand(): number {
  const doctor = runOpencli(["doctor"]);
  const bridge = isBridgeConnected(doctor);
  let loggedIn = false;
  let plan: "pro" | false = false;

  try {
    const opened = runOpencli(["browser", "open", CHATGPT_URL]);
    if (commandFailed(opened)) {
      throw new Error(opened.error?.message || opened.stderr || "opencli browser open failed");
    }

    const waited = runOpencli(["browser", "wait", "time", "5"]);
    if (commandFailed(waited)) {
      throw new Error(waited.error?.message || waited.stderr || "opencli browser wait failed");
    }

    const state = stateText();
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

function readAssistantSnapshot(deadline?: number): { count: number; text: string } | null {
  const args = ["browser", "eval", EXTRACT_NEW_ASSISTANT_JS];
  const evaluated = deadline === undefined ? runOpencli(args) : runOpencliWithinDeadline(args, deadline);
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
  // Always print the full response to stdout so the leader receives the content
  // directly via codex_bridge.ts. The --out option only persists an extra copy.
  process.stdout.write(`${text}\n`);
  if (out) {
    const absoluteOut = isAbsolute(out) ? out : resolve(process.cwd(), out);
    writeFileSync(absoluteOut, text, "utf8");
    process.stderr.write(`gpt-pro: result copy saved to ${absoluteOut}\n`);
  }
}

function waitForAssistantReply(params: {
  deadline: number;
  absoluteCeiling: number;
  baselineCount: number;
  sentAt: number;
  prevPartial?: string;
  out?: string;
}): WaitOutcome {
  let deadline = params.deadline;
  const resumeMode = Object.prototype.hasOwnProperty.call(params, "prevPartial");
  const generationStartDeadline = Math.min(deadline, params.sentAt + 30000);
  let sawGenerating = false;
  let lastText = "";
  let currentText = "";
  let currentCount = params.baselineCount;
  let stableReads = 0;

  const updateSnapshot = (snapshot: { count: number; text: string }): void => {
    currentCount = snapshot.count;
    currentText =
      snapshot.count > params.baselineCount || (resumeMode && snapshot.count >= params.baselineCount)
        ? snapshot.text
        : "";
  };
  const acceptable = (text: string): boolean => {
    if (!text) {
      return false;
    }
    return params.prevPartial === undefined || text !== params.prevPartial;
  };
  const currentDeadline = (): number => (Date.now() < deadline ? deadline : params.absoluteCeiling);

  while (Date.now() < generationStartDeadline) {
    const generating = runOpencliWithinDeadline(["browser", "eval", IS_GENERATING_JS], deadline);
    if (!commandFailed(generating) && generating.stdout.trim() === "true") {
      sawGenerating = true;
      break;
    }
    if (commandFailed(generating)) {
      log(`opencli browser eval failed: ${generating.error?.message || generating.stderr || generating.status}`);
    }

    const snapshot = readAssistantSnapshot(deadline);
    if (snapshot) {
      updateSnapshot(snapshot);
    }

    if (Date.now() < generationStartDeadline) {
      const waited = runOpencliWithinDeadline(["browser", "wait", "time", "2"], deadline);
      if (commandFailed(waited)) {
        log(`opencli browser wait failed: ${waited.error?.message || waited.stderr || waited.status}`);
      }
    }
  }

  while (Date.now() < params.absoluteCeiling) {
    const operationDeadline = currentDeadline();
    const generating = runOpencliWithinDeadline(["browser", "eval", IS_GENERATING_JS], operationDeadline);
    if (!commandFailed(generating) && generating.stdout.trim() === "true") {
      sawGenerating = true;
      if (Date.now() >= deadline && Date.now() < params.absoluteCeiling) {
        deadline = Math.min(params.absoluteCeiling, deadline + 120000);
        log(`extending deadline (still generating): +120s, new total budget ${Math.round((deadline - params.sentAt) / 1000)}s`);
      }
      const waited = runOpencliWithinDeadline(["browser", "wait", "time", "2"], deadline);
      if (commandFailed(waited)) {
        log(`opencli browser wait failed: ${waited.error?.message || waited.stderr || waited.status}`);
      }
      continue;
    }
    if (commandFailed(generating)) {
      log(`opencli browser eval failed: ${generating.error?.message || generating.stderr || generating.status}`);
    }

    const snapshot = readAssistantSnapshot(operationDeadline);
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
      const waited = runOpencliWithinDeadline(["browser", "wait", "time", "2"], deadline);
      if (commandFailed(waited)) {
        log(`opencli browser wait failed: ${waited.error?.message || waited.stderr || waited.status}`);
      }
    } else if (Date.now() < params.absoluteCeiling) {
      // Past the initial deadline but within the auto-extend window: avoid a
      // tight spin while waiting for the next generating/stable check.
      const waited = runOpencliWithinDeadline(["browser", "wait", "time", "2"], params.absoluteCeiling);
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
    default:
      return "text/plain";
  }
}

function uploadFiles(filePaths: string[], deadline: number): void {
  requireBeforeDeadline(deadline, "clear uploads");
  const clearJs = `(()=>{const i=document.querySelector('#upload-files');if(i){const dt=new DataTransfer();i.files=dt.files;i.dispatchEvent(new Event('change',{bubbles:true}));}return JSON.stringify({ok:true,remaining:i&&i.files?i.files.length:0});})()`;
  const cleared = runOpencliWithinDeadline(["browser", "eval", clearJs], deadline);
  requireSuccess(cleared, "opencli browser eval clear uploads");
  requireBeforeDeadline(deadline, "wait after clear uploads");
  requireSuccess(runOpencliWithinDeadline(["browser", "wait", "time", "2"], deadline), "opencli browser wait after clear uploads");
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
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`file too large for --file (max 200KB): ${filePath} (${stat.size} bytes)`);
    }
    const prefix = readFileSync(filePath).subarray(0, 8192);
    if (prefix.includes(0x00)) {
      throw new Error(`binary file not supported by --file (text only): ${filePath}`);
    }
    const content = readFileSync(filePath, "utf8");
    const name = basename(filePath);
    const mimeType = mimeTypeForPath(filePath);
    const js = `(()=>{const i=document.querySelector('#upload-files');if(!i)return JSON.stringify({ok:false,error:'missing #upload-files'});const dt=new DataTransfer();for(const file of Array.from(i.files||[])){dt.items.add(file);}dt.items.add(new File([${JSON.stringify(content)}],${JSON.stringify(name)},{type:${JSON.stringify(mimeType)}}));i.files=dt.files;i.dispatchEvent(new Event('change',{bubbles:true}));return JSON.stringify({ok:true,name:${JSON.stringify(name)},size:${Buffer.byteLength(content, "utf8")}});})()`;
    const uploaded = runOpencliWithinDeadline(["browser", "eval", js], deadline);
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
    requireSuccess(runOpencliWithinDeadline(["browser", "wait", "time", "2"], deadline), "opencli browser wait after upload");
  }

  requireBeforeDeadline(deadline, "upload verification");
  const expectedNames = filePaths.map((filePath) => basename(filePath));
  const verifyJs = `(()=>{const input=document.querySelector('#upload-files');const filesLength=input&&input.files?input.files.length:0;const bodyText=document.body?document.body.innerText:'';const elements=[...document.querySelectorAll('[aria-label]')].map((el)=>el.getAttribute('aria-label')||'');const hasRemove=elements.some((label)=>label.includes('移除')||label.includes('Remove')||label.includes('remove'));const names=${JSON.stringify(expectedNames)};const missingNames=names.filter((name)=>!bodyText.includes(name)&&!elements.some((label)=>label.includes(name)));return JSON.stringify({filesLength,expected:${filePaths.length},hasRemove,missingNames});})()`;
  const verified = runOpencliWithinDeadline(["browser", "eval", verifyJs], deadline);
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

function sendPrompt(deadline: number): void {
  requireBeforeDeadline(deadline, "send prompt");
  requireSuccess(runOpencliWithinDeadline(["browser", "keys", "Enter"], deadline), "opencli browser keys Enter");
  requireBeforeDeadline(deadline, "wait after Enter");
  requireSuccess(runOpencliWithinDeadline(["browser", "wait", "time", "1"], deadline), "opencli browser wait after Enter");

  requireBeforeDeadline(deadline, "prompt sent check");
  const sentCheck = runOpencliWithinDeadline(["browser", "eval", PROMPT_SENT_JS], deadline);
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
    const submitted = runOpencliWithinDeadline(["browser", "eval", SUBMIT_PROMPT_JS], deadline);
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
    requireSuccess(runOpencliWithinDeadline(["browser", "wait", "time", "1"], deadline), "opencli browser wait for send button");
  }
  throw new Error(`click send failed${lastError ? `: ${lastError}` : ""}`);
}

function clearComposer(deadline?: number): void {
  const args = ["browser", "eval", CLEAR_COMPOSER_JS];
  const cleared = deadline === undefined ? runOpencli(args) : runOpencliWithinDeadline(args, deadline);
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

function getComposerIndex(deadline?: number): string | null {
  const first = stateText(deadline);
  if (!commandFailed(first)) {
    const found = findComposerIndex(outputOf(first));
    if (found) {
      return found;
    }
  } else {
    log(`opencli browser state failed: ${first.error?.message || first.stderr || first.status}`);
  }

  const second = stateText(deadline);
  if (commandFailed(second)) {
    log(`opencli browser state retry failed: ${second.error?.message || second.stderr || second.status}`);
    return null;
  }

  return findComposerIndex(outputOf(second));
}

function askCommand(args: string[]): number {
  let parsed: AskArgs;
  try {
    parsed = parseAskArgs(args);
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    log(usage());
    return 2;
  }

  const existing = readTask();
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
  // ponytail: stale-lock cleanup — if the recorded pid died, the task crashed; clear and proceed rather than dead-waiting 2h.
  if (existing && existing.status !== "completed" && !isPidAlive(existing.pid)) {
    const ageMin = Math.round((Date.now() - existing.sentAt) / 60000);
    log(`stale gpt-pro task found (status=${existing.status}, started ${ageMin}m ago, pid ${existing.pid ?? "unknown"} no longer alive). Clearing lock.`);
    clearTask();
  } else if (existing && existing.status !== "completed" && Date.now() - existing.sentAt < TWO_HOURS_MS && !parsed.force) {
    const ageMin = Math.round((Date.now() - existing.sentAt) / 60000);
    log(`unfinished gpt-pro task found (status=${existing.status}, started ${ageMin}m ago, url=${existing.conversationUrl}).`);
    log(`Resume it with: gpt-pro continue [--timeout <sec>] [--out <file>]`);
    log(`Or pass --force to ask to discard it and start a new conversation.`);
    log(`Do NOT re-run ask for the same prompt — that opens a new conversation and wastes the already-spent generation time.`);
    return 2;
  }
  if (existing && parsed.force) {
    log("--force: discarding unfinished gpt-pro task.");
    clearTask();
  }

  let deadline = Date.now() + parsed.timeoutSec * 1000;
  const absoluteCeiling = deadline + MAX_AUTO_EXTEND_MS;
  try {
    const doctor = runOpencliWithinDeadline(["doctor"], deadline);
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

    requireSuccess(runOpencliWithinDeadline(["browser", "open", CHATGPT_URL], deadline), "opencli browser open");
    requireSuccess(runOpencliWithinDeadline(["browser", "wait", "time", "5"], deadline), "opencli browser wait");

    const composerIndex = getComposerIndex(deadline);
    if (!composerIndex) {
      throw new Error("could not find ChatGPT composer element id=prompt-textarea role=textbox");
    }

    clearComposer(deadline);
    requireSuccess(runOpencliWithinDeadline(["browser", "wait", "time", "1"], deadline), "opencli browser wait after clear composer");

    if (parsed.files.length > 0) {
      uploadFiles(parsed.files, deadline);
    }

    const prompt = parsed.prompt || (parsed.files.length > 0 ? "请审查上传的文件。" : "");
    if (prompt) {
      requireSuccess(runOpencliWithinDeadline(["browser", "type", composerIndex, prompt], deadline), "opencli browser type");
    }

    const baselineCountResult = runOpencliWithinDeadline(["browser", "eval", ASSISTANT_COUNT_JS], deadline);
    requireSuccess(baselineCountResult, "opencli browser eval assistant baseline count");
    const baselineCount = Number(baselineCountResult.stdout.trim());
    if (!Number.isFinite(baselineCount)) {
      throw new Error(`assistant baseline count returned invalid value\n${baselineCountResult.stdout.trim() || baselineCountResult.stderr.trim()}`);
    }

    sendPrompt(deadline);

    // Persist the conversation URL as soon as ChatGPT assigns one, so a later
    // `gpt-pro continue` can reopen this exact conversation if we time out or get
    // killed. Poll briefly: the URL changes from / to /c/<id> right after send.
    let conversationUrl = "";
    let conversationId = "";
    for (let attempt = 0; attempt < 8; attempt += 1) {
      requireBeforeDeadline(deadline, "extract conversation url");
      const urlResult = runOpencliWithinDeadline(["browser", "eval", EXTRACT_CONVERSATION_URL_JS], deadline);
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
        requireSuccess(runOpencliWithinDeadline(["browser", "wait", "time", "2"], deadline), "opencli browser wait for conversation url");
      }
    }
    if (conversationUrl) {
      writeTask({
        conversationUrl,
        conversationId,
        prompt: parsed.prompt,
        baselineCount,
        sentAt: Date.now(),
        heartbeatAt: Date.now(),
        pid: process.pid,
        status: "generating",
      });
    } else {
      log("warning: could not extract conversation /c/<id> URL; resume via `gpt-pro continue` will be unavailable for this dispatch.");
    }

    const sentAt = Date.now();
    const outcome = waitForAssistantReply({
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
        writeTask(task);
        clearTask();
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

function continueCommand(args: string[]): number {
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
  try {
    const doctor = runOpencliWithinDeadline(["doctor"], deadline);
    if (!isBridgeConnected(doctor)) {
      log("opencli Bridge is not connected.");
      if (doctor.error) log(doctor.error.message);
      if (doctor.stderr.trim()) log(doctor.stderr.trim());
      return 2;
    }

    requireSuccess(runOpencliWithinDeadline(["browser", "open", conversationUrl], deadline), "opencli browser open conversation");
    requireSuccess(runOpencliWithinDeadline(["browser", "wait", "time", "5"], deadline), "opencli browser wait");

    // After reload, the page shows the full conversation history. The last
    // assistant message is the (possibly partial) reply we were waiting on.
    // Use the current assistant count as baseline and only accept a reply that
    // differs from any previously-saved partial.
    const baselineResult = runOpencliWithinDeadline(["browser", "eval", ASSISTANT_COUNT_JS], deadline);
    requireSuccess(baselineResult, "opencli browser eval assistant count on resume");
    const baselineCount = Number(baselineResult.stdout.trim());
    if (!Number.isFinite(baselineCount)) {
      throw new Error(`assistant count on resume returned invalid value\n${baselineResult.stdout.trim() || baselineResult.stderr.trim()}`);
    }

    const sentAt = task?.sentAt || Date.now();
    log(`resuming gpt-pro conversation ${conversationUrl} (baseline assistant count ${baselineCount}${prevPartial ? ", has prior partial" : ""}).`);

    if (task) {
      task.status = "generating";
      task.baselineCount = baselineCount;
      writeTask(task);
    }

    const outcome = waitForAssistantReply({
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
        writeTask(t);
        clearTask();
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

function main(): number {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  if (command === "status") {
    return statusCommand();
  }

  if (command === "continue") {
    return continueCommand(args);
  }

  if (command === "ask") {
    return askCommand(args);
  }

  log(`unknown command: ${command}`);
  log(usage());
  return 2;
}

process.exitCode = main();
