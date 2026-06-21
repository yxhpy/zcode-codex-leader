# 总体判断

未检索到 `zcode-codex-leader`、`codex_bridge.ts` 或 commit `4c4b7d7` 的公开仓库，因此下面除你明确给出的文件、命令和 hook 名之外，均是**建议目录与契约**，应按现有仓库结构等价映射。

核心建议是：

| 决策点        | 建议                                                              |
| ---------- | --------------------------------------------------------------- |
| DAG 与进度真相源 | **SQLite**；JSON 只作不可变输入、调试导出；内存只作缓存                             |
| 调度位置       | 放进 `codex_bridge.ts run` 背后的确定性调度器，不放在 leader prompt            |
| SLW Join 点 | 一个前台 `bridge run` 调用等待整个 DAG，不让 leader 发 N 个 Bash               |
| 并行单元       | resident worker pool 中的独立 slot；**每个 slot/thread single-flight** |
| 写隔离        | 每个写 packet 独立 Git worktree，加路径声明和最终串行合并                         |
| 恢复语义       | append-only 事件日志、packet lease、attempt、幂等键和 reconcile            |
| leader 职责  | 语义拆分审批、架构判断、冲突裁决、验收、提交和发布                                       |
| bridge 职责  | 状态机、拓扑调度、进程管理、超时重试、schema 校验、evidence                           |
| 长任务        | 前台持续等待并写 checkpoint；中断后下个 turn 显式 `resume` 再同步等待                |
| 低风险自治      | 只允许落到隔离 worktree/artifact staging；不得直接写主工作区或发布                  |

建议的模块布局：

```text
scripts/
  codex_bridge.ts                    # 唯一公开入口、CLI 路由

src/bridge/
  commands/
    plan.ts
    run.ts
    resume.ts
    status.ts
    cancel.ts
    doctor.ts
    evidence.ts
    reconcile.ts
    packet-run.ts                    # 内部命令，不向 leader 暴露
  core/
    run-store.ts                     # SQLite、事务、迁移
    packet-state-machine.ts
    dag-validator.ts
    scheduler.ts
    leases.ts
    idempotency.ts
    evidence-ledger.ts
    result-compactor.ts
  workers/
    app-server-pool.ts
    worker-slot.ts
    health-monitor.ts
    process-supervisor.ts
  workspace/
    worktree-manager.ts
    file-claims.ts
    patch-validator.ts
    merge-queue.ts
  prompts/
    packet-base-v1.ts
    plan-base-v1.ts

schemas/
  plan-v1.schema.json
  packet-v1.schema.json
  result-v1.schema.json
  run-envelope-v1.schema.json

hooks/
  UserPromptSubmit.ts
  SessionStart.ts
  PreToolUse.ts
  PostToolUse.ts
  Stop.ts
  SessionEnd.ts

tests/
  chaos/
  recovery/
  scheduler/
  protocol/
```

状态目录不应放在普通工作树内。Git 项目优先使用：

```text
$(git rev-parse --git-common-dir)/zcode-codex-leader/
  state.sqlite
  runs/<run_id>/
    request.json
    plan.json
    logs/
    artifacts/
    patches/
```

这样所有 worktree 共享同一个控制面，又不会污染仓库。

---

# 主题 1：任务拆分与进度持久化

## 1.1 业界/开源范式

### 范式 A：Codex App Server 的 thread/goal + Symphony workspace

Codex App Server 提供 `thread/resume`、`thread/fork`、`thread/read`，以及持久化的 `thread/goal/set|get|clear`；还会发出 `thread/status/changed`。这很适合保存**单个 worker 的上下文和目标**，但不等于完整 DAG 调度状态。([OpenAI开发者][1])

OpenAI Symphony 进一步采用长期 workspace、并发上限、重试和持久 workpad；但其规范明确说，重启时可以靠 tracker/filesystem 恢复，却不会恢复精确的内存调度器状态。你的插件应在此基础上再前进一步，把调度状态落到 SQLite。([GitHub][2])

### 范式 B：Claude Code 的 ID 化任务状态

用户提到的 `TodoWrite` 是旧范式。当前 Claude Code/Agent SDK 默认使用 `TaskCreate`、`TaskUpdate`、`TaskGet`、`TaskList`：新增和更新按 `taskId` 定位，而不是每次重写整个 todo 数组。这比自然语言 checklist 更适合作为 packet 状态模型。([Claude API Docs][3])

### 范式 C：LangGraph checkpoint + pending writes

LangGraph 用 `thread_id` 绑定持久化 graph state，并在每个 super-step 生成 checkpoint。尤其值得借鉴的是 pending writes：同一并行批次中，一个节点失败时，其他已成功节点的结果已持久化，恢复时无需重跑。([LangChain 文档][4])

Aider、Continue、Goose、SWE-agent、Cline、Roo 等更多是在持久化 Git 修改、trajectory、计划文档或会话；它们对恢复很有帮助，但通常不提供事务化 DAG 状态。Aider 的自动提交/撤销、SWE-agent 的 `.traj`、Cline/Roo 的 checkpoint 应作为 DAG store 的辅助层，而不是替代物。([GitHub][5])

## 1.2 插件适配方案

### 拆分流程

建议采用“模型提议、bridge 校验、leader 批准”三阶段：

1. `UserPromptSubmit` 只记录原始请求、session ID 和 request hash，不直接猜 DAG。
2. leader 对复杂任务调用新命令：

```bash
codex_bridge.ts plan --request-file <request.json> --tier strong
```

3. `plan` 派发一个只读 planner packet，返回符合 `plan-v1.schema.json` 的候选 DAG。
4. `dag-validator.ts` 做确定性检查：

   * 节点 ID 唯一；
   * 依赖存在；
   * 无环；
   * 写 packet 有 `write_globs` 和 acceptance；
   * 外部副作用有明确策略；
   * 节点数、深度和并发宽度不超过上限。
5. leader 可以修改或批准 DAG。
6. leader 只发一次：

```bash
codex_bridge.ts run --plan <plan.json>
```

简单请求不要强制拆分，直接生成单 packet DAG，避免“为了编排而编排”。

### 持久化选择

推荐三层：

| 数据                                  | 存储     | 定位            |
| ----------------------------------- | ------ | ------------- |
| 原始请求、获批 DAG                         | JSON   | 不可变输入、便于审阅和重放 |
| packet 状态、attempt、事件、lease、evidence | SQLite | 权威真相源         |
| ready queue、worker slot、临时索引        | 内存     | 可重建缓存         |

SQLite 应至少包含：

```text
runs
packets
packet_dependencies
packet_attempts
packet_events
worker_sessions
leases
file_claims
artifacts
side_effects
evidence
```

推荐：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = FULL;
```

但最重要的不是 WAL，而是**单写者原则**：外层 `bridge run` 是 SQLite 唯一 writer；并行 child runner 通过 JSONL 向父进程报告事件，不直接竞争 DB。

### packet 状态机

```text
planned
  -> ready
  -> dispatched
  -> in_flight
  -> produced
  -> validating
  -> accepted

