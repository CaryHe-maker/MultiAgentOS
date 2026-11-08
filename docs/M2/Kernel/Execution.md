# MultiAgentOS M2 Kernel.Execution

> 状态：已实现；发布前再与代码核对一次。

## 1. 定位

Execution 负责 UnitAttempt、执行队列、产物与内建 Unit；还负责工作区快照、快照索引与改动检测。
组件间交互见 [Interaction](Interaction.md)，长期规划见 [Execution 架构](../../Architecture/Kernel/Execution.md)。

## 2. 相对 M1 的变化

| M1 | M2 | 依据 |
|---|---|---|
| 产物归属按运行登记，引用只能在本运行内使用 | 按 Session 登记（Session 级状态），写入 `artifact-owners.jsonl`；引用在本 Session 内有效 | M2Design 第 10.1 节 |
| 正文只有执行产物、报告与运行摘要 | 增加用户输入的正文（`storeUserInput`）与发布的消息（`message-publish`） | M2Design 第 4.2、8.1 节 |
| 只有内建 Unit `report-publish` | 增加 `message-publish` | M2Design 第 8.1 节 |
| 不读取项目文件 | `readProjectFile`：按白名单读取 `AGENTS.md` 与模板文件，正文存为产物 | M2Design 第 7.5 节 |
| 产物没有保留类别 | 登记 `SESSION` 或 `EXPIRING`：工具结果的预览长期保留，完整输出与 ContextPack 7 天过期 | M2Design 第 8.2、10.1 节 |
| 启动时不回收产物 | 启动时与每小时回收：只按 ACTIVE 的 Session 的登记与保留期标记，其余在本次回收开始之前写入的正文删除 | [ArtifactStore](../Infrastructure/ArtifactStore.md) 第 4 节 |
| 预览上限就是 `maxOutputBytes` | 预览上限为 `previewMaxBytes`、`previewMaxLines`，并且不超过 `maxOutputBytes` | M2Design 第 8.2 节 |
| 技术重试只按指数退避等待 | 以指数退避与 `Retry-After` 中较大者等待，超过 `retryAfterMaxMs` 不再重试；等待期间发出"重试中"的活动 | M2Design 第 7.4 节 |
| — | `output-read` 的输入解析：`fullRef` 的归属与过期检查 | M2Design 第 8.2 节 |
| — | 压缩中的规模估算（实测加估算）、修剪的截取与存储、摘要请求的两种组装与执行 | M2Design 第 9.6 节 |
| 唯一的 FIFO | 改为按 AgentRun 分队列与并发类别 | M2Design 第 7.1 节 |
| 不做快照 | 工作区快照、快照索引、改动检测、回退 | M2Design 第 4.6、7.1 节 |

UnitAttempt 的状态机、技术重试（等待时间见第 4a 节）、`ExecutionRequest` 的构建与上下文构建记录与 M1 相同，见归档的 [M1 Execution](../../History/M1/Kernel/Execution.md) 第 3、6–8 节。

## 3. 产物归属

- 每写入一个产物，Execution 追加一行 `ArtifactOwnerLine`（Interface/Persistence 第 4.3 节），并更新内存中的归属索引。
- 保留类别（M2Design 第 10.1 节）：

  | 产物 | 类别 |
  |---|---|
  | 工具 Unit 的预览（`outputRef`）、模型输出、思考内容、用户输入、回复与运行结果、报告、运行摘要、`AGENTS.md` 与模板文件、压缩的摘要 | `SESSION` |
  | 工具 Unit 截断时的完整输出（`fullRef`）、ContextPack | `EXPIRING` |

- 预览上限随 `ExecutionLimits` 交给 Executor：`min(previewMaxBytes, maxOutputBytes)` 字节与 `previewMaxLines` 行（M2Design 第 8.2 节）。
- 工具 Unit 的结果检查：Executor 交回预览与（截断时的）完整输出；预览超过上述上限、或完整输出超过 `maxFullOutputBytes` 时以 `REJECTED(LIMIT_EXCEEDED)` 结束，不写入；
  否则预览存为 `outputRef`，完整输出存为 `fullRef`（登记行带 `fullOutput: true`）。
