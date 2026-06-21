#!/usr/bin/env -S node --experimental-strip-types
// codex_bridge.ts — ZCode's only legal channel for doing implementation work.
//
// Subcommands:
//   ask <prompt> [--image <path>] [--model <m>] [--output-schema <file>] [--effort <e>] [--tier <fast|balanced|strong>] [--task-kind <type>]
//       Code generation / parsing. Optional local image, model, reasoning effort,
//       and JSON-Schema-constrained structured output.
//   ask-file <prompt-file> [--out <result-file>] [--image <path>] [--model <m>] [--effort <e>] [--output-schema <file.json>] [--tier <fast|balanced|strong>] [--task-kind <type>]
//       Like ask, but reads the prompt from a file and writes the full result to a file.
//   parse <file> [question] [--out <path>] [--tier <t>] [--model <m>] [--effort <e>]
//       Read a source file and answer a question about it. Replaces the leader
//       reading code directly. Omit question for a default purpose/exports summary.
//   web <query> [--out <path>] [--depth 1-5] [--tier <t>] [--model <m>] [--effort <e>]
//       Web research via the resident worker's webSearch. Replaces WebSearch/WebFetch.
//   vision <image-path> <question>
//       Visual understanding of a local image.
//   generate-image <prompt> [--out <path>] [--timeout <sec>]
//       Synchronous image generation via a dedicated one-shot image worker.
//   test <prompt> [-- <test-cmd>] [--browser] [--full-access] [--out <file>] [--timeout <sec>] [--tier <t>]
//       Run a test suite in an isolated one-shot worker with sandbox (+optional browser).
//   mcp-tool <server> <tool> [--args <json>] [--thread]
//       Direct MCP tool call (bypasses a turn).
//   agy <prompt> [--model <m>] [--timeout <dur>] [--add-dir <dir>]
//       Dispatch a task to the local Antigravity CLI (agy) — long-context,
//       multimodal, live web.
//   gpt-pro ask [<prompt> | --prompt-file <file>] [--file <path> ...] [--out <file>] [--timeout <sec>]
//   gpt-pro continue [--url <url>] [--timeout <sec>] [--out <file>]
//   gpt-pro status
//   gpt-pro help
//       Dispatch to ChatGPT web Pro via opencli Browser Bridge.
//
// Each successful call bumps the session dispatch count and prints a trailing
// "Plugin evidence:" line so ZCode can aggregate evidence for the Stop gate.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { runTurn, runImageTurn, runTestTurn, callMcpTool, bumpDispatch, pluginDataDir } from "./app_server_pool.ts";
import { RunStore, type PacketInput } from "./run_store.ts";

