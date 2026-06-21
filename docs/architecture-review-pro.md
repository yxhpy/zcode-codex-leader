zcode-codex-leader 深度架构审查报告
执行结论

结论：有条件通过。架构方向正确，但 0.8.0 当前的长任务可靠性语义不建议直接用于生产。

这套设计最有价值的部分，是把 ZCode 定位成控制平面，把实际执行交给专用 worker，并通过统一入口、DAG 和 evidence 建立可审计边界。但当前同时把以下四件本应独立的事情绑在了一起：

ZCode turn 是否仍然存活；

bridge 调用是否仍在等待；

worker 是否健康；

任务是否仍拥有执行权。

这会导致最危险的故障模式：外层超时了，内层任务仍在运行；leader 认为失败并重试；旧 worker 仍持有或恢复 stale lock；两个 attempt 同时产生副作用。

因此：

短任务、单机、低并发场景：架构可用。

agy/gpt-pro 这类分钟到几十分钟的任务：当前 SLW、90 秒 quiet-killer、锁语义组合存在 P0 风险。

在解决“持久任务句柄、租约与 fencing、break-glass、结果原子提交”之前，不应把“同一 turn 回收”作为可靠性保证。

本报告基于你提供的机制说明和相关平台协议进行机制级审查，不是逐行代码审计。另有一个必须首先确认的前提：ZCode 官方文档目前写明 Hook 只支持 Claude CLI，ZCode Agent、Codex CLI 等不会读取该 Hook 配置；因此如果 leader 实际运行在 ZCode Agent 而非 ZCode 托管的 Claude CLI 上，所谓 PreToolUse 物理 gate 可能根本没有生效。
ZCode

1. 架构优点
1.1 控制平面与执行平面分离是正确方向

ZCode 只负责：

任务分解；

worker 选择；

约束决策；

结果验证；

失败恢复。

worker 负责代码、视觉、研究等高上下文、高副作用工作。

场景：大规模重构。
如果 leader 亲自读取几百个文件、生成补丁、运行测试，它的上下文会迅速被实现细节淹没，后续很难保持全局约束。由 Codex worker 承担实现，leader 只消费结构化结果，可以保留架构目标、验收标准和风险模型。

这也与 Codex App Server 的官方集成方式吻合：本地客户端通常启动一个长期运行的 App Server 子进程，通过双向 stdio/JSON-RPC 维持会话，并固定到经过测试的二进制版本。
OpenAI

1.2 单一 bridge 有利于审计、限权和策略一致性

统一通过 codex_bridge.ts 能集中实现：

run/task/attempt ID；

prompt 和附件审计；

model、预算、超时策略；

文件访问范围；

side-effect 记录；

evidence 格式；

敏感操作审批。

场景：依赖升级。
worker 请求修改 lockfile、访问网络并执行安装命令时，bridge 可以统一记录来源、目标版本、网络访问和最终 diff，而不是让不同工具分别产生无法关联的日志。

这是“单一策略执行点”的优势。问题不在于集中，而在于集中后必须具备高可用、break-glass 和防绕过能力。

1.3 禁止 worker 直接互调，能抑制循环与权限扩散

codex -> agy -> gpt-pro -> codex 这类递归委派容易造成：

成本不可预测；

上下文反复压缩；

责任归属模糊；

工具权限叠加；

无法确定谁应提交最终结果。

由 ZCode 作为唯一 router，至少能保证所有跨能力调用形成显式 DAG 边。

场景：Codex 缺少长上下文信息。
严格模式下它不能擅自召唤另一个高成本 worker，因此不会因为一句“再深入研究一下”形成无界 fan-out。

这个边界应保留，但应从“完全不能请求其他能力”升级为后文提出的“经 leader 仲裁的能力请求”。

1.4 常驻 App Server worker 能降低冷启动和会话恢复成本

常驻进程可以复用：

登录与授权状态；

App Server 初始化；
-协议握手；
-模型和能力发现；
-线程历史；
-缓存与运行时加载。

场景：连续修改—测试—修复。
每一步都重新拉起 worker 会增加启动延迟，也容易产生不同版本、不同配置和不同环境。持久进程配合独立 thread/worktree，比每次全冷启动合理。

