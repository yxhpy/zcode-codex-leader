#!/usr/bin/env -S node --experimental-strip-types

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const scriptPath = path.join(scriptDir, "gpt_pro.ts");
const nodeArgs = ["--experimental-strip-types", scriptPath];

function run(pluginData: string, args: string[], extraEnv: Record<string, string> = {}): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [...nodeArgs, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, PLUGIN_DATA: pluginData, ...extraEnv },
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function runBridge(pluginData: string, args: string[], extraEnv: Record<string, string> = {}): { code: number | null; stdout: string; stderr: string } {
  const bridgePath = path.join(scriptDir, "codex_bridge.ts");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", bridgePath, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, PLUGIN_DATA: pluginData, ...extraEnv },
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function runAsync(pluginData: string, args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, PLUGIN_DATA: pluginData, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
  });
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function field(stdout: string, key: string): string {
  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith(`${key}:`));
  return line ? line.slice(key.length + 1).trim() : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testStartPollCollect(): Promise<void> {
  const pluginData = mkdtempSync(path.join(os.tmpdir(), "gpt-pro-bg-test-"));
  const start = run(pluginData, ["start", "ask", "hello from fake worker", "--timeout", "5"], {
    GPT_PRO_TEST_FAKE_WORKER: "1",
    GPT_PRO_FAKE_DELAY_MS: "120",
  });
  assert(start.code === 0, `start failed\nstdout=${start.stdout}\nstderr=${start.stderr}`);
  const taskId = field(start.stdout, "TASK_ID");
  const taskFile = field(start.stdout, "TASK_FILE");
  const resultFile = field(start.stdout, "RESULT_FILE");
  assert(taskId, "start did not print TASK_ID");
  assert(taskFile && existsSync(taskFile), "start did not create TASK_FILE");
  assert(resultFile, "start did not print RESULT_FILE");

  const poll = run(pluginData, ["poll", "--task-id", taskId]);
  assert(poll.code === 0, `poll failed\nstdout=${poll.stdout}\nstderr=${poll.stderr}`);
  assert(field(poll.stdout, "STATUS"), "poll did not print STATUS");

  await sleep(350);
  const collect = run(pluginData, ["collect", "--task-id", taskId]);
  assert(collect.code === 0, `collect failed\nstdout=${collect.stdout}\nstderr=${collect.stderr}`);
  assert(field(collect.stdout, "STATUS") === "completed", `expected completed collect\n${collect.stdout}`);
  assert(existsSync(resultFile), "result file missing after fake worker completion");
  assert(readFileSync(resultFile, "utf8").includes("fake gpt-pro ask result"), "unexpected fake result body");
  assert(field(collect.stdout, "SUMMARY").includes("fake gpt-pro ask result"), "collect did not print compact summary");
}

async function testCancelBackgroundTask(): Promise<void> {
  const pluginData = mkdtempSync(path.join(os.tmpdir(), "gpt-pro-bg-cancel-"));
  const start = run(pluginData, ["start", "ask", "cancel me", "--timeout", "5"], {
    GPT_PRO_TEST_FAKE_WORKER: "1",
    GPT_PRO_FAKE_DELAY_MS: "1000",
  });
  assert(start.code === 0, `cancel start failed\nstdout=${start.stdout}\nstderr=${start.stderr}`);
  const taskId = field(start.stdout, "TASK_ID");
  assert(taskId, "cancel start missing TASK_ID");
  const cancel = run(pluginData, ["cancel", "--task-id", taskId]);
  assert(cancel.code === 0, `cancel failed\nstdout=${cancel.stdout}\nstderr=${cancel.stderr}`);
  assert(field(cancel.stdout, "STATUS") === "cancelled", `expected cancelled status\n${cancel.stdout}`);
  await sleep(1200);
  const poll = run(pluginData, ["poll", "--task-id", taskId]);
  assert(field(poll.stdout, "STATUS") === "cancelled", `fake worker overwrote cancelled status\n${poll.stdout}`);
}

async function testConcurrentStartSingleton(): Promise<void> {
  const pluginData = mkdtempSync(path.join(os.tmpdir(), "gpt-pro-bg-concurrent-"));
  const env = { GPT_PRO_TEST_FAKE_WORKER: "1", GPT_PRO_FAKE_DELAY_MS: "1000" };
  const [a, b] = await Promise.all([
    runAsync(pluginData, ["start", "ask", "concurrent one", "--timeout", "5"], env),
    runAsync(pluginData, ["start", "ask", "concurrent two", "--timeout", "5"], env),
  ]);
  const successes = [a, b].filter((result) => result.code === 0);
  const failures = [a, b].filter((result) => result.code !== 0);
  assert(successes.length === 1, `expected exactly one concurrent start success\na=${a.code}\n${a.stdout}\n${a.stderr}\nb=${b.code}\n${b.stdout}\n${b.stderr}`);
  assert(failures.length === 1, "expected exactly one concurrent start failure");
  assert(/active gpt-pro background task exists|singleton worker lock/.test(failures[0].stderr + failures[0].stdout), `unexpected concurrent failure output\n${failures[0].stdout}\n${failures[0].stderr}`);
}