function fail(msg: string, code = 1): never {
  process.stderr.write(`codex_bridge: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv: string[]): { sub: string; positional: string[]; flags: Record<string, string> } {
  const [sub, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = "true";
      else { flags[key] = next; i++; }
    } else {
      positional.push(a);
    }
  }
  return { sub, positional, flags };
}

// ponytail: minimal flag parser - no dep, covers --flag value / --flag (boolean).
function parseFlags(args: string[], spec: Record<string, "string" | "boolean">): { flags: Record<string, string | boolean | undefined>; positional: string[] } {
  const flags: Record<string, string | boolean | undefined> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const type = spec[name];
      if (type === "boolean") {
        flags[name] = true;
      } else if (type === "string") {
        flags[name] = args[++i];
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function readJsonFile(p: string): any {
  if (!existsSync(p)) fail(`file not found: ${p}`);
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch { fail(`invalid JSON in ${p}`); }
}

function resolveAgyBin(): string {
  const candidate = process.env.AGY_BIN || path.join(os.homedir(), ".local/bin/agy");
  return existsSync(candidate) ? candidate : "agy";
}

function parseAgyTimeoutMs(value: string): number {
  const m = value.trim().match(/^(\d+)(ms|s|m|h)?$/i);
  if (!m) return 20 * 60 * 1000;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 20 * 60 * 1000;
  switch ((m[2] || "ms").toLowerCase()) {
    case "h": return n * 60 * 60 * 1000;
    case "m": return n * 60 * 1000;
    case "s": return n * 1000;
    case "ms": return n;
    default: return 20 * 60 * 1000;
  }
}

function rawArgsAfterSubcommand(subcommand: string): string[] {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(subcommand);
  return index === -1 ? [] : argv.slice(index + 1);
}

function collectRepeatedRawOption(rawArgs: string[], option: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    if (rawArgs[i] !== option) {
      continue;
    }
    const value = rawArgs[i + 1];
    if (!value || value.startsWith("--")) {
      fail(`gpt-pro ask missing value for ${option}`);
    }
    values.push(value);
    i += 1;
  }
  return values;
}

// ask: code generation / parsing, optionally with image + structured output schema
async function cmdAsk(positional: string[], flags: Record<string, string>): Promise<void> {
  const prompt = positional.join(" ").trim();
  if (!prompt) fail("ask requires a prompt");
  const input: any[] = [{ type: "text", text: prompt }];
  if (flags.image) {
    if (!existsSync(flags.image)) fail(`image not found: ${flags.image}`);
    input.unshift({ type: "localImage", path: flags.image, detail: flags.detail || "auto" });
  }
  const opts: any = {};
  if (flags.model) opts.model = flags.model;
  if (flags.effort) opts.effort = flags.effort;
  if (flags.tier) opts.tier = flags.tier;
  if (flags["task-kind"]) opts.taskKind = flags["task-kind"];
  if (flags["output-schema"]) opts.outputSchema = readJsonFile(flags["output-schema"]);

  const r = await runTurn(input, opts);
  bumpDispatch();
  // print agent messages (the actual answer)
  for (const m of r.messages) process.stdout.write(m + "\n");
  process.stdout.write(`Plugin evidence: ask via codex_bridge.ts — turn ${r.turnId}${r.tier ? " [tier=" + r.tier + (r.model ? ",model=" + r.model : "") + "]" : ""}\n`);
}

// parse: read a source file and answer a question about it. Replaces the leader
// reading code directly. The file body is fed as fenced text input so the worker
// never has to re-read it (the leader already can't, and the worker's cwd may
// differ). Default question summarizes purpose/exports/key logic.
async function cmdParse(positional: string[], flags: Record<string, string>): Promise<void> {
  const filePath = positional[0];
  if (!filePath || !existsSync(filePath)) fail(`parse requires an existing <file>: ${filePath || "(missing)"}`);
  const question = positional.slice(1).join(" ").trim()
    || "Summarize this file: its purpose, public exports/symbols, and the key logic a maintainer needs to know. Be concrete and reference symbol names.";
  const body = readFileSync(filePath, "utf8");
  const lang = (filePath.toLowerCase().split(".").pop() || "") || "";
  const input: any[] = [{
    type: "text",
    text: `${question}\n\n--- FILE: ${filePath} ---\n\`\`\`${lang}\n${body}\n\`\`\`\n\nAnswer the question above using only this file. If the file is too large to fully parse, focus on the public surface (exports, signatures, top-level structure) and say so.`,
  }];
  const opts: any = { tier: flags.tier || "balanced", taskKind: "parse" };
  if (flags.model) opts.model = flags.model;
  if (flags.effort) opts.effort = flags.effort;

  const r = await runTurn(input, opts);
  bumpDispatch();
  const text = r.messages.join("\n").trim() || "(no agentMessage text returned)";
  if (text.length > 800 || flags.out) {
    const outPath = flags.out || path.join(pluginDataDir(), `parse-${Date.now()}.txt`);
    writeFileSync(outPath, text, "utf8");
    const summary = text.split(/\s+/).filter(Boolean).slice(0, 120).join(" ");
    process.stdout.write(outPath + "\n");
    process.stdout.write((summary || text) + "\n");
  } else {
    process.stdout.write(text + "\n");
  }
  process.stdout.write(`Plugin evidence: parse via codex_bridge.ts — turn ${r.turnId} on ${filePath}${r.tier ? " [tier=" + r.tier + "]" : ""}\n`);
}