- 修剪（第 6a 节）时，没有截断的工具结果的预览就是完整输出：Execution 为它追加一行带 `fullOutput: true` 的登记（类别仍为 `SESSION`），使它可以经 `read_output` 读回。
- 打开 Session 时从 `artifact-owners.jsonl` 读入归属索引。
- 需要解析的引用（M1 Execution 第 4 节列出的位置，加上 `HumanAnswered.contentRef`、`MessagePublishInput` 中的引用、`readArtifact` 的引用）
  必须在本 Session 的归属索引中，且 `sha256`、`size` 一致，否则返回 `INVALID_ARTIFACT_REF`，不说明是不存在还是不属于本 Session。
  在归属索引中、但已过保留期时返回 `ARTIFACT_EXPIRED`：`EXPIRING` 的登记按 `retainedSince` 加 `expiringRetentionDays` 判断，与正文是否已被删除无关；正文意外缺失时同样返回它。
- `fullRef` 只能出现在 `output-read` 的输入中（第 5a 节）；上下文组装的输入中出现 `fullRef` 时以 `INVALID_INPUT` 拒绝：完整输出只经 `read_output` 分段进入模型上下文（M2Design 第 8.2 节）。
- 授权仍按运行：能引用旧产物，不等于能重新读取仓库（M2Design 第 10.1 节）。

## 4. 用户输入与项目文件

- `storeUserInput({ inputId, text })`：把正文以 `text/plain; charset=utf-8` 存为产物，登记归属；同一 `inputId` 再次调用返回同一引用。
- `readProjectFile(path, scope)`：只接受 Interface/WorkflowKernel 第 2.2 节的白名单路径（包括子目录的 `AGENTS.md`，路径须不在排除规则内）；经 `RepositoryAccess` 读取（与 `file-read` 共用路径检查与排除规则），
  不跟随符号链接；文件不存在时返回 `exists: false`；存在时把正文存为产物并返回 SHA-256。不计入任何 AgentRun 的额度。

## 4c. 按 AgentRun 分队列

设计以 M2Design 第 7.1、7.2 节为准。`RunExecution` 的队列由纯函数部分 `AttemptQueues`（`session/execution-queues.ts`）管理，它不启动任何东西，只回答"现在哪些可以开始"。

- **并发类别**：`concurrencyClassOf`（`run-execution.ts`）由执行类型得出：`MODEL`；`FILE_WRITE`、`FILE_EDIT`、`MESSAGE_PUBLISH`、`REPORT_PUBLISH` 为 WRITE；`COMMAND` 为 EXEC，**但可写根目录为空的沙盒命令（只读名单上的命令行，M2Design 第 5.2 节）为 READ**，不占全局 EXEC 互斥、也不是屏障；其余为 READ。
- **同一 AgentRun 内**：按建立先后开始；相邻的 READ 一起开始；WRITE、EXEC、MODEL 是屏障——前面的全部结束后才开始，它结束之后后面的才开始。
- **不同 AgentRun**：队列并行，受三项全局约束：`kernel.maxConcurrentAttempts`（缺省 6）、`kernel.maxConcurrentExec`（缺省 1，只数 EXEC）、`kernel.serialExecution`（缺省 `false`；开启时每个 Unit 都是屏障、全局只有一个在执行）。多个可以开始时先开始最早的（FCFS，不区分 Agent）。
- **只有真正在执行的尝试占用并发计数**：排队的、等待调用机会的、挂在授权询问上的都不占。
- **等待调用机会**（第 7.2 节）：`requestReservation` 返回 `WAIT_CAPACITY` 不是失败。该尝试保持在自己队列的队首、不占并发计数，登记在等待列表中；Session actor 每处理完一条消息，调用 `drainCapacityWaiters()`，按建立先后为等待的尝试重新申请，第一个仍申请不到的结束这一轮，较晚的不会越过较早的。技术重试保留自己的调用机会，不会在重试时丢给别的 AgentRun。
- **收敛**：没有开始的尝试与等待调用机会的尝试直接结束（`abandon`），没有东西需要停止；已发出的执行发出取消，Supervisor 不确认时全部按 `STOP_UNCONFIRMED` 判定。
- 测试：`execution-queues.test.ts`（纯函数）、`run-execution.test.ts`（P1：相邻 READ 一起派发；P2：两个 AgentRun 并行；屏障；全局上限；`serialExecution`；等待调用机会）。