function testDefaultAskActiveBackgroundGuard(): void {
  const pluginData = mkdtempSync(path.join(os.tmpdir(), "gpt-pro-bg-active-guard-"));
  const tasksDir = path.join(pluginData, "gpt-pro/tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(path.join(tasksDir, "active.json"), JSON.stringify({
    schemaVersion: 2,
    taskId: "active",
    status: "running",
    pid: process.pid,
    heartbeatAt: Date.now(),
    createdAt: Date.now(),
    resultPath: path.join(pluginData, "active-result.txt"),
  }, null, 2));

  const ask = run(pluginData, ["ask", "do not bypass active background"], { OPENCLI_BIN: "/definitely/missing/opencli" });
  assert(ask.code === 2, `active background foreground ask should be refused\nstdout=${ask.stdout}\nstderr=${ask.stderr}`);
  assert(ask.stderr.includes("active gpt-pro background task exists"), `active background guard message missing\n${ask.stderr}`);
  assert(field(ask.stdout, "TASK_ID") === "active", `active background guard should print compact task fields\n${ask.stdout}`);
}

function writeLegacyRecoverableTask(pluginData: string): void {
  writeFileSync(path.join(pluginData, "gpt-pro-task.json"), JSON.stringify({
    conversationUrl: "https://chatgpt.com/c/recoverable",
    conversationId: "recoverable",
    prompt: "old prompt",
    baselineCount: 1,
    sentAt: Date.now(),
    status: "timed-out",
    partialText: "partial",
  }, null, 2));
}

function writeRecoverableV2Task(pluginData: string): void {
  const tasksDir = path.join(pluginData, "gpt-pro/tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(path.join(tasksDir, "recoverable-v2.json"), JSON.stringify({
    schemaVersion: 2,
    taskId: "recoverable-v2",
    status: "timed-out",
    conversationUrl: "https://chatgpt.com/c/recoverable-v2",
    conversationId: "recoverable-v2",
    prompt: "old v2 prompt",
    sentAt: Date.now(),
    createdAt: Date.now(),
    resultPath: path.join(pluginData, "recoverable-v2-result.txt"),
    partialText: "partial v2",
  }, null, 2));
}

function testDefaultAskRecoverableV2Guard(): void {
  const pluginData = mkdtempSync(path.join(os.tmpdir(), "gpt-pro-bg-v2-guard-"));
  writeRecoverableV2Task(pluginData);
  const ask = run(pluginData, ["ask", "do not duplicate v2 recoverable", "--timeout", "5"], {
    GPT_PRO_TEST_FAKE_WORKER: "1",
  });
  assert(ask.code === 2, `recoverable v2 default ask should be refused\nstdout=${ask.stdout}\nstderr=${ask.stderr}`);
  assert(ask.stderr.includes("recoverable gpt-pro task exists"), `recoverable v2 guard message missing\n${ask.stderr}`);
  assert(field(ask.stdout, "TASK_ID") === "recoverable-v2", `recoverable v2 guard should print existing task fields\n${ask.stdout}`);
}

function testStartAskRecoverableLegacyGuard(): void {
  const pluginData = mkdtempSync(path.join(os.tmpdir(), "gpt-pro-bg-start-legacy-"));
  writeLegacyRecoverableTask(pluginData);
  const start = run(pluginData, ["start", "ask", "do not redispatch", "--timeout", "5"], {
    GPT_PRO_TEST_FAKE_WORKER: "1",
  });
  assert(start.code === 2, `recoverable legacy start ask should be refused\nstdout=${start.stdout}\nstderr=${start.stderr}`);
  assert(start.stderr.includes("recoverable legacy gpt-pro task exists"), `recoverable legacy start guard message missing\n${start.stderr}`);
  assert(field(start.stdout, "CONVERSATION_URL") === "https://chatgpt.com/c/recoverable", `start guard should print legacy task fields\n${start.stdout}`);
}

function testDefaultAskRecoverableGuard(): void {
  const pluginData = mkdtempSync(path.join(os.tmpdir(), "gpt-pro-bg-guard-"));
  writeLegacyRecoverableTask(pluginData);

  const ask = run(pluginData, ["ask", "do not redispatch"], { OPENCLI_BIN: "/definitely/missing/opencli" });
  assert(ask.code === 2, `recoverable foreground ask should be refused\nstdout=${ask.stdout}\nstderr=${ask.stderr}`);
  assert(ask.stderr.includes("Do NOT re-run ask"), `recoverable guard message missing\n${ask.stderr}`);
}