// web: web research via the resident worker's webSearch capability. The leader's
// own WebSearch/WebFetch are gate-blocked; this is the only web path.
async function cmdWeb(positional: string[], flags: Record<string, string>): Promise<void> {
  const query = positional.join(" ").trim();
  if (!query) fail("web requires a <query>");
  const depth = flags.depth ? Number(flags.depth) : 1;
  if (!Number.isFinite(depth) || depth < 1 || depth > 5) fail(`invalid --depth (1-5): ${flags.depth}`);
  const input: any[] = [{
    type: "text",
    text: `Research this and report findings with source URLs. Search depth: ${depth} (1=quick lookup, 3=thorough, 5=exhaustive). Query: ${query}\n\nUse web search as needed. Cite each fact with its source URL. If you cannot reach the web, say so explicitly instead of guessing.`,
  }];
  const opts: any = { tier: flags.tier || "balanced", taskKind: "summary" };
  if (flags.model) opts.model = flags.model;
  if (flags.effort) opts.effort = flags.effort;

  const r = await runTurn(input, opts);
  bumpDispatch();
  const text = r.messages.join("\n").trim() || "(no agentMessage text returned)";
  if (text.length > 800 || flags.out) {
    const outPath = flags.out || path.join(pluginDataDir(), `web-${Date.now()}.txt`);
    writeFileSync(outPath, text, "utf8");
    const summary = text.split(/\s+/).filter(Boolean).slice(0, 120).join(" ");
    process.stdout.write(outPath + "\n");
    process.stdout.write((summary || text) + "\n");
  } else {
    process.stdout.write(text + "\n");
  }
  process.stdout.write(`Plugin evidence: web via codex_bridge.ts — turn ${r.turnId}${r.tier ? " [tier=" + r.tier + "]" : ""}\n`);
}

// ask-file: code generation / parsing with file-based prompt and result output
async function cmdAskFile(positional: string[], flags: Record<string, string>): Promise<void> {
  const promptFile = positional[0];
  if (!promptFile || !existsSync(promptFile)) fail("ask-file requires an existing <prompt-file>");
  const prompt = readFileSync(promptFile, "utf8").trim();
  if (!prompt) fail("ask-file: prompt file is empty");
  const input: any[] = [{ type: "text", text: prompt }];
  if (flags.image) {
    if (!existsSync(flags.image)) fail(`image not found: ${flags.image}`);
    input.unshift({ type: "localImage", path: flags.image, detail: flags.detail || "auto" });
  }
  const opts: any = {};
  if (flags.model) opts.model = flags.model;
  if (flags.effort) opts.effort = flags.effort;
  if (flags.tier) opts.tier = flags.tier;
  if (flags["task-kind"]) opts.taskKind = flags["task-kind"];
  if (flags["output-schema"]) opts.outputSchema = readJsonFile(flags["output-schema"]);

  const r = await runTurn(input, opts);
  bumpDispatch();
  const dir = pluginDataDir();
  const outPath = flags.out || path.join(dir, `result-${Date.now()}.txt`);
  const resultText = r.messages.length > 0 ? r.messages.join("\n") : "(no agentMessage text returned)";
  writeFileSync(outPath, resultText, "utf8");
  process.stdout.write(outPath + "\n");
  process.stdout.write(`Plugin evidence: ask-file via codex_bridge.ts — turn ${r.turnId}${r.tier ? " [tier=" + r.tier + (r.model ? ",model=" + r.model : "") + "]" : ""} → ${outPath}\n`);
}

// vision: visual understanding of a local image
async function cmdVision(positional: string[], flags: Record<string, string>): Promise<void> {
  const [imgPath, ...qParts] = positional;
  const question = qParts.join(" ").trim();
  if (!imgPath || !question) fail("vision requires <image-path> <question>");
  if (!existsSync(imgPath)) fail(`image not found: ${imgPath}`);
  const input = [
    { type: "localImage", path: imgPath, detail: flags.detail || "high" },
    { type: "text", text: question },
  ];
  const r = await runTurn(input);
  bumpDispatch();
  for (const m of r.messages) process.stdout.write(m + "\n");
  process.stdout.write(`Plugin evidence: vision via codex_bridge.ts — turn ${r.turnId}\n`);
}

// generate-image: synchronous image generation via a dedicated one-shot image worker.
async function cmdGenerateImage(positional: string[], flags: Record<string, string>): Promise<void> {
  const prompt = positional.join(" ").trim();
  if (!prompt) fail("generate-image requires a prompt");
  const timeoutSec = flags.timeout ? Number(flags.timeout) : 900;
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) fail(`invalid --timeout: ${flags.timeout}`);
  const r = await runImageTurn(
    [{ type: "text", text: `Generate an image: ${prompt}` }],
    { timeoutMs: Math.round(timeoutSec * 1000) },
  );
  bumpDispatch();

  if (r.imageGeneration.length === 0) {
    // worker may have declined or described in text instead
    process.stderr.write("codex_bridge: no image_generation_call item returned; worker output:\n");
    for (const m of r.messages) process.stderr.write(m + "\n");
    process.exit(2);
  }

  const gen = r.imageGeneration[r.imageGeneration.length - 1];
  // Prefer a worker-provided saved path; otherwise decode base64 to disk.
  let outPath = flags.out;
  if (!outPath && gen.savedPath) {
    outPath = gen.savedPath;
  } else if (!outPath || !gen.savedPath) {
    const dir = pluginDataDir();
    mkdirSync(dir, { recursive: true });
    outPath = outPath || path.join(dir, `gen-${Date.now()}.png`);
    try {
      const buf = Buffer.from(gen.result, "base64");
      writeFileSync(outPath, buf);
    } catch (e: any) {
      fail(`failed to write image: ${e.message}`);
    }
  }
  process.stdout.write(outPath + "\n");
  process.stdout.write(`Plugin evidence: generate-image via codex_bridge.ts — turn ${r.turnId} → ${outPath}\n`);
}