## 4d. 命令改动检测

设计以 M2Design 第 7.1 节为准。`session/change-scan.ts` 在沙盒命令（可写根目录非空）第一次派发前，按指纹（大小、mtime、ctime、inode）扫描该 AgentRun 的可写根目录，命令完成后再扫一次，差异（新增、修改、删除，排序）作为 `changedFiles` 放进 UnitReport，与 `FILE_WRITE`、`FILE_EDIT` 的 `changedFiles` 同一字段。要点：

- 扫描不计算内容摘要，只用 `lstat`；这样同一毫秒内大小不变的改写可能漏报，改动检测只用于对账和提示，不据此判断授权或写入占用；
- 不进入 `.git`、`node_modules` 和被排除规则命中的路径（M2Design 说的"只报告变化数量"尚未实现，这些路径的改动不出现）；
- 条目数超过 `maxSnapshotFiles × 10` 时放弃，报告里没有 `changedFiles`（不影响命令本身）；
- 只读命令（可写根目录为空）不扫描；技术重试不重新取"之前"的扫描。
- 测试：`change-scan.test.ts`；`subagents-exit` 的"命令改动"用例在真实沙盒中验证。

## 4e. 暂停与中止时的尝试

设计以 M2Design 第 4.4、7.6 节为准。`RunExecution` 增加两个入口：`pause()` 与 `abort()`；它们由 Core 的控制状态驱动（[Core](Core.md) 第 5e 节），`AttemptQueues` 不变。

**`pause()`**（进入 PAUSING）：先停止派发（队列中的尝试保留，不占并发计数，等待调用机会的尝试也保留在等待列表中），再按并发类别处理已经派发的尝试：

| 并发类别 | 处理 | 结果 |
|---|---|---|
| READ | 允许完成；超过 `pauseDrainMs`（缺省 5000）仍未完成的，取消 | 完成：照常交付；取消：`INTERRUPTED(PAUSED)` |
| WRITE | 允许完成，不取消 | 照常交付 |
| MODEL | 立即取消，已消耗的 token 照常结算 | `INTERRUPTED(PAUSED)`；不计 Round，不进入历史 |
| EXEC | `cancelExecution({ reason: 'PAUSED' })`，等 Supervisor 确认进程组已退出（升级顺序见 M2Design 第 4.7 节）；不确认时按 `STOP_UNCONFIRMED` 处理，系统停机 | `INTERRUPTED(PAUSED)` |
| 挂起在授权询问上的 | 保留 | 回答后在继续时派发 |
| 技术重试的等待 | 保留 | 继续后接着等 |

在途尝试数为 0 时通知 Core，Core 进入 PAUSED。**`resume()`**：恢复派发；保留的尝试按建立先后依次开始，仍受第 4c 节的队列规则、全局上限与调用机会约束。被取消的 READ、MODEL 由 Workflow 重新提交（[Workflow](../Module/Workflow.md) 第 7b 节），EXEC 不自动重跑。

**`abort()`**（进入 INTERRUPTING）：
- 已派发的尝试全部取消，`INTERRUPTED(ABORTED)`；EXEC 经 `cancelExecution({ reason: 'ABORTED' })`；MODEL 的已发生用量照常结算；WRITE 与 READ 也取消（不再等完成：中止要尽快停下，写了一半的文件由 `/undo` 处理，M2Design 第 4.5 节）；
- 排队中、等待调用机会的尝试从队列移出，同样交付 `INTERRUPTED(ABORTED)`（收敛时清出队列的尝试不交付，这里不同）；
- 技术重试的等待立即结束，交付 `INTERRUPTED(ABORTED)`；
- 之后到达的结果（`runEpoch` 不变，所以仍会交付）按取消的结果记，不会把尝试再次交付。