Codex App Server 原生提供 thread/start、thread/resume、thread/read、运行时状态通知以及 turn/interrupt，说明“持久 worker + 可恢复任务”本身是其设计目标。
OpenAI开发者

1.5 DAG + 状态存储是比纯对话历史更可靠的执行模型

对话历史不能可靠表达：

哪个节点正在执行；

哪些依赖已经满足；

哪个 attempt 已失效；

哪些结果已经验证；

哪些节点需要重试。

显式 DAG 和 SQLite 状态能提供恢复基础。

场景：数据库迁移任务。

分析 schema
    ↓
生成迁移
    ↓
在临时数据库验证
    ↓
兼容性检查
    ↓
提交结果

进程在“生成迁移”后崩溃时，可以恢复到明确节点，而不是要求模型重新阅读整段对话猜测进度。

1.6 evidence 验证把“worker 声称完成”与“系统接受完成”分开

正确的完成条件不应只是 worker 返回一句“测试通过”，而应包括：

命令；

exit code；

测试输出摘要；

diff 或产物 hash；

验证时间；

验证者身份；

输入快照版本。

场景：worker 修改了代码，但测试命令实际没有执行。
evidence gate 可以阻止任务进入 SUCCEEDED。

这是非常重要的设计，只是当前还需要进一步保证 evidence 不是由同一 worker自我证明。

1.7 ephemeral test worker 是合理的变更隔离机制

场景：升级 Codex App Server、bridge 协议或 sandbox 配置。
如果直接在常驻 worker 上测试，失败可能污染正在运行的线程、授权状态或工作目录。ephemeral test worker 能做：

协议兼容性测试；

health check；

smoke task；

sandbox 验证；

schema contract test。

通过后再切换常驻 worker，明显优于“原地升级”。

2. 架构风险与缺陷
P0：必须先修复
P0-1：单通道 gate 可能并不是真正的物理边界
问题描述

这里有两层风险。

第一层是运行载体风险：ZCode 官方文档称 Hook 当前只对 Claude CLI 生效。如果 leader 是 ZCode Agent，则 Hook 配置不会被读取。
ZCode

第二层是绕过风险。假设为了运行 codex_bridge.ts，leader 仍拥有通用 Bash：

Bash
node codex_bridge.ts ...

那么它通常也能运行：

Bash
cat src/app.ts
python -c 'open("src/app.ts","w").write(...)'
sed -i ...
curl ...
git show ...

此时禁止 Read/Edit/Write/WebSearch 只限制了几个工具名，并没有限制底层能力。

Claude Code 官方文档也明确说明，Hook 的匹配过滤是 best-effort，硬性 allow/deny 应使用 permission system；另外用户直接输入 /skillname 会绕过针对 Skill 工具的 PreToolUse，需要额外覆盖 UserPromptExpansion。
Claude Code
+1

触发场景

leader 使用 Bash 读取或修改代码；

通过 Python、Node、Perl 间接读写文件；

通过 curl、wget、Git 等间接联网；

通过 MCP filesystem/github 工具旁路；

直接调用 slash command；

路径符号链接、相对路径或子命令解析绕过；

leader 实际运行在不读取 Hook 的 ZCode Agent。

影响

单通道审计失效；

权限隔离成为软约定；

敏感数据可绕过 bridge 外传；

leader 或提示注入可以直接产生副作用；

evidence 和成本统计不再完整。

修复建议

启动时能力自证，而不是相信配置存在。
插件启动后执行一组无害的负向测试：尝试 Read、Write、Bash-cat、Python-write、curl、MCP、slash skill，任何一个未被拒绝就拒绝启动。

底层 deny-by-default。
不要给 leader 通用 shell。只允许执行固定 wrapper，例如：

zcode-control bridge-dispatch <validated-json>
zcode-control worker-status
zcode-control reconcile

wrapper 应使用严格 argv 解析，不能接受任意 shell 字符串。

使用 permission/sandbox 作为硬边界。
Hook 只做审计和附加策略，不承担最终安全保证。

覆盖所有能力面。
包括 Bash、Grep、Glob、MCP、Skill、slash command、网络和符号链接。