// test: one-shot test worker with sandbox and optional browser support
async function cmdTest(positional: string[], flags: Record<string, string>): Promise<void> {
  let prompt = positional.join(" ").trim();
  if (!prompt) fail("test requires a prompt");

  const rawArgs = rawArgsAfterSubcommand("test");
  const separatorIndex = rawArgs.indexOf("--");
  const testCmd = separatorIndex === -1 ? [] : rawArgs.slice(separatorIndex + 1);
  if (testCmd.length > 0) {
    prompt += `\n\nRun exactly this command and report its full output: ${testCmd.join(" ")}`;
  }

  const timeoutSec = flags.timeout ? Number(flags.timeout) : 600;
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) fail(`invalid --timeout: ${flags.timeout}`);
  const opts: any = {
    cwd: process.cwd(),
    timeoutMs: Math.round(timeoutSec * 1000),
    browser: flags.browser === "true",
    fullAccess: flags["full-access"] === "true" || flags.browser === "true",
    tier: flags.tier || "balanced",
    taskKind: flags["task-kind"] || "qa",
  };
  const input = [{ type: "text", text: prompt }];

  const r = await runTestTurn(input, opts);
  bumpDispatch();

  const messages = r.messages.join("\n");
  if (messages.length > 800 || flags.out) {
    const outPath = flags.out || path.join(pluginDataDir(), `test-result-${Date.now()}.txt`);
    writeFileSync(outPath, messages || "(no agentMessage text returned)", "utf8");
    const summary = messages.split(/\s+/).filter(Boolean).slice(0, 120).join(" ");
    process.stdout.write(outPath + "\n");
    process.stdout.write((summary || "(no agentMessage text returned)") + "\n");
  } else {
    process.stdout.write(messages + (messages ? "\n" : ""));
  }
  process.stdout.write(`Plugin evidence: test via codex_bridge.ts — turn ${r.turnId} [browser=${opts.browser ? "on" : "off"}]\n`);
}

// mcp-tool: direct MCP tool call (bypasses a turn)
async function cmdMcpTool(positional: string[], flags: Record<string, string>): Promise<void> {
  const [server, tool, ...rest] = positional;
  if (!server || !tool) fail("mcp-tool requires <server> <tool>");
  let args: any = {};
  if (flags.args) {
    try { args = JSON.parse(flags.args); }
    catch { fail(`invalid --args JSON: ${flags.args}`); }
  }
  const useThread = flags.thread === "true";
  const result = await callMcpTool(server, tool, args, useThread);
  bumpDispatch();
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(`Plugin evidence: mcp-tool via codex_bridge.ts — ${server}/${tool}\n`);
}

// agy: dispatch to local Antigravity CLI
async function cmdAgy(positional: string[], flags: Record<string, string>): Promise<void> {
  const prompt = positional.join(" ").trim();
  if (!prompt) fail("agy requires a prompt");
  const printTimeout = flags.timeout || "20m";
  const argv = ["--print", prompt, "--print-timeout", printTimeout];
  if (flags.model) argv.push("--model", flags.model);
  if (flags["add-dir"]) {
    for (const dir of flags["add-dir"].split(",").map((s) => s.trim()).filter(Boolean)) {
      argv.push("--add-dir", dir);
    }
  }

  const child = spawn(resolveAgyBin(), argv, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    cwd: process.cwd(),
  });
  // ponytail: forward parent SIGTERM/SIGINT to the agy child so the Bash 600s ceiling doesn't orphan it. Without this, codex_bridge dies but agy keeps running, holding the opencli browser bridge indefinitely.
  const forwardAgySignal = () => {
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
    process.exit(143);
  };
  process.on("SIGTERM", forwardAgySignal);
  process.on("SIGINT", forwardAgySignal);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const hardTimeoutMs = parseAgyTimeoutMs(printTimeout) + 10000;
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
    }, hardTimeoutMs);
    child.on("close", (closeCode) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      process.off("SIGTERM", forwardAgySignal);
      process.off("SIGINT", forwardAgySignal);
      resolve(closeCode);
    });
    child.on("error", (e) => fail(`failed to start agy: ${e.message}`));
  });

  if (timedOut) fail(`agy timed out after ${hardTimeoutMs}ms`);
  if (code !== 0) {
    process.stderr.write(Buffer.concat(stderr).toString());
    fail(`agy exited with code ${code}`);
  }

  process.stdout.write(Buffer.concat(stdout));
  process.stdout.write("Plugin evidence: agy via codex_bridge.ts — exit 0\n");
  bumpDispatch();
}