validating -> rejected
in_flight -> failed_retryable -> ready
in_flight -> failed_terminal
in_flight -> orphaned
produced/accepted -> stale
any nonterminal -> cancelled
dependency terminal failure -> blocked
```

语义要明确区分：

* `failed_*`：运行层失败，例如进程崩溃、超时、协议错误。
* `rejected`：worker 正常返回，但未通过 schema、测试或 leader 验收。
* `stale`：结果曾经有效，但其输入、上游输出或 base revision 已变化。
* `orphaned`：原 bridge/worker lease 消失，尚不知道副作用是否完成。

每次状态变化应同时：

```sql
BEGIN IMMEDIATE;

INSERT INTO packet_events (...);

UPDATE packets
SET state = :new_state,
    state_version = state_version + 1,
    updated_at = CURRENT_TIMESTAMP
WHERE packet_id = :id
  AND state = :expected_state
  AND state_version = :expected_version;

COMMIT;
```

这相当于乐观 CAS，可防止迟到的旧 worker 输出覆盖新 attempt。

### 建议的 packet 契约

```ts
interface PacketV1 {
  schema_version: "1";
  run_id: string;
  packet_id: string;
  packet_revision: number;
  dag_version: number;

  title: string;
  objective: string;
  kind:
    | "ask" | "parse" | "web" | "vision"
    | "generate-image" | "test" | "mcp-tool"
    | "agy" | "gpt-pro";

  model_tier: "fast" | "balanced" | "strong";
  depends_on: string[];
  priority: number;

  inputs: {
    request_ref: string;
    context_refs: string[];
    artifact_refs: string[];
  };

  scope: {
    read_globs: string[];
    write_globs: string[];
    forbidden_globs: string[];
    base_revision: string;
    base_tree_hash: string;
    workspace_id?: string;
  };

  acceptance: {
    checks: Array<{
      type: "command" | "file" | "schema" | "review";
      value: string;
    }>;
    output_schema_ref: string;
  };

  execution: {
    timeout_ms: number;
    heartbeat_interval_ms: number;
    no_progress_timeout_ms: number;
    max_turns: number;
  };

  retry_policy: {
    max_attempts: number;
    initial_backoff_ms: number;
    max_backoff_ms: number;
    retry_on: string[];
  };

  side_effect: {
    class:
      | "none"
      | "repo_local"
      | "external_idempotent"
      | "external_irreversible";
    idempotency_key: string;
    reconcile_strategy?: string;
    compensation_packet_id?: string;
  };
}
```

## 1.3 文件级落点

| 落点                              | 改动                                                      |
| ------------------------------- | ------------------------------------------------------- |
| `hooks/UserPromptSubmit.ts`     | 记录 request/session/hash；注入 bridge-only 规则和当前 request ID |
| `hooks/SessionStart.ts`         | 查找未终结 run；把压缩恢复提示注入 leader context                      |
| `commands/plan.ts`              | 生成结构化候选 DAG                                             |
| `core/dag-validator.ts`         | 环检测、依赖、scope、副作用和预算校验                                   |
| `core/run-store.ts`             | SQLite schema、migration、事务、event append                 |
| `schemas/plan-v1.schema.json`   | planner 输出约束                                            |
| `schemas/packet-v1.schema.json` | packet 契约                                               |
| 新 subcommand                    | `plan`、`run`、`status`、`resume`、`cancel`                 |

## 1.4 风险与边界

* 模型拆出的 DAG 可能语义错误；bridge 只能验证结构正确，不能保证语义正确。
* 已 accepted packet 不应原地改写；replan 应增加 `dag_version` 和新 revision。
* 上游输出变化后，应由 bridge 自动把所有后继标为 `stale`。
* SQLite 应放本机文件系统；不要把 `flock` 或 SQLite WAL 当作可靠的 NFS 协调机制。OpenHands 文档也明确提醒其本地文件锁在 NFS 上并不可靠。([OpenHands 文档][6])
* Codex `thread/goal` 只能镜像 packet objective，不能作为插件 DAG 的权威状态。

---

# 主题 2：任务并行调度

## 2.1 业界/开源范式

### 范式 A：Argo DAG 的依赖驱动最大并行

Argo 用显式 `dependencies` 表达 DAG：A 完成后 B/C 并行，二者完成后 D 执行。这是标准的“拓扑关系决定就绪、资源限制决定实际并发”。([Argo Workflows][7])

### 范式 B：LangGraph 的动态 worker fan-out

LangGraph 的 `Send` API 可以动态创建 worker，每个 worker 有隔离 state，输出汇总到 orchestrator 的共享 key。这对应你的“leader 提议多个 packet、bridge 聚合结果”。([LangChain 文档][8])

### 范式 C：Codex/Cursor 的 worktree 隔离

Codex App 与 Cursor 都用 Git worktree 或独立代码副本运行并行 agent，避免直接修改同一工作区。Cursor 公开说明多 agent 使用 worktree/远程环境隔离；Codex App 也把 worktree 作为并行任务的内置机制。([OpenAI][9])

Goose 的公开多 agent 教程则明确要求并行 frontend/backend 不写相同文件。这说明“模型自觉避免冲突”可作提示，但不能替代物理隔离。([Block][10])

## 2.2 leader 如何判断依赖与并行

planner worker 输出两类关系：

### 数据/控制依赖

典型需要添加 `depends_on`：

* B 需要 A 生成的 API contract、schema 或代码；
* 测试 packet 依赖实现 packet；
* 集成 packet 依赖多个组件 packet；
* 发布/提交依赖所有验证 packet；
* 某 packet 的 acceptance 使用另一 packet 的 artifact。

### 资源依赖

即使无语义依赖，只要资源冲突，也不能同时执行：

```text
write_globs 相交                -> 互斥或增加串行边
external resource key 相同      -> 互斥
同一 worker thread              -> single-flight
同一不可幂等外部系统            -> 串行
同一主工作区                    -> 禁止并发写
```

不确定时默认串行。并发是优化，不是正确性的前提。

## 2.3 标准调度算法

基础采用 Kahn 拓扑算法：

```text
packet ready 当且仅当：
1. state == planned/blocked-ready；
2. 所有 depends_on 都是 accepted；
3. 没有 file/resource claim 冲突；
4. 对应 worker tier 有空闲 slot；
5. 没有触发 run budget、circuit breaker 或 cancel。
```

就绪队列排序建议：

```text
priority DESC
critical_path_length DESC
created_at ASC
packet_id ASC
```

最后一个排序键保证重放时调度结果尽量确定。

不要一次性计算完整拓扑层然后永久固定。每次 packet 完成后重新计算 ready，因为：

* 新 packet 可能由 replan 动态加入；
* packet 可能 stale；
* worker capacity 会变化；
* retry backoff 会改变可执行时间。

## 2.4 resident worker 并发模型

推荐明确契约：

> 一个 worker slot 同一时刻最多有一个 active packet；一个 packet 内可以有多 turn，但这些 turn 必须串行。

P0：

```text
resident worker pool size = 1
max_parallel = 1
```

P1：

```text
resident worker pool size = N
每个 slot：
  一个 app-server process 或经验证可并发的独立 connection
  一个 active thread
  一个 active packet