把 gate 状态写入每个 run。
例如 enforcement_mode=verified、测试时间、策略版本和测试结果 hash。

P0-2：bridge/worker 故障会把 leader 一并锁死
问题描述

当前模型把所有实质性能力集中到 bridge，同时又禁止 leader 直接读代码、读日志或修复状态。

这会形成一个自指故障：

修复 bridge 必须通过 bridge，但 bridge 已经坏了。

触发场景

App Server 进程崩溃；

bridge 版本不兼容；

JSON-RPC 通道卡死；

worker 授权失效；

SQLite migration 失败；

stale lock 阻止新任务；

bridge 自己被错误补丁破坏；

worker 工作目录损坏。

影响

整个系统不可用；

leader 无法判断是任务慢、worker 死亡还是数据库锁；

用户只能离开当前工作流进行人工修复；

故障恢复依赖未审计的外部操作。

修复建议

增加受限 break-glass 控制平面。它不能编辑产品代码，但可以：

doctor
worker-status
worker-restart
tail-control-logs
db-quick-check
run-reconcile
lease-inspect
lease-revoke --generation N
bridge-rollback --version V
export-run-diagnostics

要求：

明确用户批准或预定义自动恢复策略；

每次调用不可删除审计记录；

能力有 TTL；

不能获得任意 shell；

不能修改业务工作区；

连续失败后触发 circuit breaker，而不是无限重启。

这样 leader 在 worker 挂掉时仍然“能恢复系统”，但不能越权替代 worker 做实质性工作。

P0-3：外层超时、内部续命和 stale lock 会产生“双重所有者”
问题描述

必须区分五种不同语义：

计时器	表示什么	到期后的正确动作
请求等待超时	leader 不再等待当前调用	标记客户端 detached，不得判任务失败
heartbeat 超时	worker 状态可疑	进入 SUSPECT，主动探测
lease 到期	当前 owner 失去提交权	进入 ORPHANED，先 reconcile
业务 deadline	任务超过允许时长	请求取消
kill grace	已请求取消但进程不退出	分阶段终止进程

如果目前用一个 timeoutSec 或 90 秒 quiet 同时代表这些语义，系统无法正确判断所有权。

具体触发场景

gpt-pro 预计运行 25 分钟；

外层 bridge 在 5 分钟返回 timeout；

内层浏览器或模型仍在生成，keepalive 仍更新某个锁；

leader 将节点标为失败并重试；

新 attempt 获得新 worker；

旧 attempt 最后返回并写入结果；

新旧结果互相覆盖，或锁永远无法释放。

异步请求架构的标准做法，是先返回持久操作句柄，再通过状态资源收集结果；重复提交应使用 idempotency key 返回已有任务，而不是创建第二份工作。
Microsoft Learn

影响

stale-lock 死锁；

同一任务重复扣费；

重复 commit、部署、网络写入；

旧结果覆盖新结果；

SQLite 记录与真实 worker 状态分离；

无法安全决定是否重试。

修复建议

采用租约 + fencing token + idempotency。

每个 attempt 至少持久化：

run_id
node_id
attempt
idempotency_key
worker_id
worker_session_id
thread_id / turn_id
lease_generation
lease_expires_at
heartbeat_at
progress_seq
workspace_ref
result_hash

关键规则：

每次重新分配时 lease_generation += 1。

heartbeat 和完成提交必须带 owner 与 generation。

通过 CAS 更新：

SQL
UPDATE task_attempts
SET heartbeat_at = ?, lease_expires_at = ?
WHERE node_id = ?
  AND owner_id = ?
  AND lease_generation = ?
  AND state = 'RUNNING';

更新行数为 0，说明 worker 已失去所有权，其输出只能进入 quarantine，不能提交。

外层 timeout 只表示 leader detached，任务仍保持 RUNNING。

只有收到明确的完成事件，才能进入 VERIFYING。

取消必须经历：

RUNNING
  -> CANCEL_REQUESTED
  -> CANCELLED

不能把发送 SIGKILL 等价为业务取消成功。