// gpt-pro: dispatch to ChatGPT web Pro via opencli Browser Bridge
async function cmdGptPro(positional: string[], flags: Record<string, string>): Promise<void> {
  const command = positional[0];
  const args: string[] = [];
  if (command === "status") {
    args.push("status");
  } else if (command === "help" || command === "--help" || command === "-h") {
    args.push("help");
  } else if (command === "continue") {
    args.push("continue");
    const url = flags.url;
    if (url) args.push("--url", url);
    if (flags.timeout) args.push("--timeout", flags.timeout);
    if (flags.out) args.push("--out", flags.out);
  } else if (command === "ask") {
    const prompt = positional[1];
    const promptFile = flags["prompt-file"];
    const filePaths = collectRepeatedRawOption(rawArgsAfterSubcommand("gpt-pro"), "--file");
    if (promptFile) {
      if (prompt) fail("gpt-pro ask accepts either <prompt> or --prompt-file, not both");
      args.push("ask", "--prompt-file", promptFile);
    } else {
      if (!prompt && filePaths.length === 0) fail("gpt-pro ask requires a prompt, --prompt-file, or --file");
      if (prompt) args.push("ask", prompt);
      else args.push("ask");
    }
    for (const filePath of filePaths) args.push("--file", filePath);
    if (flags.out) args.push("--out", flags.out);
    if (flags.timeout) args.push("--timeout", flags.timeout);
    if (flags.force) args.push("--force");
  } else {
    fail("gpt-pro requires status, ask, continue, or help");
  }

  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const gptProPath = path.join(scriptDir, "gpt_pro.ts");
  const child = spawn("node", ["--experimental-strip-types", gptProPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    cwd: process.cwd(),
  });
  // ponytail: forward parent SIGTERM/SIGINT to the gpt_pro child so the Bash 600s ceiling doesn't orphan it. Without this, codex_bridge dies but gpt_pro keeps running, holding the opencli browser bridge indefinitely.
  const forwardSignal = () => {
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
    process.exit(143);
  };
  process.on("SIGTERM", forwardSignal);
  process.on("SIGINT", forwardSignal);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutForHardLimit = flags.timeout && /^\d+$/.test(flags.timeout) ? `${flags.timeout}s` : flags.timeout;
  // ponytail: outer budget must cover inner gpt_pro.ts auto-extend ceiling (MAX_AUTO_EXTEND_MS=1800000) + a 60s buffer,
  // otherwise the wrapper SIGTERMs the child mid-extend and long Pro tasks die as "unstable".
  const GPT_PRO_AUTO_EXTEND_CEILING_MS = 30 * 60 * 1000;
  const hardTimeoutMs = (timeoutForHardLimit ? parseAgyTimeoutMs(timeoutForHardLimit) : 900000) + GPT_PRO_AUTO_EXTEND_CEILING_MS + 60000;
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
    }, hardTimeoutMs);
    child.on("close", (closeCode) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      process.off("SIGTERM", forwardSignal);
      process.off("SIGINT", forwardSignal);
      resolve(closeCode);
    });
    child.on("error", (e) => fail(`failed to start gpt-pro: ${e.message}`));
  });

  if (timedOut) fail(`gpt-pro timed out after ${hardTimeoutMs}ms`);
  if (code !== 0) {
    process.stderr.write(Buffer.concat(stderr).toString());
    fail(`gpt-pro exited with code ${code}`);
  }

  process.stdout.write(Buffer.concat(stdout));
  process.stdout.write("Plugin evidence: gpt-pro via codex_bridge.ts — exit 0\n");
  bumpDispatch();
}

