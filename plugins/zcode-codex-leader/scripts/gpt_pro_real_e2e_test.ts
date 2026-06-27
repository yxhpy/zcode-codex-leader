#!/usr/bin/env node
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync } from "fs";
import os from "os";
import path from "path";

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const bridgePath = path.join(scriptDir, "codex_bridge.ts");
const pluginData = mkdtempSync(path.join(os.tmpdir(), "gpt-pro-real-e2e-"));
const marker = process.env.GPT_PRO_REAL_E2E_MARKER || "ZCODE_PRO_MODEL_E2E_DONE";
const model = process.env.GPT_PRO_REAL_E2E_MODEL || "Pro 扩展";
const pollMs = Number(process.env.GPT_PRO_REAL_E2E_POLL_MS || "10000");
const staleHeartbeatSec = Number(process.env.GPT_PRO_REAL_E2E_STALE_HEARTBEAT_SEC || "180");
const resultFile = path.join(pluginData, "gpt-pro-real-e2e-result.txt");
const prompt = process.env.GPT_PRO_REAL_E2E_PROMPT || `长任务稳定性验证：请用中文生成一份 160 行的编号清单，每行都必须不同，主题围绕 Pro 模型、后台长任务、心跳、轮询、恢复、超时、结果收集、部分输出和失败诊断。最后一行只写 ${marker}。不要使用 Markdown 表格，不要提前结束。`;

function runBridge(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", bridgePath, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, PLUGIN_DATA: pluginData },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return { code: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function field(output: string, name: string): string {
  return output.match(new RegExp(`^${name}:(.*)$`, "m"))?.[1]?.trim() || "";
}

function fail(message: string, details: string[] = []): never {
  process.stderr.write(`${message}\n`);
  process.stderr.write(`PLUGIN_DATA:${pluginData}\n`);
  for (const detail of details) {
    if (detail.trim()) process.stderr.write(`${detail.trim()}\n`);
  }
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const start = runBridge(["gpt-pro", "ask", prompt, "--model", model, "--out", resultFile]);
  if (start.code !== 0) {
    fail("gpt_pro_real_e2e_test: failed to start gpt-pro background task", [start.stdout, start.stderr]);
  }

  const taskId = field(start.stdout, "TASK_ID");
  const taskFile = field(start.stdout, "TASK_FILE");
  const startedResultFile = field(start.stdout, "RESULT_FILE") || resultFile;
  const startedModel = field(start.stdout, "MODEL");
  if (startedModel !== model) {
    fail("gpt_pro_real_e2e_test: start output missing requested model", [start.stdout, start.stderr]);
  }
  if (!taskId || !taskFile) {
    fail("gpt_pro_real_e2e_test: start output missing task fields", [start.stdout, start.stderr]);
  }

  for (;;) {
    const last = runBridge(["gpt-pro", "collect", "--task-id", taskId]);
    const status = field(last.stdout, "STATUS");
    const heartbeatAge = Number(field(last.stdout, "HEARTBEAT_AGE_SEC") || "0");
    if (last.code !== 0) {
      fail("gpt_pro_real_e2e_test: collect command failed", [
        `TASK_ID:${taskId}`,
        `TASK_FILE:${taskFile}`,
        `RESULT_FILE:${startedResultFile}`,
        last.stdout,
        last.stderr,
      ]);
    }
    if (status === "completed") {
      if (field(last.stdout, "MODEL") !== model) {
        fail("gpt_pro_real_e2e_test: collect output missing requested model", [
          `TASK_ID:${taskId}`,
          `TASK_FILE:${taskFile}`,
          `RESULT_FILE:${startedResultFile}`,
          last.stdout,
          last.stderr,
        ]);
      }
      const text = existsSync(startedResultFile) ? readFileSync(startedResultFile, "utf8") : last.stdout;
      if (!text.includes(marker)) {
        fail("gpt_pro_real_e2e_test: completed result missing marker", [
          `TASK_ID:${taskId}`,
          `TASK_FILE:${taskFile}`,
          `RESULT_FILE:${startedResultFile}`,
          last.stdout,
          last.stderr,
        ]);
      }
      process.stdout.write(`gpt_pro_real_e2e_test: PASS TASK_ID=${taskId} RESULT_FILE=${startedResultFile}\n`);
      return;
    }
    if (["failed", "cancelled", "timed-out", "stale"].includes(status)) {
      const partial = runBridge(["gpt-pro", "collect", "--task-id", taskId, "--partial"]);
      fail(`gpt_pro_real_e2e_test: task ended with status=${status}`, [
        `TASK_ID:${taskId}`,
        `TASK_FILE:${taskFile}`,
        `RESULT_FILE:${startedResultFile}`,
        partial.stdout || last.stdout,
        partial.stderr || last.stderr,
      ]);
    }
    if (Number.isFinite(heartbeatAge) && heartbeatAge > staleHeartbeatSec) {
      fail("gpt_pro_real_e2e_test: heartbeat stopped", [
        `TASK_ID:${taskId}`,
        `TASK_FILE:${taskFile}`,
        `RESULT_FILE:${startedResultFile}`,
        `HEARTBEAT_AGE_SEC:${heartbeatAge}`,
        last.stdout,
        last.stderr,
      ]);
    }
    await sleep(pollMs);
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