**报告**：`UnitReport.status = 'INTERRUPTED'`，附 `interruptedBy: 'PAUSED' | 'ABORTED'`；没有 `output`；带 `budget`（已发生的用量已结算）。同一尝试至多交付一次（以尝试状态保证，与其他终态相同）。

**转移**：尝试的状态在 M1 的基础上增加终态 `INTERRUPTED`；`CANCEL_PENDING`（已发出取消、等待确认）不是新的状态，沿用"取消中"标记。

- 测试：`run-execution.test.ts`（暂停时 READ 的排空与取消、WRITE 不取消、MODEL 取消并结算、EXEC 取消并等待确认、排队尝试在暂停时保留、中止时排队尝试交付 INTERRUPTED、重试等待在暂停时保留而中止时结束、继续后依次派发）；`session-actor.test.ts`（H3：授权询问挂起时其他 AgentRun 不受影响）。

## 4f. 模型调用的实时预览

Execution 把 MODEL 的请求交给 Supervisor 时，记下这次执行属于哪个 AgentRun（`modelStarted`），Kernel 核心据此把 Supervisor 发来的 `kernel.execution.ModelProgress` 转成 `kernel.control.ModelStream` 发给 UserInteraction。这只是给使用者看的预览：不是事实、不进日志、不经过 Workflow、不改变任何决定，对不在记下的执行不转发；这次执行的流结束（`END`）时记录即删除。

## 4a. 技术重试的等待

M1 的技术重试规则不变（至多 `technicalRetryLimit` 次，`retryBackoffBaseMs × 2^(n−1)`），等待时间改为（M2Design 第 7.4 节）：

- 失败带 `retryAfterMs`（`model-call` 从 `Retry-After` 换算，ExecutorSet 第 7 节）时，`notBefore = 当前时间 + max(指数退避, retryAfterMs)`；
- `retryAfterMs > retryAfterMaxMs` 时不再重试，按重试耗尽处理（以原失败的原因码结束）；
- 等待期间由 Core 发出 ActivityEvent：阶段 `RETRYING`，带 `retry { attempt, retryAt }`；等待不占用并发计数与调用机会，暂停时保留，中止时交付 `INTERRUPTED(ABORTED)`。

## 4b. 目标引用的解析

`repository-orient` 的 `objectiveRef`、`report-publish` 的 `goalRef` 都按第 3 节检查归属，解析为文字后填入 Executor 输入的 `objective` 或报告的 `goal`。

## 5. 内建 Unit：`message-publish`

与 `report-publish` 相同，不派发给 Supervisor，由 Execution 在 Session actor 的处理中完成：

```text
取到 message-publish 尝试；输入已在受理时按 Schema 校验：
  { kind: 'REPLY', agentLabel, source: { modelOutputRef, toolCallId } }
  { kind: 'DEGRADED_REPLY', agentLabel, reason }                              // 降级回复，只有结构化原因
  { kind: 'RUN_RESULT', agentLabel, report: RunReport }                       // 确定性运行报告
REPLY：
  → modelOutputRef 必须属于本 Session（第 3 节）；从中取出 toolCallId 对应的 reply 调用的 text 参数
  → 把 text 以 text/markdown 存为新的产物，登记归属
DEGRADED_REPLY：
  → 把 { reason } 以 JSON 存为产物，登记归属；不经过额度检查，额度耗尽时也要能发布
RUN_RESULT：
  → report 按 Schema 校验后以 JSON 存为产物，登记归属
→ submitResultCheck(COMPLETED, output = { kind }, outputRef = 新产物)
Core 在结果检查后向 UserInteraction 发出 MessagePublished(messageRef = 新产物)
```

回复的正文只存在于模型调用的输出中，Unit 输入只带引用与 `toolCallId`，因此会话日志中没有正文（M2Design 第 10.1 节）。
确定性运行报告是结构化数据（节点的状态、结果引用、触顶项），可以作为 Unit 输入写入日志（M2Design 第 7.3 节"必有报告"）。

## 5a. `output-read` 的输入解析

