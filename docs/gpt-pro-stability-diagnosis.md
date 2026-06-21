# gpt-pro 长任务不稳定性诊断报告

**日期**: 2026-06-21
**触发**: 用户报告「gpt-pro 长任务依然不稳定」
**结论**: 根因不是单点 bug，而是 **dispatch 超时栈的层数与最外层 Bash 工具 600s ceiling 不匹配**。已应用的两个补丁是必要但不充分的修复。

---

## 调查路径（含中途修正，完整呈现）

### 第一轮诊断（错误，已修正）

最初假设 gpt-pro 走 codex app-server pool 的 `runTurn`，撞上 `POST_TOOL_QUIET_TIMEOUT_MS=90000`（90s 静默杀手）。

**证据**：本会话中 `parse` 命令确实被 hang-killer 杀过一次（`reason=postToolQuiet elapsed=136s`）。

**修正**：派 worker 解析 `codex_bridge.ts` 后发现 gpt-pro **不走 pool**。它走独立的 `spawn` 子进程路径（`codex_bridge.ts:447`），完全不经过 `runTurn` / app_server_pool。第一轮诊断瞄准错了对象。

### 第二轮诊断（部分正确）

发现真实矛盾：`gpt_pro.ts` 内部 auto-extend 上限 `MAX_AUTO_EXTEND_MS=1800000`（+30min），但 `codex_bridge.ts:466` 外层 hard timeout = `--timeout + 60s`（默认 960s = 16min）。外层会在内部续命跑完前 SIGTERM 子进程。

应用补丁 #1：外层预算改为 `--timeout + 30min(内部续命上限) + 60s buffer`，默认 960s → 2760s（46min）。

发现 stale-lock：`gpt-pro-task.json` 无 pid、无 heartbeat，bridge 崩溃后任务永远卡在 `generating`，新 ask 被 2h 死循环防护挡住。

应用补丁 #2：task 文件加 `pid` + `heartbeatAt`，新增 `isPidAlive()`（stdlib `process.kill(pid,0)`），ask 检测到 generating 但 pid 已死时自动清锁放行。

### 第三轮诊断（真根因，端到端测试暴露）

跑真实 Pro 长任务做端到端验证。task 文件正确写入（pid 62507、heartbeatAt、conversationUrl 生成）——**两个补丁都工作正常**。任务跑过 10min 没被 gpt-pro 内部超时杀——**补丁 #1 生效**（旧逻辑 16min 就死）。

**但 Bash 工具在 600s（10min）主动 abort 整个命令**。abort 杀了 `codex_bridge.ts` 的 spawn 父进程链 → 子进程 pid 62507 被连带杀死（attached spawn，无 `detached:true`）→ 结果文件 MISSING（gpt_pro.ts 的 `--out` 写入逻辑在进程被杀前没机会执行）。Pro 额度白烧。

---

## 完整超时栈（从外到内）

```
ZCode Bash 工具                          ceiling: 600s (10min)  ← 最短板
  └─ codex_bridge.ts gpt-pro ask          budget: --timeout+30min+60s (补丁后 46min)
      └─ gpt_pro.ts spawn                 internal: 900s + auto-extend +30min
          └─ opencli Browser Bridge       驱动 ChatGPT 网页，长任务可达数十分钟
```

**Bash 600s ceiling 是整个栈最外面的、最短的墙**。无论内层怎么调，任务实际运行 >10min 就会被 Bash 工具 abort。

关键证据（`codex_bridge.ts` parse）：
- gpt-pro spawn **attached**，无 `detached:true`（`codex_bridge.ts:447-451`）——父进程死，子进程连带死
- gpt-pro dispatch **纯阻塞等待** child close（`codex_bridge.ts:464-476`），**无 polling、无 result-file 轮询机制**
- agy 同样 attached、纯阻塞（`codex_bridge.ts:373-377, 386-398`），default print-timeout 20min——**同样会被 Bash 600s 杀**
- codex_bridge.ts 对外层 Bash ceiling **零感知**（无 600000 常量）

---

## 已应用的补丁（保留）

### 补丁 #1 — `codex_bridge.ts:460-463`
外层 hard timeout 从 `--timeout + 60s` 改为 `--timeout + 30min(内部续命上限) + 60s buffer`。

```ts
// ponytail: outer budget must cover inner gpt_pro.ts auto-extend ceiling (MAX_AUTO_EXTEND_MS=1800000) + a 60s buffer,
// otherwise the wrapper SIGTERMs the child mid-extend and long Pro tasks die as "unstable".
const GPT_PRO_AUTO_EXTEND_CEILING_MS = 30 * 60 * 1000;
const hardTimeoutMs = (timeoutForHardLimit ? parseAgyTimeoutMs(timeoutForHardLimit) : 900000) + GPT_PRO_AUTO_EXTEND_CEILING_MS + 60000;
```

**评估**：必要但不充分。逻辑正确（单元测试 3/3 PASS），但被更外面的 Bash 600s ceiling 盖住，实际跑不到 46min。当用户**在终端直接跑 `gpt-pro ask`**（不经过 ZCode Bash 工具）时，这个补丁才真正生效。