// Generate a candidate DAG plan by dispatching a read-only planner packet to the worker.
// Returns structured plan JSON via --output-schema. Leader approves/modifies before 'run'.
async function cmdPlan(args: string[]): Promise<void> {
  // args: <request-file> [--tier <t>] [--out <path>]
  const requestFile = args[0];
  if (!requestFile) {
    console.error("plan: missing <request-file>");
    process.exit(2);
  }
  const parsed = parseFlags(args.slice(1), { tier: "string", out: "string" });
  const request = readFileSync(requestFile, "utf8");
  const packetFields = [
    "packet_id",
    "run_id",
    "kind",
    "model_tier",
    "objective",
    "depends_on",
    "priority",
    "write_globs",
    "base_revision",
  ] satisfies Array<keyof PacketInput>;
  const prompt = "You are a planner. Read the request and decompose it into a dependency-ordered DAG of bounded packets. Return strict JSON matching the output schema. Each packet has: " + packetFields[0] + " (pkt_<n>), " + packetFields[1] + " (omit, filled by caller), " + packetFields[2] + ", " + packetFields[3] + ", " + packetFields[4] + " (one sentence), " + packetFields[5] + " (packet_ids), " + packetFields[6] + " (int), " + packetFields[7] + " (string[]), " + packetFields[8] + " (\"HEAD\"). Only split when there are real dependencies or parallelism benefit; otherwise return a single packet. Max 8 packets. Request:\n" + request;
  const schemaPath = new URL("./schemas/packet-v1.schema.json", import.meta.url);
  // planner uses output-schema to force JSON array of packets
  const outPath = typeof parsed.flags.out === "string" ? parsed.flags.out : undefined;
  const tier = typeof parsed.flags.tier === "string" ? parsed.flags.tier : "strong";
  // delegate to existing ask machinery with output-schema
  const askArgs = [prompt, "--output-schema", schemaPath.pathname, "--tier", tier];
  if (outPath) askArgs.push("--out", outPath);
  // reuse cmdAsk by calling its logic - but cmdAsk is async and reads process.argv.
  // Simpler: spawn this same bridge with 'ask' subcommand.
  const child = spawn(process.execPath, [process.argv[1], "ask", ...askArgs], { stdio: "inherit" });
  const code = await new Promise<number>((resolve) => child.on("exit", (exitCode) => resolve(exitCode ?? 1)));
  console.log("Plugin evidence: plan via codex_bridge.ts — delegated to ask with output-schema");
  if (code !== 0) process.exit(code);
}

// Print run status from the SQLite store. Compact stdout by default, full JSON with --json.
async function cmdStatus(args: string[]): Promise<void> {
  // args: --run <run_id> [--json]
  const parsed = parseFlags(args, { run: "string", json: "boolean" });
  const runId = typeof parsed.flags.run === "string" ? parsed.flags.run : undefined;
  if (!runId) {
    console.error("status: missing --run <run_id>");
    process.exit(2);
  }
  let store: RunStore;
  try {
    store = RunStore.open();
  } catch {
    const empty = {
      run_id: runId,
      status: "unknown",
      accepted: 0,
      rejected: 0,
      stale: 0,
      total: 0,
      ledger_sha: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      evidence_lines: [] as string[],
    };
    if (parsed.flags.json) {
      console.log(JSON.stringify(empty, null, 2));
    } else {
      console.log(`run ${runId}: status=unknown accepted=0/0 rejected=0 stale=0 ledger=(empty)`);
    }
    return;
  }
  try {
    const envelope = store.buildEnvelope(runId);
    if (parsed.flags.json) {
      console.log(JSON.stringify(envelope, null, 2));
    } else {
      console.log(`run ${envelope.run_id}: status=${envelope.status} accepted=${envelope.accepted}/${envelope.total} rejected=${envelope.rejected} stale=${envelope.stale} ledger=${envelope.ledger_sha.slice(0, 12)}`);
      for (const line of envelope.evidence_lines) console.log("  " + line);
    }
  } finally {
    store.close();
  }
}