function testStaleDetection(): void {
  const pluginData = mkdtempSync(path.join(os.tmpdir(), "gpt-pro-bg-stale-"));
  const tasksDir = path.join(pluginData, "gpt-pro/tasks");
  mkdirSync(tasksDir, { recursive: true });
  const taskFile = path.join(tasksDir, "stale.json");
  writeFileSync(taskFile, JSON.stringify({
    schemaVersion: 2,
    taskId: "stale",
    status: "running",
    pid: 999999,
    heartbeatAt: 1,
    createdAt: 1,
    resultPath: path.join(pluginData, "missing.txt"),
  }, null, 2));

  const poll = run(pluginData, ["poll", "--task-id", "stale"]);
  assert(poll.code === 0, `stale poll failed\nstdout=${poll.stdout}\nstderr=${poll.stderr}`);
  assert(field(poll.stdout, "STATUS") === "stale", `expected stale status\n${poll.stdout}`);
  const saved = JSON.parse(readFileSync(taskFile, "utf8"));
  assert(saved.status === "stale", "poll did not persist stale status");
}

async function testDefaultAskStartsBackgroundTask(): Promise<void> {
  const pluginData = mkdtempSync(path.join(os.tmpdir(), "gpt-pro-bg-default-ask-"));
  const ask = run(pluginData, ["ask", "hello from default background ask", "--timeout", "5"], {
    GPT_PRO_TEST_FAKE_WORKER: "1",
    GPT_PRO_FAKE_DELAY_MS: "120",
  });
  assert(ask.code === 0, `default ask should start a background task\nstdout=${ask.stdout}\nstderr=${ask.stderr}`);
  const taskId = field(ask.stdout, "TASK_ID");
  const taskFile = field(ask.stdout, "TASK_FILE");
  const resultFile = field(ask.stdout, "RESULT_FILE");
  assert(taskId, "default ask did not print TASK_ID");
  assert(taskFile && existsSync(taskFile), "default ask did not create TASK_FILE");
  assert(resultFile, "default ask did not print RESULT_FILE");

  await sleep(350);
  const collect = run(pluginData, ["collect", "--task-id", taskId]);
  assert(collect.code === 0, `collect default ask failed\nstdout=${collect.stdout}\nstderr=${collect.stderr}`);
  assert(field(collect.stdout, "STATUS") === "completed", `default ask task did not complete\n${collect.stdout}`);
  assert(existsSync(resultFile), "default ask result file missing");
}

async function testDefaultAskPersistsModel(): Promise<void> {
  const pluginData = mkdtempSync(path.join(os.tmpdir(), "gpt-pro-bg-model-"));
  const ask = run(pluginData, ["ask", "hello from model ask", "--model", "Pro 扩展", "--timeout", "5"], {
    GPT_PRO_TEST_FAKE_WORKER: "1",
    GPT_PRO_FAKE_DELAY_MS: "120",
  });
  assert(ask.code === 0, `default ask with model should start a background task\nstdout=${ask.stdout}\nstderr=${ask.stderr}`);
  const taskFile = field(ask.stdout, "TASK_FILE");
  assert(field(ask.stdout, "MODEL") === "Pro 扩展", `default ask should print MODEL\n${ask.stdout}`);
  const saved = JSON.parse(readFileSync(taskFile, "utf8"));
  assert(saved.model === "Pro 扩展", `default ask should persist model\n${readFileSync(taskFile, "utf8")}`);
}

function testBackgroundAskDoesNotPersistTotalTimeout(): void {
  const pluginData = mkdtempSync(path.join(os.tmpdir(), "gpt-pro-bg-no-timeout-"));
  const ask = run(pluginData, ["ask", "hello from no timeout ask", "--timeout", "5"], {
    GPT_PRO_TEST_FAKE_WORKER: "1",
  });
  assert(ask.code === 0, `background ask should start without a total timeout\nstdout=${ask.stdout}\nstderr=${ask.stderr}`);
  const taskFile = field(ask.stdout, "TASK_FILE");
  const saved = JSON.parse(readFileSync(taskFile, "utf8"));
  assert(saved.timeoutSec === undefined, `background ask should not persist timeoutSec\n${readFileSync(taskFile, "utf8")}`);
  assert(saved.deadlineAt === undefined, `background ask should not persist deadlineAt\n${readFileSync(taskFile, "utf8")}`);
  assert(saved.absoluteCeilingAt === undefined, `background ask should not persist absoluteCeilingAt\n${readFileSync(taskFile, "utf8")}`);
}