`read_output` 的 Unit 输入中，Workflow 已按 `toolCallId` 填入 `fullRef`（[Module/Workflow](../Module/Workflow.md) 第 7 节第 8 条）。Execution 派发前：

1. 按第 3 节检查 `fullRef` 属于本 Session，否则 `INVALID_ARTIFACT_REF`；
2. 登记行必须带 `fullOutput: true`（截断时另存的完整输出，或修剪时补登的未截断预览，Interface/Persistence 第 4.3 节），否则 `INVALID_INPUT`，防止以它读取别的产物；
3. `EXPIRING` 的登记 `retainedSince` 加 `expiringRetentionDays` 已到期，或正文已不存在时返回 `ARTIFACT_EXPIRED`，不派发；补登的预览是 `SESSION` 类，不会过期；
4. 经 `ArtifactStorePort.get` 读出正文（复验 sha256 与 size），与其余输入一起交给 `output-read` Executor（[ExecutorSet](../Library/ExecutorSet.md) 第 5a 节）。

结果作为该 Unit 的预览存为 `SESSION` 类产物；`output-read` 不交回完整输出，因此没有 `fullRef`。

## 6. 产物回收

回收在 Kernel 核心启动时、开放服务之前进行一次，之后每隔 `artifactRetention.sweepIntervalMinutes`（缺省 60）进行一次：

1. 读取 Session 引用（`session-refs.jsonl`），只取 ACTIVE 的 Session；
2. 逐个读取它们的 `artifact-owners.jsonl`：`SESSION` 的登记一律标记保留；`EXPIRING` 的登记在 `retainedSince` 之后未满 `expiringRetentionDays` 时标记保留；
3. 以标记集合调用 `ArtifactStorePort.sweep`（[ArtifactStore](../Infrastructure/ArtifactStore.md) 第 4 节），删除其余在本次回收开始之前写入的正文。

DELETED 的 Session 即使残留了归属文件也不参与标记。回收失败只写诊断，不阻止启动，也不影响下一次定期回收。

**定期回收**：由 Session 管理的定时器发出内部消息 `ARTIFACT_SWEEP_TICK`（[Interaction](Interaction.md) 第 5.1 节），在 Session 管理中按顺序开始，读取归属文件与删除正文的 I/O 只登记、在后台完成，上一次未完成时跳过本次。
与它并发的写入不受影响：登记行在产物引用交出之前已追加；写入已存在的正文时 ArtifactStore 更新它的写入时间，回收开始之后被再次写入的正文不会被删除。

**Session 删除与失败时的清理**：`deleteSession` 时，不论 Workflow 是否删除成功，Execution 都删除该 Session 的 `kernel-execution` 目录；
新建 Session 失败时（Workflow 回复 `CREATE` 失败），Execution 同样删除已为它写入的归属文件（第一条输入的登记）。正文由下一次回收删除。

## 6b. 工作区快照

影子 git 仓库在 `sessions/<id>/kernel-execution/snapshots/`，经 Supervisor 的 `git` 子进程操作（[Supervisor](Supervisor.md) 第 3 节），不要求被分析的仓库是 git 仓库：

```text
环境：GIT_DIR=<影子目录>、GIT_WORK_TREE=<仓库>、GIT_INDEX_FILE=<临时文件>、GIT_CONFIG_NOSYSTEM=1、GIT_CONFIG_GLOBAL=/dev/null
拍摄：按排除规则遍历工作区（不跟随符号链接，不读仓库的 .gitignore）
      → git update-index --force-remove（已不在的条目）→ git update-index --add --remove -z --stdin → git write-tree，得到快照 ID（tree）
跳过：超过 16 MiB（文件工具的上限）、且不在上一个快照中的文件
属性：影子目录的 info/attributes 关闭 text、eol、ident、filter 与编码转换，快照保存磁盘上的原始字节
```

- Turn 开启时拍开始快照，写入索引；结束时拍结束快照，以 `git diff-tree` 算出改动过的文件，追加到索引（`SnapshotIndexLine`，Interface/Persistence 第 4.4 节）。
- 影子仓库关闭 gc（`gc.auto=0`）；快照只被快照索引引用，随 Session 目录删除。
- 快照失败时 Turn 照常进行，但在索引中记为没有快照：这个 Turn 不能回退，`/undo` 说明原因。写入与回退依赖 git，启动探测见 M2Design 第 4.6 节。
- 拍摄读文件内容，只在静止点进行，读取结束后不持有任何状态。