async function cmdRun(args: string[]): Promise<number> {
  const parsed = parseFlags(args, { plan: "string", "max-parallel": "string", run: "string" });
  const planFile = parsed.flags.plan as string | undefined;
  const existingRun = parsed.flags.run as string | undefined;
  const maxParallel = Math.max(1, parseInt(String(parsed.flags["max-parallel"] ?? "1"), 10) || 1);
  let runId = "";
  let packets: PacketInput[] | undefined;
  let requestHash: string | undefined;
  if (existingRun) {
    runId = existingRun;
  } else if (planFile) {
    const planText = readFileSync(planFile, "utf8");
    const plan = JSON.parse(planText);
    const rawPackets = (plan.packets ?? plan) as any[];
    if (!Array.isArray(rawPackets) || rawPackets.length === 0) {
      console.error("run: plan has no packets");
      return 2;
    }
    runId = "run_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    requestHash = createHash("sha256").update(planText).digest("hex").slice(0, 16);
    packets = rawPackets.map((p) => ({ ...p, run_id: runId }));
  } else {
    console.error("run: requires --plan <file> or --run <run_id>");
    return 2;
  }
  const store = RunStore.open();
  try {
    if (existingRun) {
      const run = store.getRun(runId);
      if (!run) {
        console.error("run: no such run: " + runId);
        return 2;
      }
      store.appendEvent(runId, "__run__", null, "resume_started", {});
    } else if (packets && requestHash) {
      store.createRun(runId, requestHash, packets);
      console.error("run: created " + runId + " with " + packets.length + " packets");
    }
    while (!store.isRunTerminal(runId)) {
      const ready = store.claimReadyPackets(runId, maxParallel);
      if (ready.length === 0) {
        if (hasInFlightPackets(store, runId)) {
          await sleep(500);
          continue;
        }
        console.error("run: DAG deadlock");
        store.setRunStatus(runId, "deadlocked");
        break;
      }
      for (const packetId of ready) {
        const outcome = await executePacket(store, runId, packetId);
        if (outcome.status === "rejected" || outcome.status === "stale") {
          store.failDependents(runId, packetId);
        }
      }
    }

    const envelope = store.buildEnvelope(runId);
    const finalStatus = envelope.accepted === envelope.total ? "succeeded" : (envelope.accepted > 0 ? "partial" : "failed");
    store.setRunStatus(runId, finalStatus);
    console.log(JSON.stringify({ run_id: runId, status: finalStatus, accepted: envelope.accepted, total: envelope.total, rejected: envelope.rejected, stale: envelope.stale, ledger_sha: envelope.ledger_sha }));
    console.log("Plugin evidence: run via codex_bridge.ts — " + runId + " accepted=" + envelope.accepted + "/" + envelope.total);
    return envelope.accepted === envelope.total ? 0 : 1;
  } finally { store.close(); }
}

async function executePacket(store: RunStore, runId: string, packetId: string): Promise<{ status: string; exitCode: number; summary: string }> {
  const pkt = store.getPacket(packetId);
  if (!pkt) throw new Error("packet disappeared: " + packetId);
  const attemptId = store.beginAttempt(packetId, runId, 1);
  const childArgs = [pkt.kind, pkt.objective, "--tier", pkt.model_tier];
  const child = spawn(process.execPath, [process.argv[1], ...childArgs], { stdio: ["ignore", "pipe", "pipe"], shell: false });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 1_000_000) stdout = stdout.slice(-500_000); });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 500_000) stderr = stderr.slice(-250_000); });
  const code = await new Promise<number>((resolve) => {
    child.on("error", () => resolve(-1));
    child.on("exit", (c) => resolve(c ?? -1));
  });
  const status = code === 0 ? "accepted" : "rejected";
  const evLine = stdout.split(String.fromCharCode(10)).filter((line) => line.includes("Plugin evidence:"))[0];
  const outcome = { status, exitCode: code, summary: (evLine ?? stdout.slice(0, 200)).trim() || ("exit " + code) };
  store.applyOutcome(attemptId, packetId, outcome);
  if (status === "accepted") {
    const turnMatch = stdout.match(/turn ([0-9a-f-]+)/);
    store.recordEvidence(runId, packetId, attemptId, pkt.kind, pkt.objective.slice(0, 80), turnMatch ? turnMatch[1] : "unknown");
  }
  return outcome;
}

async function cmdResume(args: string[]): Promise<number> {
  const parsed = parseFlags(args, { run: "string" });
  const runId = parsed.flags.run as string | undefined;
  if (!runId) {
    console.error("resume: missing --run <run_id>");
    return 2;
  }
  return cmdRun(["--run", runId]);
}