Codex App Server 已经提供流式 item/turn 事件，turn/completed 携带最终状态，turn/interrupt 用于显式取消；应优先使用这些权威事件，而不是从 shell 返回或输出安静时间推断结果。
OpenAI开发者

P0-4：SQLite 状态与代码/产物之间存在双写崩溃窗口
问题描述

SQLite 事务无法原子覆盖：

worker 修改工作区；

生成结果文件；

更新数据库；

写 evidence；

通知 scheduler。

触发场景 A

worker 已写完代码；

进程在写 COMPLETED 前崩溃；

scheduler 重试；

第二次 attempt 在已修改工作区继续执行。

触发场景 B

数据库先标记 SUCCEEDED；

产物 rename、fsync 或上传失败；

状态显示成功，但结果不存在或不完整。

影响

重复执行；

部分写入；

数据库和实际工作区不一致；

evidence 指向不存在的 artifact；

崩溃后无法判断应继续、回滚还是重试。

修复建议

每个 attempt 使用独立 worktree/snapshot。

worker 只能写入：

workspaces/<run>/<node>/<attempt>/

产出不可变 manifest：

JSON
{
  "attempt": 3,
  "baseCommit": "...",
  "resultHash": "...",
  "artifacts": [],
  "evidence": []
}

由 leader/verifier 验证后，进行一次受 fencing 保护的“promote”。

promote 使用原子 rename、Git commit/cherry-pick 或内容寻址对象。

在 SQLite 同一事务中写入状态变化和 outbox 事件；独立 dispatcher 再发送通知。Transactional Outbox 正是为数据库更新和外部通知的双写不一致而设计，消费者仍应具备幂等性。
AWS 文档

启动和定期运行 reconciler：

找到有 manifest 但数据库仍为 RUNNING 的任务；

找到数据库完成但 artifact 缺失的任务；

找到已失效 generation 产生的孤儿结果。

P1：高优先级可靠性与扩展性问题
P1-1：SLW 不适合作为长任务的强制语义
问题描述

“同一 ZCode turn 内 dispatch 并回收”对短任务可以降低复杂度，但对于几十分钟任务，会把客户端会话生命周期变成任务生命周期。

Codex Web 的官方架构明确指出，浏览器 tab 和网络都是短暂的，客户端不能成为长任务的事实来源；状态和进度应留在服务端，使任务在断线后继续，并允许新会话重新连接和追赶事件。
OpenAI

触发场景

agy 进行 30 分钟研究；

gpt-pro 长时间推理；

用户关闭窗口；

ZCode turn 达到上游超时；

bridge 进程重启；

网络临时中断。

影响

leader 长时间不可做其他决策；

独立任务不能并行；

客户端断开被误认为任务失败；

重试语义模糊；

用户体验类似“整个 agent 卡死”。

修复建议

把 SLW 改成混合模型：

Fast Path:
dispatch -> 等待短时间 -> 完成则同 turn 回收

Durable Path:
dispatch -> 持久化 job handle -> 当前 turn 返回状态
         -> 后续 status/collect/reconnect

新的强制不变量应是：

每个 dispatch 必须在同一 turn 内被持久登记并获得确定的 run handle。

而不是：

每个 dispatch 必须在同一 turn 内完成。

仍然可以禁止不受控的 run_in_background；但不能禁止由 scheduler 管理、带状态机、租约、取消和 evidence 的显式异步任务。

P1-2：postToolQuiet = 90s 不是可靠的 hang 判据
问题描述

“90 秒没有 tool call”最多说明没有工具事件，不能证明：

模型进程死锁；

JSON-RPC 通道死亡；

远端请求停止；

worker 无法继续；

任务没有在推理。

长推理、模型排队、上传、下载、等待浏览器生成等都可能合法静默超过 90 秒。

Kubernetes 对 liveness probe 的经验也说明，探针必须真正代表不可恢复故障；错误的 liveness 判定会在高负载时反复重启健康实例，形成级联故障。
Kubernetes

触发场景

gpt-pro 连续推理 2–5 分钟但未调用工具；

agy 正在压缩长上下文；

App Server 等待上游模型；

worker 正在执行无输出的构建或测试；

模型响应流暂时无 token。

影响