```

Codex App Server 能保存多个 thread，并提供 thread runtime status，但公开接口存在多个 thread 不等于你可以假设同一 app-server 实例上的任意多个 turn 都具备稳定并发隔离。因此：

1. 默认采用 N 个 resident process/slot；
2. 做 capability probe 和压力测试后，才允许一个 app-server multiplex 多个独立 thread；
3. 永远禁止同一 thread 同时有两个 turn；
4. app-server 重启后增加 `worker_epoch`，拒绝旧 epoch 的迟到结果。

### resident 与 one-shot 的取舍

| 模式       | 优点                                                           | 风险                |
| -------- | ------------------------------------------------------------ | ----------------- |
| resident | 保留 thread/context、少启动开销、可 `thread/resume`                    | 共享崩溃域、内存累积、挂死更复杂  |
| one-shot | 强隔离、超时后容易杀净、状态简单                                             | 启动成本、重复上下文、无法自然续接 |
| 推荐混合     | 正常走 resident pool；挂死、协议异常或高风险 provider 转 one-shot quarantine | 实现略复杂             |

`agy`、`gpt-pro` 可以继续使用 resident slot，但应有更长 timeout 和独立并发上限；不能让它们占满普通 packet 的所有 slot。

## 2.5 写冲突控制

推荐三层防线：

### 第一层：独立 worktree

每个 mutating packet：

```text
worktree/<run_id>/<packet_id>/<attempt>
```

worker 只能写该 worktree，不碰 leader 当前工作区。

### 第二层：声明式 file claim

调度前对 `write_globs` 做保守展开和 claim：

```text
src/auth/**       claimed by packet-A
src/payments/**   claimed by packet-B
```

有重叠则：

* 自动增加资源互斥；
* 或退回 planner 要求重新分区；
* 不要只靠 worker prompt。

### 第三层：乐观合并

packet 输出应记录：

```text
base_revision
files_changed[].before_sha
files_changed[].after_sha
patch_sha256
```

合并队列串行执行：

1. 当前目标分支仍是原 base：直接 apply。
2. base 已变化但三方合并无冲突：重新验证。
3. 有冲突：packet 标记 `stale`，创建 rebase/repair packet。
4. 不允许 worker 自行决定覆盖 leader 或其他 packet 的修改。

普通文件锁只能保护同一文件系统中的临界区，不能替代 worktree 和 base SHA 校验。

## 2.6 文件级落点

| 落点                              | 改动                                         |
| ------------------------------- | ------------------------------------------ |
| `core/scheduler.ts`             | Kahn ready queue、优先级、资源约束、rolling dispatch |
| `workers/app-server-pool.ts`    | N 个 resident slot、single-flight            |
| `workspace/worktree-manager.ts` | 创建、复用、清理 packet worktree                   |
| `workspace/file-claims.ts`      | write glob/resource claim                  |
| `workspace/merge-queue.ts`      | 串行 patch apply、base SHA 校验                 |
| `schemas/packet-v1.schema.json` | `depends_on`、`scope`、`resource_keys`       |
| 新 subcommand                    | `run --max-parallel N`、`reconcile`、`gc`    |

## 2.7 风险与边界

* worktree 防止物理互踩，但不能消除后续语义冲突。
* `write_globs` 是模型提供的声明，必须在完成后用实际 diff 再校验。
* 大量 worktree 会增加磁盘、索引和清理成本。
* 并发会放大 API rate limit、MCP 限额和测试资源竞争。
* 测试 packet 也可能修改快照、数据库或 golden files，不能默认其为只读。
* P0 不要一开始就追求动态最大并行；先把顺序 DAG 的恢复语义做正确。

---

# 主题 3：全部同步等待（SLW）的边界与实现

## 3.1 业界范式

Codex subagent 的典型行为是主 agent 启动多个子 agent，等待所有指定结果，再返回聚合响应。这个“spawn → join → consolidate”与 SLW 很接近。([OpenAI开发者][11])

Prefect 的 task runner/future、持久结果、retry 和 cache，以及 Inngest 的独立 step、完成结果 memoization，都体现了一个重要原则：并发执行和持久化发生在 orchestration 层，而调用者只等待一个总体结果。([Prefect][12])

## 3.2 Promise.all 应放在哪里

应放在：

```text
ZCode leader
  └── 一个 Bash
       └── codex_bridge.ts run
            ├── packet child A
            ├── packet child B
            └── packet child C
```

不应放在：

```text
leader 同时发 N 个 Bash
```

后者的问题是：

* 没有唯一 join 点；
* 没有统一取消；
* 多个 bridge 可能争写状态；
* final evidence 难以证明属于同一 run；
* 某个 Bash 失败时 leader 必须重新承担调度逻辑；
* 容易把 packet stdout 全塞进 leader context。

推荐公开命令：

```bash
codex_bridge.ts run \
  --plan plan.json \
  --max-parallel 4 \
  --output-format leader-envelope
```

该进程直到以下情况之一才退出：

```text
success：所有必须 packet accepted
failure：run 进入不可恢复失败
cancelled：明确取消
interrupted：收到宿主信号并完成 checkpoint
```

## 3.3 严格 SLW 边界

### 合法的 SLW

* bridge 前台仍存活；
* bridge 正在等待 child/worker；
* bridge 定期更新 SQLite checkpoint；
* bridge 向 stderr 输出有限心跳；
* bridge 捕获信号并清理；
* 最终只在 run 终态后退出。

### 不再是 SLW

* bridge 返回 `run_id` 后 worker 继续后台执行；
* leader 每隔一个 turn 调 `status`，而后台任务一直运行；
* detached child 在父进程退出后继续工作；
* 用轮询包装一个已经异步返回的 remote job，却称其仍为同步执行。

因此，**“checkpoint 文件 + 后台轮询”不是 SLW 的合法扩展**。可以有 `resume`，但语义是：

```text
上一个前台 SLW 被外部中断
-> 下一个 turn 显式 resume
-> 新 bridge 再次前台阻塞到终态
```

这叫中断恢复，不叫跨 turn 后台执行。

对于 `agy/gpt-pro`：

* packet timeout 必须低于 ZCode Bash 的硬超时；
* bridge 必须输出 heartbeat；
* 若宿主有不可提高的硬时间上限，则把任务拆成可恢复的有界阶段；
* 无法用纯前台阻塞跨过宿主硬上限，不能用后台技巧悄悄绕过契约。

## 3.4 `spawn + Promise.all` 骨架

下面是易理解的 wave 版本。生产版建议改成 rolling queue：一个 child 完成后立即补充新 ready packet，而不是等待整波最慢者。

```ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";

async function runDag(runId: string): Promise<RunEnvelope> {
  const store = await RunStore.open(runId);
  const pool = new Semaphore(await store.getMaxParallel());

  installSignalHandlers(async signal => {
    await store.appendRunEvent("interrupt_received", { signal });
    await store.stopAcceptingNewPackets();
    await ProcessSupervisor.terminateAll();
    await store.markUnresolvedAttemptsOrphaned();
  });

  while (true) {
    await store.reconcileExpiredLeases();

    if (await store.isRunTerminal()) {
      return store.buildLeaderEnvelope();
    }

    const freeSlots = pool.available();
    const packets = await store.claimReadyPackets(freeSlots);

    if (packets.length === 0) {
      if (await store.hasInFlightPackets()) {
        await store.waitForStateChange(500);
        continue;
      }

      throw new Error(
        `DAG deadlock: no ready or in-flight packets for run ${runId}`
      );
    }

    const settled = await Promise.allSettled(
      packets.map(packet =>
        pool.run(async () => {
          const attempt = await store.beginAttempt(packet.packet_id);

          try {
            const outcome = await spawnPacketRunner(runId, packet, attempt.id);
            await store.applyAttemptOutcome(attempt.id, outcome);
          } catch (error) {
            await store.recordAttemptException(attempt.id, error);
          }
        })
      )
    );

    // Promise.allSettled 防止一个 child rejection 取消其他 child。
    await store.recordDispatchWave(settled);
  }
}

async function spawnPacketRunner(
  runId: string,
  packet: PacketV1,
  attemptId: string
): Promise<PacketOutcome> {
  const child = spawn(
    process.execPath,
    [
      BRIDGE_ENTRY,
      "__packet-run",
      "--run", runId,
      "--packet", packet.packet_id,
      "--attempt", attemptId,
    ],
    {
      cwd: packet.scope.workspace_id,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      env: buildBoundedWorkerEnv(packet),
    }
  );

  ProcessSupervisor.register(attemptId, child);

  const protocol = new JsonlPacketProtocol({
    maxStdoutBytes: 8 * 1024 * 1024,
    resultSchema: RESULT_V1_SCHEMA,
    onEvent: event => RunStoreWriter.appendWorkerEvent(attemptId, event),
    onHeartbeat: data => RunStoreWriter.renewLease(attemptId, data),
  });

  child.stdout.on("data", chunk => protocol.consume(chunk));
  child.stderr.on("data", chunk => RawLogStore.append(attemptId, chunk));

  const timeout = setTimeout(() => {
    ProcessSupervisor.terminateTree(child, {
      gracefulSignal: "SIGTERM",
      forceAfterMs: 5_000,
    });
  }, packet.execution.timeout_ms);

  const [exitCode, exitSignal] = await once(child, "exit");
  clearTimeout(timeout);
  ProcessSupervisor.unregister(attemptId);

  return protocol.finish({
    exitCode: exitCode as number | null,
    exitSignal: exitSignal as NodeJS.Signals | null,
  });
}
```

具体约束：

* 必须使用 `spawn(command, args, {shell:false})`，不要拼 shell 字符串。
* 必须持续 drain stdout/stderr，否则 child 可能因 pipe 填满而假死。
* child 的 JSONL progress 由父 bridge 写 DB。
* child 不得直接写 SQLite。
* stdout 最终只输出一个 compact leader envelope；原始日志写文件。
* POSIX 上杀进程组，Windows 上使用 Job Object 或 tree-kill 等价实现。
* 内部命令 `__packet-run` 不应暴露给 leader 的 allowlist。

## 3.5 文件级落点

| 落点                              | 改动                                       |
| ------------------------------- | ---------------------------------------- |
| `commands/run.ts`               | 整个 DAG 的 SLW join 点                      |
| `commands/packet-run.ts`        | 单 packet 子进程入口                           |
| `workers/process-supervisor.ts` | timeout、signal、kill tree、stdout 上限       |
| `core/scheduler.ts`             | `Promise.allSettled`/rolling ready queue |
| `hooks/PreToolUse.ts`           | 只允许一个规范化 bridge 调用，不允许 leader 直接并发 Bash  |
| `hooks/PostToolUse.ts`          | 读取最终 envelope 并登记 evidence               |
| `commands/resume.ts`            | 中断后的新前台 SLW                              |

## 3.6 风险与边界

* 波次 `Promise.all` 会被最慢 sibling 阻塞；P1 改为 rolling scheduler。
* 心跳不能保证进展，需同时维护 `last_progress_at` 和 `last_heartbeat_at`。
* Bash 工具若把 stderr 也塞进 leader context，必须限制心跳频率和长度。
* child 被杀时 app-server 上的 turn 可能仍活着，恢复前必须查询 thread status。
* 宿主硬超时是 SLW 的硬边界；纯软件设计无法消除。

---

# 主题 4：容灾处理

## 4.1 业界/开源范式

### 范式 A：Temporal 的 event history、heartbeat 与幂等性

Temporal 把 append-only Event History 视为 workflow 的完整状态；Activity 在 worker 已完成但尚未确认时仍可能被重试，因此必须按“至少一次执行”设计，并使用幂等键。长任务 heartbeat 还可以携带 checkpoint，使下一次 attempt 从最近进度继续。([Temporal 文档][13])

### 范式 B：Kubernetes Job / Argo 的 timeout 与重试策略

Kubernetes Job 和 Argo 将 retry、backoff、deadline、parallelism、semaphore 作为调度器确定性配置，而不是让任务自行决定。你的 bridge 应采用同样分层。([Argo Workflows][14])

### 范式 C：Dapr 的 circuit breaker

Dapr resilience 把 retry、timeout、circuit breaker 区分开：retry 处理偶发错误，circuit breaker 防止持续失败服务被无限打击。resident app-server 应有相同的 restart budget 和 quarantine。([Dapr Docs][15])

## 4.2 故障检测与恢复矩阵

| 故障                            | 检测                                                         | 状态与恢复                                                   |
| ----------------------------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| worker 进程崩溃                   | process exit、JSON-RPC EOF、worker epoch 改变                  | attempt → `failed_retryable`；重启 slot；优先 `thread/resume` |
| app-server 活着但 thread 异常      | `thread/status/changed=systemError`、无 progress、RPC timeout | terminate turn/slot；restart budget 内重启；超预算 quarantine   |
| bridge child hang             | heartbeat 尚有但 progress 不变；或两者都超时                           | SIGTERM → grace → SIGKILL；按 side-effect class 决定重试      |
| 外层 bridge 被 Bash timeout/kill | signal handler、lease 过期、缺少 run terminal event              | 下次 `resume` 把 attempt 标为 `orphaned` 并 reconcile         |
| worker 返回垃圾                   | 非 JSONL、schema 不符、字段超长、artifact 缺失                         | `protocol_error`；一次 repair retry，之后 `rejected`          |
| worker 越界写文件                  | 实际 diff 不属于 `write_globs`                                  | 拒绝结果；保留 worktree 供取证，不合并                                |
| 主分支已变化                        | `base_revision` 或 `before_sha` 不匹配                         | `stale`；rebase/repair packet，不盲重试                       |
| 测试失败                          | 确定性 test runner 返回失败                                       | `rejected`；创建 remediation packet                        |
| 外部副作用状态未知                     | intent 已记录但无 confirmation                                  | `needs_reconcile`；查询 provider，不得直接重发                    |
| 连续多次 worker 失败                | restart/failure window 超阈值                                 | circuit open；该 slot/provider 暂停，转 fallback 或终止          |

## 4.3 扩展现有 death detection

无法查看 `4c4b7d7` 的 diff，因此建议把现有“发现 worker 死亡”扩展成四层：

### 1. Process liveness

```text
pid 存活
stdio/JSON-RPC 未关闭
worker_epoch 匹配
最近 heartbeat 未超时
```

### 2. Protocol readiness

```text
initialize/health RPC 成功
所需 model tier 可用
required MCP 初始化成功
线程不处于 systemError
slot capacity > 0
```

### 3. Task progress

```text
last_heartbeat_at
last_progress_at
last_output_seq
last_tool_event_at
```

“还活着”和“还在前进”必须分开。

### 4. Restart governance

```text
max_restarts_per_window
exponential backoff + jitter
worker quarantine
provider circuit breaker
fallback tier/provider
```

每次 app-server 重启都递增 `worker_epoch`。所有事件都携带：

```text
worker_slot_id
worker_epoch
thread_id
attempt_id
event_seq
```

epoch 不匹配的迟到消息直接丢弃。

## 4.4 恢复流程

`SessionStart` 或 `bridge resume`：

1. 扫描非终态 run。
2. 检查 bridge lease。
3. 对每个 `in_flight`：

   * worker/thread 仍存在且 event seq 连续：重新订阅；
   * worker 不存在：标记 `orphaned`；
   * result 文件完整：推进到 `produced`；
   * worktree 有修改但无结果：创建 recovery inspection packet；
   * 无副作用：重新入队；
   * 外部副作用未知：进入 `needs_reconcile`。
4. 重建 ready queue。
5. 恢复为新的前台 SLW。

Codex App Server 已支持对存储 thread 做 `thread/read` 和 `thread/resume`，所以 thread ID 应持久化在 `worker_sessions` 中。([OpenAI开发者][1])

## 4.5 幂等性与副作用

### 本地代码修改

最安全：

```text
packet worktree
-> patch artifact
-> validation
-> leader/merge queue apply
```

重试时使用新 attempt worktree；不在旧半成品上直接重新执行，除非显式 recovery packet。

### test/parse/web/vision

通常可安全重试，但结果仍应绑定：

```text
input_hash
base_revision
tool/model version
```

避免把旧结果错误复用到新代码。

### generate-image

使用：

```text
idempotency_key =
sha256(kind + normalized_prompt + model + size + relevant_options)
```

保存：

```text
provider_request_id
artifact_sha256
output_path
confirmation_state
```

如果 provider 不支持幂等请求，崩溃发生在“已生成但未记录”之间时，只能接受可能重复，或者先查询 provider job/receipt。

### MCP 外部副作用

新增 `side_effects` 表：

```text
prepared -> sent -> confirmed
                   -> compensated
         -> unknown
```

执行前先写 `prepared`，再调用外部系统。若 crash 后状态为 `sent/unknown`：

* provider 支持 idempotency key：安全重试；
* provider 支持查询：先 reconcile；
* 两者都不支持：默认 at-most-once，要求 leader/用户人工裁决。

对任意外部系统都无法普遍承诺 exactly-once。

## 4.6 文件级落点

| 落点                              | 改动                                            |
| ------------------------------- | --------------------------------------------- |
| `workers/health-monitor.ts`     | liveness、readiness、progress、epoch             |
| `workers/process-supervisor.ts` | kill、restart budget、quarantine                |
| `core/leases.ts`                | bridge/attempt lease                          |
| `core/idempotency.ts`           | retry 分类、幂等键、side-effect ledger               |
| `commands/doctor.ts`            | app-server/model/MCP/workspace 健康检查           |
| `commands/reconcile.ts`         | orphan、thread、worktree、外部 receipt 对账          |
| `hooks/SessionStart.ts`         | 检测可恢复 run                                     |
| `hooks/SessionEnd.ts`           | SLW 不应残留活动任务；异常时写 interrupted event           |
| 测试                              | kill worker、kill bridge、迟到输出、重复副作用、脏 worktree |

## 4.7 风险与边界

* 重试次数增加不等于可靠性提高；非幂等任务会被放大伤害。
* heartbeat 只能证明 worker 最近报告过，不能证明其输出正确。
* 自动重启可能形成 crash loop；必须有窗口化预算。
* worker 输出 schema 合法仍可能语义垃圾，必须经过 acceptance。
* compensation 本身也会失败，应作为独立 packet 记录，而不是隐藏在异常处理里。
* `thread/resume` 恢复的是模型上下文，不保证外部环境仍与中断时一致。

---

# 主题 5：leader 省 token

## 5.1 业界/开源范式

Codex 非交互模式已经提供 JSONL 事件流和 `--output-schema`，可将最终输出约束为 JSON Schema，适合下游自动处理。([OpenAI开发者][16])

Aider 通过 compact repository map 减少给模型的代码上下文，并提供 architect/editor 双模型模式及 Git 自动提交/撤销。([Aider][17])

Goose 的 lead/worker 模式由强模型做早期规划，便宜模型执行，并在 worker 连续失败时切回 lead；这与你现有 fast/balanced/strong routing 很接近。([Block][18])

## 5.2 哪些逻辑必须移出主模型

| 逻辑                          | 归属                   |
| --------------------------- | -------------------- |
| 任务是否需要语义拆分                  | leader/planner model |
| packet 目标和 acceptance 的语义   | leader/planner model |
| DAG 环检测、ready queue         | bridge               |
| packet ID、hash、revision     | bridge               |
| 状态迁移                        | bridge               |
| lease、timeout、retry/backoff | bridge               |
| model tier 的固定规则            | bridge               |
| prompt 固定前缀和 do-not 规则      | bridge               |
| stdout JSONL 解析             | bridge               |
| schema 校验                   | bridge               |
| artifact/hash/diff 校验       | bridge               |
| evidence 收集                 | bridge               |
| 原始日志归档与截断                   | bridge               |
| 测试是否通过                      | bridge/test runner   |
| 测试是否足以证明需求                  | leader/reviewer      |
| 冲突中应该保留哪种业务语义               | leader               |
| commit/release              | leader               |

原则是：

> 可重复、可验证、无语义歧义的逻辑都移出 leader token 流。

## 5.3 packet 模板化

把每次重复写的规则移到：

```text
src/bridge/prompts/packet-base-v1.ts
src/bridge/prompts/plan-base-v1.ts
```

bridge 组合：

```text
固定 contract
+ packet objective
+ scope
+ acceptance
+ context refs
+ attempt/recovery metadata
```

不要让 leader 每次重复写：

* 不要提交；
* 不要发布；
* 不要修改 scope 外文件；
* 必须运行哪些验证；
* 必须返回哪些字段；
* 必须列出证据；
* 遇到阻塞如何退出。

其中能物理执行的规则必须同时由 bridge/sandbox 实现，而不能只靠 prompt。

## 5.4 结构化 worker 输出

建议最终 `result-v1`：

```json
{
  "schema_version": "1",
  "run_id": "run_...",
  "packet_id": "pkt_...",
  "attempt_id": "att_...",
  "status": "succeeded",
  "summary": "不超过 800 字符",
  "files_changed": [
    {
      "path": "src/example.ts",
      "before_sha": "...",
      "after_sha": "..."
    }
  ],
  "tests": [
    {
      "command_id": "unit",
      "status": "passed",
      "exit_code": 0,
      "log_digest": "..."
    }
  ],
  "artifacts": [
    {
      "kind": "patch",
      "path": "...",
      "sha256": "..."
    }
  ],
  "risks": [],
  "blockers": [],
  "evidence": [
    {
      "type": "test",
      "ref": "evidence:..."
    }
  ],
  "suggested_packets": []
}
```

bridge 应：

* 把原始 JSONL 和完整 stdout 写日志；
* 给 leader 只返回 compact result；
* 限制每个字符串和数组长度；
* 只在失败时带少量关键 stderr；
* 不把 reasoning/chain-of-thought 送回 leader；
* 对重复字段做 deterministic 去重。

## 5.5 evidence 自动化

新增 `evidence-ledger.ts`，记录：

```text
run_id
packet_id
attempt_id
worker_slot/thread/epoch
model tier
input hash
result hash
patch/artifact hash
test command IDs
accept/reject decision
timestamp
```

最终 bridge 输出：

```text
Plugin evidence: run=run_123; accepted=6/6; ledger=sha256:abcd...
```

`Stop` hook 不应只检查是否包含字符串，而应：

1. 解析 `run_id` 和 ledger hash；
2. 确认 run 属于当前 session/request；
3. 查询 DB；
4. 确认所有 required packet 已 accepted；
5. 确认 hash 匹配；
6. 不匹配则 block final。

这可以阻止模型凭空编造 evidence 行。

## 5.6 预计能省多少

可用下面的实际 telemetry 公式：

```text
leader_saved_tokens =
  旧的重复 packet contract
+ 旧的每 packet 原始 stdout
+ 旧的重复 evidence 描述
- 新的一次性 DAG
- 新的 compact result envelope
```

一个示例量级：

```text
6 个 packet

旧：
  packet contract 250 × 6
  worker 散文/stdout 1000 × 6
  evidence 100 × 6
  合计约 8,100 leader-facing tokens

新：
  DAG/审批约 700
  compact result 180 × 6
  单一 evidence 80
  合计约 1,860
```

该示例约减少 77%。实际可把 **50%–80% 的 leader-facing dispatch token** 作为试验目标，但这不是模型总成本下降：

* worker token 可能不变；
* planner worker 会增加少量成本；
* 日志仍存在，只是不进入 leader context；
* 失败和冲突会降低节省比例。

应在 `packet_attempts` 中记录：

```text
leader_input_tokens
leader_output_tokens
worker_input_tokens
worker_output_tokens
raw_stdout_bytes
compact_envelope_bytes
```

用真实任务集比较，而不是只凭估算。

## 5.7 worker 自治区

可以引入，但边界应是：

### 允许

* 只读研究；
* 运行测试；
* 生成 artifact；
* 在独立 worktree 内写代码；
* 自动修复同一 packet 的测试失败；
* 符合确定性条件时由 bridge 自动标记 `produced` 或低风险 `accepted`。

### 不允许

* 写 leader 主工作区；
* 合并冲突；
* 修改 packet scope；
* 提交主分支；
* push、创建 release；
* 未声明的外部副作用；
* 决定是否发布。

较安全的自动接受条件：

```text
side_effect.class in {none, repo_local}
AND schema valid
AND actual diff subset of write_globs
AND all deterministic checks pass
AND no new dependency/config/security-sensitive file
AND confidence policy permits
```

即便自动 accepted，最终 merge/commit/release 决策仍归 leader。

## 5.8 文件级落点

| 落点                              | 改动                                |
| ------------------------------- | --------------------------------- |
| `prompts/packet-base-v1.ts`     | 固定 contract、do-not、输出格式           |
| `schemas/result-v1.schema.json` | 结构化 worker 输出                     |
| `core/result-compactor.ts`      | deterministic 压缩                  |
| `core/evidence-ledger.ts`       | evidence 自动收集和 hash               |
| `commands/evidence.ts`          | 输出可验证 evidence 行                  |
| `hooks/PostToolUse.ts`          | ingest run envelope               |
| `hooks/Stop.ts`                 | 对 DB/ledger 做真实校验                 |
| `hooks/PreToolUse.ts`           | 精确 argv allowlist，禁止 shell escape |
| `commands/status.ts`            | `--format compact`，供恢复时少量注入       |

## 5.9 风险与边界

* JSON Schema 只能保证形状，不能保证结论真实。
* 过度压缩可能隐藏关键风险；失败结果应保留高优先级字段。
* prompt 常量需要版本化，否则恢复旧 run 时行为会漂移。
* 自动接受若范围过宽，会侵蚀 leader 的最终控制权。
* PreToolUse 不能只匹配命令字符串；应解析规范化 argv，并禁止 `bash -c`、管道、重定向和 shell 元字符。
* 最理想的是把 bridge 暴露为专用 tool，但在当前 Bash+SLW 契约下，至少应提供固定 launcher，而不是放开任意 Bash。

---

# 主题 6：可借鉴的开源项目

## 6.1 Durable workflow / 调度项目

| 项目                                     | 核心问题                         | 可借鉴机制                                                    | 对插件的启发                                                                                       |
| -------------------------------------- | ---------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Temporal / Temporal TypeScript SDK** | 长任务在进程和机器故障后继续               | append-only history、Activity retry、heartbeat、幂等键         | SQLite event log、attempt、lease、side-effect reconcile；P2 可选真正 Temporal 后端 ([Temporal 文档][13]) |
| **Argo Workflows**                     | Kubernetes 上的 DAG 执行         | 显式 dependency、最大并行、retry、semaphore                       | packet DAG、ready queue、全局/按 kind 并发上限 ([Argo Workflows][7])                                  |
| **Inngest**                            | durable TypeScript functions | step 独立重试、完成结果 memoize、从失败点恢复                            | accepted packet 不重跑；packet 结果按 input hash memoize ([Inngest][19])                            |
| **Prefect**                            | Python workflow 状态与任务执行      | future、task state、cache、retry/backoff、result persistence | packet future、state taxonomy、缓存和 retry policy ([Prefect][12])                                |
| **Dagster**                            | 数据/资产依赖和 materialization     | asset lineage、上游依赖、分资产重试                                 | artifact lineage、上游变化导致 downstream stale ([Dagster 文档][20])                                  |
| **Bull / BullMQ**                      | Redis 工作队列                   | parent/child flow、atomic add、concurrency、dedupe          | packet flow 与 job key；本地插件 P0 不值得引入 Redis ([BullMQ][21])                                     |
| **Cronicle**                           | 多服务器定时任务与插件执行                | JSON 行插件协议、进度、timeout、retry                              | `__packet-run` 的 JSONL child protocol；不适合承担语义 DAG ([GitHub][22])                             |

## 6.2 Agent 编排框架

| 项目                              | 核心问题                               | 可借鉴机制                                                       | 对插件的启发                                                                                  |
| ------------------------------- | ---------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **CrewAI**                      | crew 与事件驱动 flow                    | structured flow state、`@persist`、默认 SQLite persistence      | 证明本地 SQLite 足够支撑轻量 agent flow；不要照搬开放式 crew 对话 ([CrewAI Documentation][23])              |
| **AutoGen**                     | 多 agent team 和消息协作                 | team `save_state/load_state`、termination condition          | 保存 worker team/thread state；只在 quiescent boundary snapshot，运行中快照可能不一致 ([微软 GitHub][24]) |
| **LangGraph**                   | 有状态 agent graph                    | checkpointer、pending writes、`Send` workers                  | 最接近 packet DAG 的软件范式；重点抄 checkpoint semantics ([LangChain 文档][4])                       |
| **SmolAgents**                  | 轻量 manager/managed-agent 层级        | manager 负责选择受限子 agent、运行 inspection                         | 保持 worker 简单有界，不把整个调度器再次塞进 worker ([Hugging Face][25])                                  |
| **CAMEL-AI**                    | Workforce 角色和任务协作                  | coordinator、planner、capability routing、失败后替换 worker         | capability-based slot routing、连续失败 worker replacement ([Camel AI][26])                  |
| **AutoGPT**                     | 可组合自治 agent workflow               | block graph、branch/loop、检查每个 block 输入输出                     | packet 模板和可视化 run；不采用其开放式无限自治 ([GitHub][27])                                            |
| **BabyAGI**                     | 任务/函数依赖和自扩展                        | function dependency、execution logging、trigger relationships | 轻量 registry 与函数依赖可参考；不让 worker自行生长未审批工具 ([GitHub][28])                                  |
| **SuperAGI**                    | 并发自治 agent 与工具                     | concurrent agents、工具扩展、agent runs                           | worker pool 和能力标签；其开放自治边界不适合 leader-owned 决策 ([GitHub][29])                             |
| **Agentic（TransformerOptimus）** | 未找到该组织下名为 Agentic 的独立公开项目          | TransformerOptimus 对应的项目是 SuperAGI                          | 建议视为同一参考项，不重复引入概念 ([GitHub][29])                                                        |
| **Devika**                      | planner/research/coder 模块化开发 agent | 模块角色拆分、项目/agent 状态落 DB                                      | 可借鉴角色拆分；项目早期和实验性较强，不宜作为可靠性基线 ([GitHub][30])                                             |

## 6.3 Coding-agent 项目

| 项目                                     | 核心问题                        | 可借鉴机制                                                        | 对插件的启发                                                                          |
| -------------------------------------- | --------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| **OpenAI Codex App Server / Symphony** | 常驻 coding agent 与多任务控制面     | thread resume/goal/status、worktree、并发上限、persistent workspace | 与当前架构最接近；直接映射 worker thread、slot、workspace 和 retry ([OpenAI开发者][1])             |
| **OpenHands**                          | 可恢复 agent conversation      | append-only EventLog、disk persistence、事件驱动 services          | `packet_events` 作为集成总线，派生服务不直接改核心状态 ([OpenHands 文档][31])                        |
| **SWE-agent**                          | 可重放的软件修复轨迹                  | `.traj` thought/action/observation、config/log/patch 分离       | 每 attempt 保留 protocol trajectory；evaluation 与执行分开 ([Swe Agent][32])             |
| **Aider**                              | repo-aware pair programming | compact repo map、architect/editor、每次修改 Git commit/undo       | 上下文压缩、规划/实现分模、packet patch/undo ([Aider][17])                                   |
| **Cursor Agent Mode**                  | IDE 中多 agent 并行开发           | plan mode、subagents、worktree/remote isolation                | 借鉴多任务 UX和隔离；它是闭源产品参照，不应列为开源依赖 ([Cursor][33])                                    |
| **Cline**                              | task 级代码修改和恢复               | 完整文件 checkpoint、跨 editor session 持久                          | worktree/文件状态 checkpoint；但不能代替 packet event log ([Cline][34])                   |
| **Roo Code**                           | mode-based agent 与子任务编排     | Boomerang delegation、shadow Git checkpoint、todo              | parent/child packet 回传和独立 checkpoint；leader 保持 parent 决策权 ([Roo Code Docs][35]) |
| **Continue**                           | plan 与执行能力分离                | Plan read-only、Agent write、CLI resume/readonly               | 将 planner packet 物理设为只读，而非只在 prompt 中要求 ([Continue][36])                        |
| **Goose**                              | 计划、模型路由和 subagent 协作        | Plan/checklist、lead/worker fallback、并行 subagents             | 对现有 tier routing 加失败升级；并行 packet 必须明确文件分区 ([Block][37])                         |

## 6.4 最值得“抄”的五个

### 1. OpenAI Symphony + Codex App Server

最接近你当前架构：

* app-server thread 映射 resident worker；
* persisted goal 映射 packet objective；
* worktree 映射写隔离；
* bounded concurrency 映射 worker slots；
* workspace continuation 映射 retry/resume。

需要补上的正是 Symphony 当前弱化的部分：**精确持久化 scheduler state**。

### 2. LangGraph

重点抄：

* checkpoint 与 thread/run 绑定；
* pending writes；
* 动态 worker fan-out；
* 恢复时不重跑已成功并行节点。

不要抄其完整 Python runtime；只抄状态语义。

### 3. Temporal

重点抄：

* append-only events；
* attempt 至少一次；
* heartbeat checkpoint；
* idempotency key；
* `unknown` 外部副作用的 reconcile；
* retry 与业务失败分离。

P0 在 SQLite 中实现 Temporal-lite 即可，不必直接引入 server。

### 4. Argo Workflows

重点抄：

* 显式 dependency；
* ready/maximal parallelism；
* global/per-kind parallelism；
* semaphore/resource mutex；
* retry policy 属于调度配置。

它给出最清晰、最少“agent 魔法”的并行模型。

### 5. Aider

重点抄：

* compact repo map；
* architect/editor 分工；
* 每个 AI 修改都有 Git 边界；
* diff/review/undo 是一级能力。

这直接服务于 leader 省 token、packet 隔离和失败恢复。

OpenHands 是紧随其后的第六项，尤其值得抄其 append-only EventLog 和“其他服务只消费事件、不直接改核心状态”的原则。

---

# P0 / P1 / P2 实施路线图

## P0：先做可恢复、可验证的顺序 DAG

| 工作项                       | 文件落点                                            | 完成标准                                      |
| ------------------------- | ----------------------------------------------- | ----------------------------------------- |
| Packet/Result/Plan schema | `schemas/*-v1.schema.json`                      | 所有 worker 最终结果必须通过 schema                 |
| SQLite event store        | `core/run-store.ts`                             | 所有状态变化有 event；可从 DB 重建当前状态                |
| 状态机与 DAG validator        | `packet-state-machine.ts`、`dag-validator.ts`    | 无环、CAS transition、stale propagation       |
| 新 bridge 命令               | `plan/run/status/resume/cancel/evidence/doctor` | leader 只需一个 `run` 等待完整任务                  |
| 顺序调度                      | `scheduler.ts`, `max_parallel=1`                | 多 packet 按依赖执行，session 中断后可 resume        |
| thread/session 持久化        | `worker_sessions`                               | 保存 thread ID、slot、epoch、last event seq    |
| worker 健康和重启              | `health-monitor.ts`                             | worker 被杀后能检测、重启、恢复或安全重试                  |
| 结构化 stdout                | `result-compactor.ts`                           | stdout 只有 compact envelope，原始日志落盘         |
| evidence ledger           | `evidence-ledger.ts`、`Stop.ts`                  | Stop 验证真实 ledger hash，不只匹配字符串             |
| Hook 加固                   | 全部 hooks                                        | raw Bash、shell escape、直接源码读写继续物理阻断        |
| 基础副作用分类                   | packet schema、`idempotency.ts`                  | 非幂等外部 packet 默认不自动 retry                  |
| Chaos tests               | `tests/chaos/`                                  | kill worker、kill bridge、坏 JSON、迟到输出均不破坏状态 |

P0 的关键验收场景：

```text
packet 已写完 worktree
-> worker 崩溃
-> bridge 被杀
-> 新 session resume
-> 不重复写主工作区
-> 找回或重建结果
-> evidence 与真实 accepted packet 一致
```

## P1：加入安全并行和 token 压缩

| 工作项                      | 文件落点                  | 完成标准                                      |
| ------------------------ | --------------------- | ----------------------------------------- |
| Resident worker pool     | `app-server-pool.ts`  | N slot，每 slot single-flight               |
| Rolling ready queue      | `scheduler.ts`        | 任一 packet 完成后立即补充新 ready packet           |
| Worktree per packet      | `worktree-manager.ts` | 并行写 packet 不接触同一工作区                       |
| File/resource claims     | `file-claims.ts`      | 重叠 scope 自动串行或拒绝 DAG                      |
| 串行 merge queue           | `merge-queue.ts`      | base SHA、三方 apply、冲突标 stale               |
| heartbeat/no-progress    | supervisor/store      | 能区分 alive 与 progressing                   |
| tier/fallback routing    | routing 模块            | fast/balanced/strong 按 packet；连续失败升级      |
| deterministic compaction | `result-compactor.ts` | leader-facing token 比基线下降至少 50%           |
| 低风险 auto-accept          | policy 模块             | 仅 none/repo_local 且确定性检查全过                |
| 长任务 staging              | `agy/gpt-pro` adapter | 各阶段 bounded，可 checkpoint/resume，仍保持前台 SLW |

## P2：高级调度、外部副作用和可观测性

| 工作项                                 | 文件落点                            | 完成标准                                        |
| ----------------------------------- | ------------------------------- | ------------------------------------------- |
| 动态 replan                           | `plan`/DAG versioning           | 新旧 DAG 可审计；accepted packet 不被原地修改           |
| Critical-path/cost-aware scheduling | `scheduler.ts`                  | 综合优先级、tier 成本、rate limit、关键路径               |
| Side-effect outbox/reconcile        | `idempotency.ts`、`side_effects` | prepared/sent/confirmed/unknown 可恢复         |
| Compensation packets                | packet contract                 | 补偿是可审计独立 packet                             |
| Speculative execution               | scheduler policy                | 只对只读/可丢弃 packet 开启                          |
| 扩大自治区域                              | acceptance policy               | 仍不可 merge/commit/release                    |
| Run dashboard/graph export          | `status --json/--dot`           | 可查看 packet、attempt、worker、artifact、evidence |
| Storage GC                          | `gc`                            | 保留失败/发布相关证据，安全清理 worktree/log               |
| 可选 Temporal backend                 | adapter                         | 仅当需要跨机器、跨宿主和真正长时间 durable execution         |

---

# 最终架构边界

最重要的三条不要动摇：

1. **SQLite 中的 run/packet event state 是权威状态；worker thread、worktree 和 JSON 都只是可对账的执行载体。**
2. **一个大任务只有一个前台 `bridge run` join 点；checkpoint 不等于异步，`resume` 不等于后台。**
3. **worker 可以扩大“执行自治”，但不得扩大“决策自治”：主工作区合并、冲突裁决、commit、push、release 永远归 leader。**

Plugin evidence: 研究基于 Codex App Server/Symphony、LangGraph、Temporal、Argo、Claude Code、Aider、OpenHands、Goose 等一手文档；未读取 `zcode-codex-leader` 私有仓库或 commit `4c4b7d7` 的源码。

[1]: https://developers.openai.com/codex/app-server "https://developers.openai.com/codex/app-server"
[2]: https://github.com/openai/symphony/blob/main/SPEC.md "https://github.com/openai/symphony/blob/main/SPEC.md"
[3]: https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-typescript "https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-typescript"
[4]: https://docs.langchain.com/oss/javascript/langgraph/checkpointers "https://docs.langchain.com/oss/javascript/langgraph/checkpointers"
[5]: https://github.com/aider-ai/aider "https://github.com/aider-ai/aider"
[6]: https://docs.openhands.dev/sdk/api-reference/openhands.sdk.conversation "https://docs.openhands.dev/sdk/api-reference/openhands.sdk.conversation"
[7]: https://argo-workflows.readthedocs.io/en/latest/walk-through/dag/ "https://argo-workflows.readthedocs.io/en/latest/walk-through/dag/"
[8]: https://docs.langchain.com/oss/python/langgraph/workflows-agents "https://docs.langchain.com/oss/python/langgraph/workflows-agents"
[9]: https://openai.com/index/introducing-the-codex-app/ "https://openai.com/index/introducing-the-codex-app/"
[10]: https://block.github.io/goose/docs/tutorials/subagents "https://block.github.io/goose/docs/tutorials/subagents"
[11]: https://developers.openai.com/codex/subagents "https://developers.openai.com/codex/subagents"
[12]: https://docs.prefect.io/v3/how-to-guides/workflows/write-and-run "https://docs.prefect.io/v3/how-to-guides/workflows/write-and-run"
[13]: https://docs.temporal.io/activity-definition "https://docs.temporal.io/activity-definition"
[14]: https://argo-workflows.readthedocs.io/en/latest/fields/ "https://argo-workflows.readthedocs.io/en/latest/fields/"
[15]: https://docs.dapr.io/operations/resiliency/policies/ "https://docs.dapr.io/operations/resiliency/policies/"
[16]: https://developers.openai.com/codex/noninteractive "https://developers.openai.com/codex/noninteractive"
[17]: https://aider.chat/docs/faq.html "https://aider.chat/docs/faq.html"
[18]: https://block.github.io/goose/docs/tutorials/lead-worker "https://block.github.io/goose/docs/tutorials/lead-worker"
[19]: https://www.inngest.com/docs/learn/how-functions-are-executed "https://www.inngest.com/docs/learn/how-functions-are-executed"
[20]: https://docs.dagster.io/guides/build/assets/modeling-etl-pipelines "https://docs.dagster.io/guides/build/assets/modeling-etl-pipelines"
[21]: https://docs.bullmq.io/guide/flows "https://docs.bullmq.io/guide/flows"
[22]: https://github.com/jhuckaby/Cronicle "https://github.com/jhuckaby/Cronicle"
[23]: https://docs.crewai.com/en/concepts/flows "https://docs.crewai.com/en/concepts/flows"
[24]: https://microsoft.github.io/autogen/stable//user-guide/agentchat-user-guide/tutorial/state.html "https://microsoft.github.io/autogen/stable//user-guide/agentchat-user-guide/tutorial/state.html"
[25]: https://huggingface.co/docs/smolagents/examples/multiagents "https://huggingface.co/docs/smolagents/examples/multiagents"
[26]: https://docs.camel-ai.org/reference/camel.societies.workforce.workforce "https://docs.camel-ai.org/reference/camel.societies.workforce.workforce"
[27]: https://github.com/significant-gravitas/autogpt "https://github.com/significant-gravitas/autogpt"
[28]: https://github.com/yoheinakajima/babyagi "https://github.com/yoheinakajima/babyagi"
[29]: https://github.com/TransformerOptimus/SuperAGI "https://github.com/TransformerOptimus/SuperAGI"
[30]: https://github.com/stitionai/devika/blob/main/docs/architecture/README.md "https://github.com/stitionai/devika/blob/main/docs/architecture/README.md"
[31]: https://docs.openhands.dev/sdk/arch/conversation "https://docs.openhands.dev/sdk/arch/conversation"
[32]: https://swe-agent.com/latest/usage/trajectories/ "https://swe-agent.com/latest/usage/trajectories/"
[33]: https://cursor.com/docs/agent/plan-mode "https://cursor.com/docs/agent/plan-mode"
[34]: https://docs.cline.bot/core-workflows/checkpoints "https://docs.cline.bot/core-workflows/checkpoints"
[35]: https://docs.roocode.com/features/checkpoints "https://docs.roocode.com/features/checkpoints"
[36]: https://docs.continue.dev/guides/plan-mode-guide "https://docs.continue.dev/guides/plan-mode-guide"
[37]: https://block.github.io/goose/docs/tutorials/plan-feature-devcontainer-setup "https://block.github.io/goose/docs/tutorials/plan-feature-devcontainer-setup"