function hasInFlightPackets(store: RunStore, runId: string): boolean {
  const env = store.buildEnvelope(runId);
  return env.total > env.accepted + env.rejected + env.stale;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const { sub, positional, flags } = parseArgs(process.argv.slice(2));
  switch (sub) {
    case "ask":            return cmdAsk(positional, flags);
    case "ask-file":       return cmdAskFile(positional, flags);
    case "parse":          return cmdParse(positional, flags);
    case "web":            return cmdWeb(positional, flags);
    case "vision":         return cmdVision(positional, flags);
    case "generate-image": return cmdGenerateImage(positional, flags);
    case "test":           return cmdTest(positional, flags);
    case "mcp-tool":       return cmdMcpTool(positional, flags);
    case "plan":           return cmdPlan(rawArgsAfterSubcommand("plan"));
    case "status":         return cmdStatus(rawArgsAfterSubcommand("status"));
    case "run":            process.exit(await cmdRun(rawArgsAfterSubcommand("run")));
    case "resume":         process.exit(await cmdResume(rawArgsAfterSubcommand("resume")));
    case "agy":            return cmdAgy(positional, flags);
    case "gpt-pro":        return cmdGptPro(positional, flags);
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return;
    default:
      process.stderr.write(USAGE);
      process.exit(1);
  }
}

const USAGE = `codex_bridge — ZCode's leader-only dispatch channel to the resident codex app-server worker.

Usage:
  codex_bridge ask <prompt> [--image <path>] [--detail auto|low|high|original] [--model <m>] [--effort <e>] [--output-schema <file.json>] [--tier <fast|balanced|strong>] [--task-kind <type>]
  codex_bridge ask-file <prompt-file> [--out <result-file>] [--image <path>] [--model <m>] [--effort <e>] [--output-schema <file.json>] [--tier <fast|balanced|strong>] [--task-kind <type>]
      Like ask, but reads the prompt from a file and writes the full result to a file. stdout shows only the result path + evidence. Saves leader context tokens.
  codex_bridge parse <file> [question] [--out <path>] [--tier <t>] [--model <m>] [--effort <e>]
      Read a source file and answer a question about it. Replaces the leader
      reading code directly. Omit question for a default purpose/exports summary.
      Output >800 chars is written to --out (or a temp file); stdout shows path + summary.
  codex_bridge web <query> [--out <path>] [--depth 1-5] [--tier <t>] [--model <m>] [--effort <e>]
      Web research via the resident worker's webSearch. Replaces WebSearch/WebFetch.
      Output >800 chars is written to --out (or a temp file); stdout shows path + summary.
  codex_bridge vision <image-path> <question> [--detail auto|low|high|original]
  codex_bridge generate-image <prompt> [--out <path>] [--timeout <sec>]
  codex_bridge test <prompt> [-- <test-cmd>] [--browser] [--full-access] [--out <file>] [--timeout <sec>] [--tier <t>]
      Run a test suite in an isolated one-shot worker with sandbox (+optional browser). Default timeout 600s.
      Output >800 chars is written to --out (or a temp file); stdout shows path + summary.
  codex_bridge mcp-tool <server> <tool> [--args <json>] [--thread true]
  codex_bridge agy <prompt> [--model <m>] [--timeout <dur>] [--add-dir <dir>]
      Dispatch a task to the local Antigravity CLI (agy) — long-context, multimodal, live web.
  codex_bridge plan <request-file> [--tier <t>] [--out <path>]
      Generate a candidate DAG plan (read-only planner packet).
  codex_bridge status --run <run_id> [--json]
      Print run status from the SQLite store.
  codex_bridge run --plan <plan.json> [--max-parallel 1]
      Execute an approved DAG plan to completion (SLW join point).
  codex_bridge run --run <run_id>
      Resume an interrupted run.
  codex_bridge resume --run <run_id>
      Alias for 'run --run'.
  codex_bridge gpt-pro ask [<prompt> | --prompt-file <file>] [--file <path> ...] [--out <file>] [--timeout <sec>]
  codex_bridge gpt-pro continue [--url <url>] [--timeout <sec>] [--out <file>]
      Resume a timed-out gpt-pro conversation by reopening its saved /c/<id> URL.
  codex_bridge gpt-pro status
  codex_bridge gpt-pro help
      Dispatch to ChatGPT web Pro via opencli Browser Bridge.
  codex_bridge help

Each command prints a trailing "Plugin evidence:" line for the Stop gate.
`;

main().then(() => {
  // Force exit: the resident worker is detached and the WebSocket may keep the
  // event loop alive. The bridge is a one-shot CLI; once work is done, exit.
  process.exit(0);
}).catch((e) => fail(e?.message || String(e)));