健康任务被杀；

工作区停留在部分修改状态；

重试产生重复副作用；

常驻 worker 被频繁冷启动；

系统负载越高，误杀越多。

修复建议

拆分至少四种信号：

进程健康：PID、event loop、health endpoint。

传输健康：JSON-RPC ping/readyz、连接读写。

任务状态：App Server thread/turn runtime status。

语义进度：progress sequence、item events、阶段更新。

建议的 staged recovery：

quiet 超阈值
  -> 标记 SUSPECT
  -> ping transport / 查询 turn 状态
  -> 若健康，延长观察，不杀
  -> 若无响应，发送 turn/interrupt
  -> 等待 grace period
  -> SIGTERM
  -> 最后才 SIGKILL

阈值应按 worker 类型配置：

Codex coding；

agy 长上下文；

gpt-pro 远端生成；

视频/图片生成。

任何 worker 都不应仅因“没有 tool call”而被杀死。

P1-3：SQLite 本身可用，但当前并发与恢复模型可能不足

SQLite 适合单机、低到中等并发的控制面状态；问题通常不是数据库选型，而是事务边界。

WAL 模式允许 reader 与 writer 并行，但仍只有一个 writer；长时间 read transaction 会阻碍 checkpoint，WAL 依赖同机共享内存，因此不能安全放在普通网络文件系统上。
SQLite

触发场景

多 worker 高频写 heartbeat；

scheduler 长事务扫描 DAG 后再等待 worker；

dashboard 持有长 read transaction；

SQLite 位于 NFS/同步盘；

checkpoint 长期无法推进；

crash 时数据库与 -wal 文件被分开复制。

影响

SQLITE_BUSY；

scheduler 延迟；

WAL 持续增长；

偶发慢提交；

不完整备份；

多机环境下潜在损坏。

修复建议

单机阶段建议：

SQL
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

并且：

worker 运行期间绝不持有数据库事务；

claim task 必须是短事务；

heartbeat 合并写入，避免每秒更新；

给 ready-state、lease expiry、run/node ID 建索引；

定期 checkpoint；

启动时执行 quick/integrity check；

数据库、-wal、-shm 保持同一生命周期；

只使用本地可靠文件系统；

备份前 checkpoint 或使用 SQLite backup API；

崩溃后运行状态 reconciler，而不是只依赖 SQLite 自动回滚。

P1-4：顺序调度器造成严重队头阻塞
触发场景

DAG 中有：

一个 40 分钟 gpt-pro 研究节点；

一个独立的 20 秒 Codex lint 节点；

一个独立的 2 分钟视觉检查节点。

如果 scheduler 全局顺序执行，后两者即使没有依赖，也必须等待 40 分钟。

影响

平均等待时间远高于执行时间；

一个慢 worker 拖住整个 run；

不能利用不同能力的并行性；

视频等新能力加入后吞吐量快速下降。

顺序执行的理论吞吐上限约为：

吞吐量 <= 1 / 平均任务耗时

平均节点耗时 30 分钟时，单 scheduler 执行槽最多约 2 个节点/小时。

修复建议

改成 DAG-ready scheduler：

只调度依赖全部成功的节点；

worker pool 按能力分类；

独立 workspace 可并行；

同一 workspace 的写任务互斥；

同一 workspace 的只读验证可使用 snapshot 并行；

设置全局、每 run、每能力并发上限；

增加优先级和 aging，避免大任务饿死小任务或反之。

P1-5：能力隔离过硬，损失了合理的能力组合

完全禁止 codex 使用 agy 的结果，会产生人为能力断层。

触发场景

Codex 在重构过程中发现：

需要阅读大量历史设计文档；

需要对比多个外部规范；

当前上下文不足以判断兼容性。

它不能继续，也不能合法请求 agy，只能把任务标成 blocked，交给 leader 重新规划。

影响

多一次完整上下文往返；

leader 成为语义转发瓶颈；

上下文压缩损失；

worker 无法在发现问题时动态扩展 DAG。

修复建议：仲裁式能力请求

保留“worker 不得直接互调”，但允许：

