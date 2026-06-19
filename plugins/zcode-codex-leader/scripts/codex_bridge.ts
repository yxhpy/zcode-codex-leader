#!/usr/bin/env -S node --experimental-strip-types
// codex_bridge.ts — ZCode's only legal channel for doing implementation work.
//
// Subcommands:
//   ask <prompt> [--image <path>] [--model <m>] [--output-schema <file>] [--effort <e>]
//       Code generation / parsing. Optional local image, model, reasoning effort,
//       and JSON-Schema-constrained structured output.
//   vision <image-path> <question>
//       Visual understanding of a local image.
//   generate-image <prompt> [--out <path>]
//       Image generation via the worker's image_generation_call capability.
//   mcp-tool <server> <tool> [--args <json>] [--thread]
//       Direct MCP tool call (bypasses a turn).
//   agy <prompt> [--model <m>] [--timeout <dur>] [--add-dir <dir>]
//       Dispatch a task to the local Antigravity CLI (agy) — long-context,
//       multimodal, live web.
//
// Each successful call bumps the session dispatch count and prints a trailing
// "Plugin evidence:" line so ZCode can aggregate evidence for the Stop gate.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { runTurn, callMcpTool, bumpDispatch, pluginDataDir } from "./app_server_pool.ts";

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
  if (flags["output-schema"]) opts.outputSchema = readJsonFile(flags["output-schema"]);

  const r = await runTurn(input, opts);
  bumpDispatch();
  // print agent messages (the actual answer)
  for (const m of r.messages) process.stdout.write(m + "\n");
  process.stdout.write(`Plugin evidence: ask via codex_bridge.ts — turn ${r.turnId}\n`);
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

// generate-image: image generation via image_generation_call
async function cmdGenerateImage(positional: string[], flags: Record<string, string>): Promise<void> {
  const prompt = positional.join(" ").trim();
  if (!prompt) fail("generate-image requires a prompt");
  const r = await runTurn([{ type: "text", text: `Generate an image: ${prompt}` }]);
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

async function main(): Promise<void> {
  const { sub, positional, flags } = parseArgs(process.argv.slice(2));
  switch (sub) {
    case "ask":            return cmdAsk(positional, flags);
    case "vision":         return cmdVision(positional, flags);
    case "generate-image": return cmdGenerateImage(positional, flags);
    case "mcp-tool":       return cmdMcpTool(positional, flags);
    case "agy":            return cmdAgy(positional, flags);
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
  codex_bridge ask <prompt> [--image <path>] [--detail auto|low|high|original] [--model <m>] [--effort <e>] [--output-schema <file.json>]
  codex_bridge vision <image-path> <question> [--detail auto|low|high|original]
  codex_bridge generate-image <prompt> [--out <path>]
  codex_bridge mcp-tool <server> <tool> [--args <json>] [--thread true]
  codex_bridge agy <prompt> [--model <m>] [--timeout <dur>] [--add-dir <dir>]
      Dispatch a task to the local Antigravity CLI (agy) — long-context, multimodal, live web.
  codex_bridge help

Each command prints a trailing "Plugin evidence:" line for the Stop gate.
`;

main().then(() => {
  // Force exit: the resident worker is detached and the WebSocket may keep the
  // event loop alive. The bridge is a one-shot CLI; once work is done, exit.
  process.exit(0);
}).catch((e) => fail(e?.message || String(e)));