async function testBridgeAskForwardsModel(): Promise<void> {
  const pluginData = mkdtempSync(path.join(os.tmpdir(), "gpt-pro-bg-bridge-model-"));
  const ask = runBridge(pluginData, ["gpt-pro", "ask", "hello from bridge model ask", "--model", "Pro 扩展", "--timeout", "5"], {
    GPT_PRO_TEST_FAKE_WORKER: "1",
    GPT_PRO_FAKE_DELAY_MS: "120",
  });
  assert(ask.code === 0, `bridge ask --model should start a background task\nstdout=${ask.stdout}\nstderr=${ask.stderr}`);
  const taskFile = field(ask.stdout, "TASK_FILE");
  assert(field(ask.stdout, "MODEL") === "Pro 扩展", `bridge ask should print MODEL\n${ask.stdout}`);
  const saved = JSON.parse(readFileSync(taskFile, "utf8"));
  assert(saved.model === "Pro 扩展", `bridge ask should persist model\n${readFileSync(taskFile, "utf8")}`);
}

async function testDefaultContinueStartsBackgroundTask(): Promise<void> {
  const pluginData = mkdtempSync(path.join(os.tmpdir(), "gpt-pro-bg-default-continue-"));
  const resume = run(pluginData, ["continue", "--url", "https://chatgpt.com/c/stability-test", "--timeout", "5"], {
    GPT_PRO_TEST_FAKE_WORKER: "1",
    GPT_PRO_FAKE_DELAY_MS: "120",
  });
  assert(resume.code === 0, `default continue should start a background task\nstdout=${resume.stdout}\nstderr=${resume.stderr}`);
  const taskId = field(resume.stdout, "TASK_ID");
  const taskFile = field(resume.stdout, "TASK_FILE");
  const resultFile = field(resume.stdout, "RESULT_FILE");
  assert(taskId, "default continue did not print TASK_ID");
  assert(taskFile && existsSync(taskFile), "default continue did not create TASK_FILE");
  assert(resultFile, "default continue did not print RESULT_FILE");

  await sleep(350);
  const collect = run(pluginData, ["collect", "--task-id", taskId]);
  assert(collect.code === 0, `collect default continue failed\nstdout=${collect.stdout}\nstderr=${collect.stderr}`);
  assert(field(collect.stdout, "STATUS") === "completed", `default continue task did not complete\n${collect.stdout}`);
  assert(existsSync(resultFile), "default continue result file missing");
}

async function testBridgeContinueForwardsTaskId(): Promise<void> {
  const pluginData = mkdtempSync(path.join(os.tmpdir(), "gpt-pro-bg-bridge-continue-"));
  const taskId = "resume-task";
  const tasksDir = path.join(pluginData, "gpt-pro/tasks");
  const resultFile = path.join(pluginData, "resume-result.txt");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(path.join(tasksDir, `${taskId}.json`), JSON.stringify({
    schemaVersion: 2,
    taskId,
    status: "timed-out",
    conversationUrl: "https://chatgpt.com/c/resume-task",
    resultPath: resultFile,
    outPath: resultFile,
    createdAt: Date.now(),
  }, null, 2));

  const resume = runBridge(pluginData, ["gpt-pro", "continue", "--task-id", taskId, "--timeout", "5"], {
    GPT_PRO_TEST_FAKE_WORKER: "1",
    GPT_PRO_FAKE_DELAY_MS: "120",
  });
  assert(resume.code === 0, `bridge continue --task-id should start a background task\nstdout=${resume.stdout}\nstderr=${resume.stderr}`);
  assert(field(resume.stdout, "TASK_ID") === taskId, `bridge continue did not preserve task id\n${resume.stdout}`);

  await sleep(350);
  const collect = run(pluginData, ["collect", "--task-id", taskId]);
  assert(collect.code === 0, `collect bridge continue failed\nstdout=${collect.stdout}\nstderr=${collect.stderr}`);
  assert(field(collect.stdout, "STATUS") === "completed", `bridge continue task did not complete\n${collect.stdout}`);
  assert(existsSync(resultFile), "bridge continue result file missing");
}

async function main(): Promise<void> {
  await testStartPollCollect();
  await testDefaultAskStartsBackgroundTask();
  await testDefaultAskPersistsModel();
  testBackgroundAskDoesNotPersistTotalTimeout();
  await testDefaultContinueStartsBackgroundTask();
  await testBridgeAskForwardsModel();
  await testBridgeContinueForwardsTaskId();
  await testCancelBackgroundTask();
  await testConcurrentStartSingleton();
  testDefaultAskActiveBackgroundGuard();
  testDefaultAskRecoverableV2Guard();
  testStartAskRecoverableLegacyGuard();
  testDefaultAskRecoverableGuard();
  testStaleDetection();
  process.stdout.write("gpt_pro_background_test: PASS\n");
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