JSON
{
  "type": "CAPABILITY_REQUEST",
  "requestedCapability": "long-context-research",
  "reason": "需要核对三版协议兼容性",
  "contextRef": "artifact://...",
  "budget": {},
  "deadline": {}
}

流程：

codex -> leader：能力请求
leader -> policy/budget/cycle check
leader -> agy：新 DAG 节点
agy -> leader：结构化结果
leader -> codex：附加 result_ref

限制：

最大委派深度；

最大 fan-out；

预算；

cycle detection；

只传 artifact 引用，不传无限对话历史；

所有跨 worker 数据带来源和 hash。

这样既保持 ZCode 唯一 router，又不牺牲组合能力。

P1-6：evidence 可能是 worker 的自我证明
触发场景

同一个 Codex worker：

修改代码；

生成测试摘要；

声称测试通过；

提交 evidence。

即使格式正确，也不能排除：

测试未实际执行；

输出属于旧版本；

有选择地省略失败；

evidence 与最终 diff 不匹配。

影响

错误结果进入 SUCCEEDED，而 DAG/evidence 只提供了形式上的可信度。

修复建议

evidence 必须绑定 input snapshot 和 result hash；

测试 exit code、stdout/stderr hash 由执行适配器生成；

使用 ephemeral verifier 在只读 snapshot 上独立验证；

高风险节点采用不同 worker/model 验证；

verifier 不能修改候选工作区；

evidence schema 应区分：

worker assertion；

machine-observed evidence；

independent verification；

human approval。

P1-7：常驻 worker 可能产生跨任务状态污染
触发场景

上一任务留下 cwd；

thread 继续携带旧上下文；

环境变量或临时 token 未清理；

浏览器仍登录上一个账户；

临时文件被下一任务误用；

worker 内缓存与已升级代码不兼容。

影响

数据越界；

难以复现；

错误文件被修改；

凭据泄漏；

结果受旧上下文影响。

修复建议

采用：

常驻进程，临时会话，临时工作区。

每个 run/node 创建独立：

thread/session；

worktree；

cwd；

environment allowlist；

temp directory；

capability token。

任务结束后销毁 task context，而不是依赖 worker 自己“忘记”。同时按任务数、运行时间、内存水位周期性滚动重启常驻 worker。

P2：应纳入工程化治理
风险	触发与影响	修复
App Server 协议漂移	升级后字段、事件或实验 API 变化，bridge 解析失败	固定二进制版本，生成并校验 JSON Schema/TS 类型，做 contract test 和 canary；官方客户端本身也固定经过测试的 App Server 版本。
OpenAI

缺少可观测性	只能看到“卡住”，不知道卡在队列、模型、bridge、DB 还是 verifier	记录 queue wait、run latency、heartbeat age、lease generation、kill reason、DB busy、checkpoint、重试和 orphan 数
migration/降级风险	新版本写入新 schema，回滚旧版本后无法读取	schema version、向前兼容迁移、升级备份、禁止未经验证的 down migration
优先级反转	长低优先级任务占据稀缺 worker，高优先级修复无法调度	capability queue、预留容量、aging、可抢占的未产生副作用阶段
artifact 无限增长	大型日志、图片、视频和 snapshot 堆积	内容寻址、引用计数、分级保留策略、run 关闭后的 GC
router 质量退化	ZCode 选错 worker，反复重试	记录 routing decision、成功率、成本、延迟，建立可回放 routing evaluation
3. 可扩展性评估
3.1 新增视频生成：当前架构不能直接承载

视频生成通常具备：

长执行时间；

大输入输出；

异步排队；

阶段化进度；

失败后可恢复或重试；

外部服务 job ID。

这与严格 SLW 冲突。

必须引入：

submit
status
stream-progress
cancel
collect-artifacts

产物不能通过 bridge stdout 搬运，应使用 artifact store：

本地对象目录或对象存储；

content hash；

metadata manifest；

分片上传；

retention；

权限受限的 artifact reference。

因此视频能力不是“再加一个 worker 名称”，而是会迫使系统正式拥有 durable asynchronous job 语义。

3.2 多 worker 并行：先受限于 scheduler，再受限于 SQLite

当前最先出现的瓶颈通常是全局顺序调度器，而不是 SQLite。