## 6c. 回退

Execution 提供 `planUndo`、`applyUndo`、`diffTurn`，由 Core 发起（Core 第 5a.5 节）。步骤与 M2Design 第 4.6 节相同：

1. **范围**：被回退各 Turn 改动过的文件的并集；目标为第一个改它的 Turn 的开始快照，目标中不存在时删除；
2. **检查**：比较当前内容与最后改它的 Turn 的结束快照；没有结束快照的 Turn 按"开始快照与下一个 Turn 的开始快照之间的差异"计算，它就是最后一个时全部按外部修改处理；
3. **兜底**：强制时先拍一个快照，引用写入回退记录；
4. **写入**：逐个文件写入前再比较一次；不一致时停止，已写入的文件按兜底快照恢复，返回 `UNDO_FILE_CHANGED`；写入用同一套原子写入，保留文件权限；
5. **记录**：向快照索引追加 `{ revertedTurnIds, forced, backupSnapshot? }`。

Fork 不复制快照：新 Session 的 `/undo`、`/diff` 只覆盖自己的 Turn。切换或打开 Session 时，比较当前工作区与最后一个 Turn 的结束快照，差异作为 `divergedFiles` 与 `WorkspaceDiverged` 告知（M2Design 第 2.3 节 Session 第 6 条）。

## 6d. Fork 的产物继承

`inheritArtifacts(refs)`：Workflow 复制日志时列出其中的 ArtifactRef，Execution 从原 Session 的归属索引读取每个引用的登记，以 `source: INHERITED` 写入新 Session，保留类别、`retainedSince` 与 `fullOutput` 不变；原 Session 没有登记的引用跳过并写审计。

## 6a. 压缩中的估算、修剪与摘要请求

压缩过程（M2Design 第 9.6 节）中，Core 请 Execution 估算规模、修剪工具结果、组装并执行摘要请求：

- **估算**（`estimateAssembly`）：取条目中该对象最近一次模型轮带的实测用量（`MODEL_TURN.usage` 的输入与输出 token，Workflow 随条目交来）与它对应的 `headDigest`；
  与本次组装的 `headDigest` 相同、且其后没有修剪后的条目或摘要条目时，估算 = 实测输入 + 实测输出 + 其后新增条目的字节估算；否则全部按字节估算（M1 的 `estimatePackTokens`）。
  额度预留不用这个估算，仍用字节估算（Monitor 第 3.4 节）。
- **修剪**（第 4.5 步）：按 Core 给出的候选（保留区之前、预览超过 `pruneMinBytes`、尚未修剪的 `NORMAL` 工具结果）读出预览正文，作为 Kernel 内部尝试交给 `CONTEXT_PRUNE` Executor（Kernel 自己的执行种类，ExecutorSet 第 6.4 节）；
  修剪后的结果存为 `SESSION` 类产物；没有截断的结果补登 `fullOutput: true`（第 3 节）；交回每项的 `toolCallId`、修剪后的引用与可读回的引用（截断时为 `fullRef`，否则为原预览）；
- **组装**：前缀式用 Workflow 交回的投影条目中 `seq ≤ toSeq` 的部分，按该对象普通请求的方式经 `context-assemble` Executor 组装，末尾追加 Prompt `compaction-system` 的指令；
  前缀式的估算超出 `perCallInputLimit − summaryMaxTokens`，或 `model-call` 返回 `CONTEXT_OVERFLOW` 时，按 Core 给出的目标改用纯文本式（ExecutorSet 第 6.4 节）；
- 执行：作为一次 Kernel 内部的 MODEL 尝试，经 Core 申请调用机会与额度（与普通尝试相同的内部 syscall，Core 调用 Scheduler 与 Monitor），由 Supervisor 派发给 `model-call` Executor（`purpose = 'COMPACTION'`）；
  不属于任何 Workflow 提交的 Unit，不产生 UnitReport；用量按 Core 指定的账本结算（Monitor 第 3.4 节）；