### 补丁 #2 — `gpt_pro.ts` stale-lock 清理
- `GptProTask` 加 `pid?: number` + `heartbeatAt?: number`（`gpt_pro.ts:21-22`）
- 新增 `isPidAlive()` stdlib 实现（`gpt_pro.ts:78-82`）
- ask 在死循环防护前先检测：generating 但 pid 已死 → 自动清锁放行（`gpt_pro.ts:708-714`）
- 初始 task 写入记录 `pid: process.pid` + `heartbeatAt`（`gpt_pro.ts:803-804`）

**评估**：真实有效。集成测试（用真实卡住的 task 文件）证明旧 task 无 pid → 自动判定 stale → 清锁放行。这个修复**不依赖超时栈**，对「bridge 崩溃后死锁」这个具体痛点是完整修复。

---

## 未解的真根因：Bash 600s ceiling vs SLW

### 冲突点

Constitution 的 SLW（同步轻量等待）规则要求：
> 每个 dispatch 必须在同一个 ZCode turn 内 dispatch 并回收；禁止 `run_in_background`。Bash call 阻塞直到 codex_bridge.ts 退出。

但 Bash 工具自身有 600s（10min）硬 ceiling。任何实际运行 >10min 的 gpt-pro/agy 任务：
- 按 SLW 必须 foreground → 被 600s ceiling 杀
- 要避开 600s 必须 background → 违反 SLW

**这是架构层面的死结**，不是补丁能解的。

### 影响范围

- **gpt-pro 长任务**（深度推理 >10min）：必死
- **agy 长任务**（长上下文研究，default 20min）：必死
- **gpt-pro continue**（续接超时对话）：同样必死，因为也是阻塞 spawn

### 短期 workaround（不改架构）

**用户在终端直接跑 gpt-pro，不经过 ZCode**：
```bash
node --experimental-strip-types \
  ~/.zcode/cli/plugins/cache/zcode-plugins-official/zcode-codex-leader/0.8.0/scripts/codex_bridge.ts \
  gpt-pro ask "<prompt>" --out <file> --timeout 2400
```
这样没有 Bash 600s ceiling，补丁 #1 的 46min 预算真正生效，内部续命能跑完。

### 根治方向（需架构改动，本报告不实施）

1. **gpt-pro/agy spawn 改 `detached:true` + 结果文件轮询**：ZCode turn 内只发起任务（秒级返回），后续 turn 轮询结果文件。但这违反 SLW，需同时改 constitution。
2. **codex_bridge.ts 识别 Bash ceiling**：检测到 dispatch 预算 >600s 时，主动告诉 leader「这个任务必须后台跑，请轮询」，而不是阻塞等死。
3. **ZCode harness 抬高 Bash ceiling**：最简单但最不现实，600s 是为了防 runaway。

---

## 调查中暴露的其他问题

### leader gate 拦只读进程检查
诊断中 leader 连 `ps -p <pid>`、`node -e 'process.kill(pid,0)'` 这种**只读进程状态检查**都被 gate 拦，必须 dispatch worker 才能查进程死活。诊断效率极低。建议把进程只读查询加入 Bash allowlist。

### parse worker 自己撞 hang-killer
本会话中 `parse` 命令被 90s postToolQuiet hang-killer 杀过一次——原因是 worker 试图 load 一个不存在的 review skill 文件，静默 >90s。这说明 hang-killer 对「worker 在做合理的文件加载/思考」也会误杀。但这个属于 codex app-server pool 的范畴，不影响 gpt-pro（gpt-pro 不走 pool）。

---

## 给用户的实操建议

1. **短任务（<10min）**：照常用 `gpt-pro ask`，补丁让短任务更稳。
2. **长任务（>10min）**：**在终端直接跑**，别经过 ZCode Bash 工具。补丁 #1 在这种场景才真正生效。
3. **遇到卡死的 generating task**：不用 `--force`，直接再跑一次 `gpt-pro ask`，补丁 #2 会自动检测 pid 已死并清锁。旧的 `--force` 仍然可用。
4. **额度不会因补丁少烧**：真正的死 task（pid 死了）才清；活着的 task 仍按 2h 死循环防护挡住，避免重复 dispatch 浪费。

---

## 测试证据

| 层级 | 测试 | 结果 |
|------|------|------|
| Layer 1 | `gpt-pro status` bridge/login/pro 健康 | ✅ `{"bridge":true,"loggedIn":true,"plan":"pro"}` |
| Layer 1 | `isPidAlive` 5 单元用例 | ✅ 5/5 PASS |
| Layer 2 | stale-lock 集成测试（真实 task 文件） | ✅ CLEAR_LOCK_AND_PROCEED |
| Layer 2 | 外层超时预算公式 3 场景 | ✅ 3/3 PASS，续命永不被截断 |
| Layer 3 | 真实 Pro 长任务端到端 | ⚠️ 补丁逻辑对，但被 Bash 600s ceiling 反杀 |

补丁文件 md5（worktree == cache）：
- `codex_bridge.ts`: `5c854f27ae3209058543bec9b61741a7`
- `gpt_pro.ts`: `25dfa3f7987fb6905a854184445021ca`

原文件备份：`~/.zcode/cli/plugins/cache/.../scripts/*.bak-20260621-160104`