建议演进为：

DAG Ready Queue
 ├─ codex pool
 ├─ agy pool
 ├─ gpt-pro pool
 ├─ image pool
 ├─ video/GPU pool
 └─ verifier pool

调度 key 至少包括：

capability；

workspace；

read/write mode；

CPU/GPU/browser 资源；
-预算；
-优先级；
-租约；
-并发上限。

SQLite 可以继续使用的阶段

SQLite 仍适合：

单主机；

单 scheduler；

少量 worker；

短事务；

heartbeat 写入经过合并；

不要求 active-active。

应迁移到 PostgreSQL/持久队列的条件

不是达到某个固定任务数，而是出现以下条件：

多主机 worker；

多 scheduler active-active；

需要 HA failover；

写争用和 SQLITE_BUSY 成为常态；

状态必须被远程节点共享；

需要数据库级 claim，例如 SKIP LOCKED；

单机故障不能接受。

即使迁移数据库，lease、fencing、幂等和 reconciliation 仍然必须存在；换数据库不会自动解决任务所有权问题。

3.3 leader 本身会成为下一阶段单点

ZCode 既负责：

路由；

DAG 规划；
-审批；
-验证；
-恢复。

随着并行度提高，它会成为上下文和吞吐瓶颈。

长期应将：

run state；

policy；

routing decision；

evidence；

worker registry

全部持久化，使 leader 变成可重建的 stateless decision process。新的 leader 实例应能够基于状态存储恢复，而不是依赖旧对话仍在内存中。

4. 与同类架构的对比

ReAct 的核心是交错执行 reasoning 和 action；AutoGen 以可对话的多 agent 组合为核心，CrewAI 的 agent 可协作和委派，同时其 Flow 提供结构化、事件驱动的状态与控制流。
CrewAI Documentation
+3
arXiv
+3
微软
+3

范式	优势	主要代价	zcode-codex-leader 的取舍
ReAct agent	单循环简单；观察后即时改计划；交互自然	计划、执行和权限混在同一上下文；难做硬隔离和确定恢复	本架构牺牲部分即时性，换取控制平面、状态机和审计
AutoGen/CrewAI 式 multi-agent	专业化、协作、并行、动态委派能力强	消息边多；容易循环；成本和责任归属更复杂	本架构用唯一 router 消除直接互调，但当前隔离略过硬
single LLM with tools	实现最简单；延迟低；上下文传递损失小	单一上下文容易污染；权限爆炸半径大；模型和工具无法独立恢复	本架构增加 bridge/DAG 的复杂度，换取故障隔离与专业 worker
当前 leader-worker	强策略、强审计、异构 worker、可验证 DAG	router/bridge 单点；handoff 成本；顺序调度；长任务语义不成熟	适合高约束代码工作流，但需补齐 durable execution

最合理的目标不是完全转向自由多 agent，而是：

中央控制的 leader-worker + 仲裁式能力请求 + durable DAG。

这保留当前安全边界，同时获得必要的动态协作。

5. 建议的目标状态模型

不要把客户端连接状态放进任务主状态。建议分开建模。

任务状态
QUEUED
  -> DISPATCHING
  -> RUNNING
     -> WAITING_INPUT
     -> VERIFYING
     -> SUCCEEDED
     -> FAILED
     -> CANCEL_REQUESTED -> CANCELLED
     -> ORPHANED -> RECONCILING -> QUEUED / FAILED
客户端附着状态
ATTACHED
DETACHED
RECONNECTED

客户端 detached 不应改变任务所有权。

三条核心不变量

只有当前 lease generation 可以提交结果。

任何重试都使用新 attempt、新 workspace、新 generation。

只有 verifier 接受并原子 promote 后，节点才能进入 SUCCEEDED。

6. 改进路线图
短期：1–2 周
最高优先级

验证 gate 真实生效

确认 leader 是 Claude CLI 还是 ZCode Agent；

增加绕过测试矩阵；

从通用 Bash 改成固定 control wrapper；

permission/sandbox deny-by-default；

失败则拒绝启动。

实现正式任务状态机

run_id/node_id/attempt/idempotency_key；