- 结果：摘要文本存为 `SESSION` 类产物，连同所用的方式与去掉的条目数（`summaryInput`）交回 Core；`COMPACTION_SUMMARY_INVALID` 时由 Core 决定重试一次，`CONTEXT_OVERFLOW` 时由 Core 按 `summaryFallbackTargets` 给出下一个目标。

## 7. 配置

| 配置 | 读取者 | 缺省 |
|---|---|---|
| `executionLimits.MESSAGE_PUBLISH`、`REPOSITORY_LIST` | Execution | 前者为内建，不设截止时间；后者 `timeoutMs` 30000、`maxOutputBytes` 1048576 |
| `executionLimits.<工具 Unit>.previewMaxBytes`、`previewMaxLines` | Execution、Executor | 51200、2000（M2Design 第 8.2 节） |
| `executionLimits.<工具 Unit>.maxFullOutputBytes` | Execution、Executor | 8388608（8 MiB） |
| `executionLimits.OUTPUT_READ` | Execution | `timeoutMs` 30000、`maxOutputBytes` 51200 |
| `KernelConfig.retryAfterMaxMs` | Execution | 120000 |
| `artifactRetention.expiringRetentionDays` | Execution | 7 |
| `artifactRetention.sweepIntervalMinutes` | Execution | 60 |
| 其余 | Execution | 与 M1 Execution 第 10 节相同 |

## 8. 不变量与测试

| 不变量（M2Design 第 12 节） | 测试 |
|---|---|
| 12：凭据不进入模型上下文与普通日志 | 单元测试：provider 凭据只在执行时交给 `model-call` Executor；以带标记的假凭据运行，扫描审计、会话日志、ContextPack 与全部产物，不出现该标记；子进程环境的部分由 Supervisor 保证 |
| 15：ArtifactStore 只由 Execution 写入；日志中只有引用 | 架构测试：只有 Execution 持有 `ArtifactStorePort` |
| 产物引用只在本 Session 内有效 | 单元测试：另一 Session 的引用返回 `INVALID_ARTIFACT_REF`；重开 Session 后旧引用仍然有效 |
| 29：只有 ACTIVE 的 Session 的登记能让正文免于回收 | 单元测试：`EXPIRING` 满 7 天后被回收（启动时与定期回收各一例，以假时钟驱动），读取得到 `ARTIFACT_EXPIRED`；到期而尚未回收的正文读取同样得到 `ARTIFACT_EXPIRED`；回收开始后再次写入的正文不被删除；`SESSION` 的正文在 ACTIVE 的 Session 拥有期间不被回收；DELETED 的 Session 残留的归属文件不影响回收；同一正文在两个 Session 中、以不同类别登记时取最长的保留 |
| 7：重建只需要长期保留的正文 | 集成测试：删除全部 `EXPIRING` 正文后，重放日志得到相同的 `context-assemble` 输入（包括 `read_output` 的结果与修剪后的结果） |
| 预览上限 | 单元测试：预览不超过 `previewMaxBytes` 与 `previewMaxLines` |
| 技术重试的等待 | 单元测试（假时钟）：`retryAfterMs` 大于指数退避时按它等待；超过 `retryAfterMaxMs` 时不再重试；等待期间有 `RETRYING` 活动，中止时交付 `INTERRUPTED(ABORTED)` |
| 30：`read_output` 只读到本 Session、未过期的完整输出 | 单元测试：另一 Session 的 `fullRef` 得到 `INVALID_ARTIFACT_REF`；不带 `fullOutput` 标记的引用得到 `INVALID_INPUT`；到期得到 `ARTIFACT_EXPIRED` 且不派发；修剪时补登的预览可以读取且不过期；`context-assemble` 输入中的 `fullRef` 被拒绝 |
| 压缩的估算是日志的纯函数 | 单元测试：`headDigest` 相同且其后没有修剪与摘要时使用实测值，否则按字节估算；同一组条目得到相同的估算 |