owner 和 lease_generation；

CAS heartbeat/complete；

ORPHANED 和 RECONCILING；

timeout 不再直接写 FAILED。

重构 hang-killer

去除“90 秒无 tool 即 kill”；

接入 process、transport、turn status 和 progress 四类信号；

soft probe → interrupt → TERM → KILL；

记录 kill reason。

加入 break-glass 控制面

doctor、status、restart、reconcile、lease inspect/revoke、DB check、bridge rollback；

不提供任意 shell或业务代码写权限。

SQLite 加固

WAL；

synchronous=FULL；

busy_timeout；

本地文件系统；

短事务；

startup integrity check；

checkpoint 和一致备份。

故障注入测试
在以下每个边界强制 kill：

dispatch 前后；

worker 已写文件但未记录结果；

DB commit 前后；

result manifest 写入前后；

outer timeout；

heartbeat 丢失；

cancellation；

stale worker 延迟返回。

短期验收标准

同一个 idempotency key 重复提交只生成一个任务；

leader 断线重连后能找回同一 run；

20 分钟合法静默任务不会仅因无 tool call 被杀；

stale generation 的结果不能 promote；

worker 在任意提交边界崩溃后，不会产生重复最终提交；

bridge 故障时 leader 可以执行受限恢复。

中期：1–2 月

上线混合 SLW

短任务同步 fast path；

长任务 durable submit/status/collect；

阈值由实际 p95 延迟决定，而非固定猜测。

实现 DAG-ready 并行调度

capability worker pools；

workspace 读写锁；

配额、优先级、fairness；

独立节点并行。

引入 outbox/inbox 和 artifact manifest

结果幂等摄入；

内容 hash；

每 attempt 独立 worktree；

atomic promotion；

自动 reconciler。

实现仲裁式能力请求

worker 可向 leader 申请能力；

leader 负责预算、循环、权限和 DAG；

禁止 worker 直接连接其他 worker。

独立 verifier

ephemeral read-only verifier；

typed evidence；

高风险任务双重验证；

assertion 与 machine evidence 分级。

增强隔离

每任务 thread/worktree/env；

scoped credentials；

常驻 worker 周期性 recycle；

browser/session 清理。

可观测性

queue/run/verify latency；

heartbeat/lease age；

stall 和 kill 原因；

retry/orphan/reconcile；

worker 利用率；

SQLite busy/WAL/checkpoint。

长期：季度

多主机 worker 与可重建 leader

leader 无本地唯一状态；

worker registry 和任务状态持久化；

scheduler 可故障切换。

采用 durable workflow engine，或实现同等语义

durable timers；

heartbeat；

retry policy；

cancellation；

activity idempotency；

replay/reconciliation。

按触发条件迁移 PostgreSQL + durable queue

多 scheduler；

多主机；

HA；

高频状态更新；

active-active claim。

协议与发布治理

App Server/bridge schema registry；

contract tests；

canary worker；

rolling upgrade；

自动回滚；

禁止生产依赖未隔离的 experimental API。

资源与策略平台化

model/capability registry；

成本和 token 预算；

GPU/browser 配额；

路由质量评估；

数据分类与出站策略。

灾备和安全验证

SQLite/PostgreSQL 恢复演练；

artifact restore；

worker 被攻陷的 blast-radius 测试；

prompt-injection 绕过测试；

定期 chaos test。

最终判断

这套架构最应该保留的是：

ZCode 唯一 router；

worker 不直接互调；

单一受控 bridge；

常驻执行进程；

DAG 与 evidence；

ephemeral verifier/test worker。

最应该立即修改的是：

“同一 turn 完成”改为“同一 turn 持久登记”；

lock 改为 lease + fencing；

timeout 与 cancellation 分离；

postToolQuiet 不再作为 kill 的充分条件；

gate 从 Hook 约定升级为 permission/sandbox 硬边界；

单通道增加受限 break-glass；

worker 结果通过 attempt workspace + atomic promotion 提交。

一句话概括：ZCode turn 是交互边界，不应成为任务持久性边界；bridge 是策略入口，不应成为唯一恢复入口；quiet 是观测信号，不是死亡证明。