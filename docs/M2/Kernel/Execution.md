# MultiAgentOS M2 Kernel.Execution

> 状态：草稿（阶段 1）。

## 1. 定位

Execution 负责 UnitAttempt、执行队列、产物与内建 Unit；阶段 2 起还负责工作区快照、快照索引与改动检测。
组件间交互见 [Interaction](Interaction.md)，长期规划见 [Execution 架构](../../Architecture/Kernel/Execution.md)。

## 2. 相对 M1 的变化

| M1 | M2 | 依据 | 阶段 |
|---|---|---|---|
| 产物归属按运行登记，引用只能在本运行内使用 | 按 Session 登记（Session 级状态），写入 `artifact-owners.jsonl`；引用在本 Session 内有效 | M2Design 第 10.1 节 | 1 |
| 正文只有执行产物、报告与运行摘要 | 增加用户输入的正文（`storeUserInput`）与发布的消息（`message-publish`） | M2Design 第 4.2、8.1 节 | 1 |
| 只有内建 Unit `report-publish` | 增加 `message-publish` | M2Design 第 8.1 节 | 1 |
| 不读取项目文件 | `readProjectFile`：按白名单读取 `AGENTS.md` 与模板文件，正文存为产物 | M2Design 第 7.5 节 | 1 |
| 产物没有保留类别 | 登记 `SESSION` 或 `EXPIRING`：工具结果的预览长期保留，完整输出与 ContextPack 7 天过期 | M2Design 第 8.2、10.1 节 | 1 |
| 启动时不回收产物 | 启动时与每小时回收：只按 ACTIVE 的 Session 的登记与保留期标记，其余在本次回收开始之前写入的正文删除 | [ArtifactStore](../Infrastructure/ArtifactStore.md) 第 4 节 | 1 |
| 预览上限就是 `maxOutputBytes` | 按 Unit 定义的版本选取预览上限：`v1` 为 `previewMaxBytes`、`previewMaxLines`（并且不超过 `maxOutputBytes`），`v0` 为 `maxOutputBytes` | M2Design 第 8.2 节 | 1 |
| 技术重试只按指数退避等待 | 以指数退避与 `Retry-After` 中较大者等待，超过 `retryAfterMaxMs` 不再重试；等待期间发出"重试中"的活动 | M2Design 第 7.4 节 | 1 |
| — | `output-read` 的输入解析：`fullRef` 的归属与过期检查 | M2Design 第 8.2 节 | 2 |
| — | 压缩中的规模估算（实测加估算）、修剪的截取与存储、摘要请求的两种组装与执行 | M2Design 第 9.6 节 | 8 |
| 唯一的 FIFO | 阶段 1 不变；阶段 4 改为按 AgentRun 分队列与并发类别 | M2Design 第 7.1 节 | 4 |
| 不做快照 | 工作区快照、快照索引、改动检测、回退 | M2Design 第 4.6、7.1 节 | 2 |

UnitAttempt 的状态机、技术重试（等待时间见第 4a 节）、`ExecutionRequest` 的构建与上下文构建记录与 M1 相同，见归档的 [M1 Execution](../../History/M1/Kernel/Execution.md) 第 3、6–8 节。

## 3. 产物归属

- 每写入一个产物，Execution 追加一行 `ArtifactOwnerLine`（Interface/Persistence 第 4.3 节），并更新内存中的归属索引。
- 保留类别（M2Design 第 10.1 节）：

  | 产物 | 类别 |
  |---|---|
  | 工具 Unit 的预览（`outputRef`）、模型输出、思考内容、用户输入、回复与运行结果、报告、运行摘要、`AGENTS.md` 与模板文件、压缩的摘要 | `SESSION` |
  | 工具 Unit 截断时的完整输出（`fullRef`）、ContextPack | `EXPIRING` |

- 预览上限按 Unit 定义的版本选取（M2Design 第 8.2 节），随 `ExecutionLimits` 交给 Executor：`v1` 为 `min(previewMaxBytes, maxOutputBytes)` 字节与 `previewMaxLines` 行；`v0`（`analyze` 使用的 M1 Unit）为 `maxOutputBytes`、不限行数。
- 工具 Unit 的结果检查：Executor 交回预览与（截断时的）完整输出；预览超过上述上限、或完整输出超过 `maxFullOutputBytes` 时以 `LIMIT_EXCEEDED` 失败，不写入；
  否则预览存为 `outputRef`，完整输出存为 `fullRef`（登记行带 `fullOutput: true`）。M1 Executor 截断后的输出就是预览，所以 `analyze` 看到的内容不变。
- 修剪（第 6a 节）时，没有截断的工具结果的预览就是完整输出：Execution 为它追加一行带 `fullOutput: true` 的登记（类别仍为 `SESSION`），使它可以经 `read_output` 读回。
- 打开 Session 时从 `artifact-owners.jsonl` 读入归属索引。
- 需要解析的引用（M1 Execution 第 4 节列出的位置，加上 `HumanAnswered.contentRef`、`MessagePublishInput` 中的引用、`readArtifact` 的引用）
  必须在本 Session 的归属索引中，且 `sha256`、`size` 一致，否则返回 `INVALID_ARTIFACT_REF`，不说明是不存在还是不属于本 Session。
  在归属索引中、但已过保留期时返回 `ARTIFACT_EXPIRED`：`EXPIRING` 的登记按 `retainedSince` 加 `expiringRetentionDays` 判断，与正文是否已被删除无关；正文意外缺失时同样返回它。
- `fullRef` 只能出现在 `output-read` 的输入中（第 5a 节）；上下文组装的输入中出现 `fullRef` 时以 `INVALID_INPUT` 拒绝：完整输出只经 `read_output` 分段进入模型上下文（M2Design 第 8.2 节）。
- 授权仍按运行：能引用旧产物，不等于能重新读取仓库（M2Design 第 10.1 节）。

## 4. 用户输入与项目文件

- `storeUserInput({ inputId, text })`：把正文以 `text/plain; charset=utf-8` 存为产物，登记归属；同一 `inputId` 再次调用返回同一引用。
- `readProjectFile(path, scope)`：只接受 Interface/WorkflowKernel 第 2.2 节的白名单路径（阶段 2 起包括子目录的 `AGENTS.md`，路径须不在排除规则内）；经 `RepositoryAccess` 读取（与 `file-read` 共用路径检查与排除规则），
  不跟随符号链接；文件不存在时返回 `exists: false`；存在时把正文存为产物并返回 SHA-256。不计入任何 AgentRun 的额度。

## 4a. 技术重试的等待

M1 的技术重试规则不变（至多 `technicalRetryLimit` 次，`retryBackoffBaseMs × 2^(n−1)`），等待时间改为（M2Design 第 7.4 节）：

- 失败带 `retryAfterMs`（`model-call` 从 `Retry-After` 换算，ExecutorSet 第 7 节）时，`notBefore = 当前时间 + max(指数退避, retryAfterMs)`；
- `retryAfterMs > retryAfterMaxMs` 时不再重试，按重试耗尽处理（以原失败的原因码结束）；
- 等待期间由 Core 发出 ActivityEvent：阶段 `RETRYING`，带 `retry { attempt, retryAt }`；等待不占用并发计数与调用机会，暂停时保留，中止时交付 `INTERRUPTED(ABORTED)`。

## 5. 内建 Unit：`message-publish`

与 `report-publish` 相同，不派发给 Supervisor，由 Execution 在 Session actor 的处理中完成：

```text
取到 message-publish 尝试；输入已在受理时按 Schema 校验：
  { kind: 'REPLY', agentLabel, source: { modelOutputRef, toolCallId } }      // 阶段 1
  { kind: 'RUN_RESULT', agentLabel, report: RunReport }                       // 阶段 7：确定性运行报告
REPLY：
  → modelOutputRef 必须属于本 Session（第 3 节）；从中取出 toolCallId 对应的 reply 调用的 text 参数
  → 把 text 以 text/markdown 存为新的产物，登记归属
RUN_RESULT：
  → report 按 Schema 校验后以 JSON 存为产物，登记归属
→ submitResultCheck(COMPLETED, output = { kind }, outputRef = 新产物)
Core 在结果检查后向 UserInteraction 发出 MessagePublished(messageRef = 新产物)
```

回复的正文只存在于模型调用的输出中，Unit 输入只带引用与 `toolCallId`，因此会话日志中没有正文（M2Design 第 10.1 节）。
确定性运行报告是结构化数据（节点的状态、结果引用、触顶项），可以作为 Unit 输入写入日志（M2Design 第 7.3 节"必有报告"）。

## 5a. `output-read` 的输入解析（阶段 2）

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

## 6a. 压缩中的估算、修剪与摘要请求（阶段 8）

压缩过程（M2Design 第 9.6 节）中，Core 请 Execution 估算规模、修剪工具结果、组装并执行摘要请求：

- **估算**（`estimateAssembly`）：取条目中该对象最近一次模型轮带的实测用量（`MODEL_TURN.usage` 的输入与输出 token，Workflow 随条目交来）与它对应的 `headDigest`；
  与本次组装的 `headDigest` 相同、且其后没有修剪后的条目或摘要条目时，估算 = 实测输入 + 实测输出 + 其后新增条目的字节估算；否则全部按字节估算（M1 的 `estimatePackTokens`）。
  额度预留不用这个估算，仍用字节估算（Monitor 第 3.5 节）。空闲触发时 Core 用 main 最近一次模型调用的实测值，不需要条目；
- **修剪**（第 4.5 步）：按 Core 给出的候选（保留区之前、预览超过 `pruneMinBytes`、尚未修剪的 `NORMAL` 工具结果）读出预览正文，作为 Kernel 内部尝试交给 `context-assemble` Executor（`purpose = 'PRUNE'`，ExecutorSet 第 6.4 节）；
  修剪后的结果存为 `SESSION` 类产物；没有截断的结果补登 `fullOutput: true`（第 3 节）；交回每项的 `toolCallId`、修剪后的引用与可读回的引用（截断时为 `fullRef`，否则为原预览）；
- **组装**：前缀式用 Workflow 交回的投影条目中 `seq ≤ toSeq` 的部分，按该对象普通请求的方式经 `context-assemble` Executor 组装，末尾追加 Prompt `compaction-system` 的指令；
  前缀式的估算超出 `perCallInputLimit − summaryMaxTokens`，或 `model-call` 返回 `CONTEXT_OVERFLOW` 时，按 Core 给出的目标改用纯文本式（ExecutorSet 第 6.4 节）；
- 执行：作为一次 Kernel 内部的 MODEL 尝试，经 Scheduler 申请调用机会，由 Supervisor 派发给 `model-call` Executor（`purpose = 'COMPACTION'`）；
  不属于任何 Workflow 提交的 Unit，不产生 UnitReport；用量按 Core 指定的账本结算（Monitor 第 3.5 节）；
- 结果：摘要文本存为 `SESSION` 类产物，连同所用的方式与去掉的条目数（`summaryInput`）交回 Core；`COMPACTION_SUMMARY_INVALID` 时由 Core 决定重试一次，`CONTEXT_OVERFLOW` 时由 Core 按 `summaryFallbackTargets` 给出下一个目标。

## 7. 配置

| 配置 | 读取者 | 缺省 |
|---|---|---|
| `executionLimits.MESSAGE_PUBLISH`、`REPOSITORY_LIST` | Execution | 前者为内建，不设截止时间；后者 `timeoutMs` 30000、`maxOutputBytes` 1048576 |
| `executionLimits.<工具 Unit>.previewMaxBytes`、`previewMaxLines` | Execution、Executor | 51200、2000；只对 `v1` Unit 生效（M2Design 第 8.2 节） |
| `executionLimits.<工具 Unit>.maxFullOutputBytes` | Execution、Executor | 8388608（8 MiB） |
| `executionLimits.OUTPUT_READ` | Execution | `timeoutMs` 30000、`maxOutputBytes` 51200（阶段 2） |
| `KernelConfig.retryAfterMaxMs` | Execution | 120000 |
| `artifactRetention.expiringRetentionDays` | Execution | 7 |
| `artifactRetention.sweepIntervalMinutes` | Execution | 60 |
| 其余 | Execution | 与 M1 Execution 第 10 节相同 |

## 8. 不变量与测试

| 不变量（M2Design 第 12 节） | 测试 |
|---|---|
| 15：ArtifactStore 只由 Execution 写入；日志中只有引用 | 架构测试：只有 Execution 持有 `ArtifactStorePort` |
| 产物引用只在本 Session 内有效 | 单元测试：另一 Session 的引用返回 `INVALID_ARTIFACT_REF`；重开 Session 后旧引用仍然有效 |
| 29：只有 ACTIVE 的 Session 的登记能让正文免于回收 | 单元测试：`EXPIRING` 满 7 天后被回收（启动时与定期回收各一例，以假时钟驱动），读取得到 `ARTIFACT_EXPIRED`；到期而尚未回收的正文读取同样得到 `ARTIFACT_EXPIRED`；回收开始后再次写入的正文不被删除；`SESSION` 的正文在 ACTIVE 的 Session 拥有期间不被回收；DELETED 的 Session 残留的归属文件不影响回收；同一正文在两个 Session 中、以不同类别登记时取最长的保留 |
| 7：重建只需要长期保留的正文 | 集成测试：删除全部 `EXPIRING` 正文后，重放日志得到相同的 `context-assemble` 输入（包括 `read_output` 的结果与修剪后的结果） |
| 预览上限按定义版本选取 | 单元测试：同一 executionKind 下 `v0` Unit 的预览上限为 `maxOutputBytes`，`v1` Unit 为 `previewMaxBytes` 与 `previewMaxLines` |
| 技术重试的等待 | 单元测试（假时钟）：`retryAfterMs` 大于指数退避时按它等待；超过 `retryAfterMaxMs` 时不再重试；等待期间有 `RETRYING` 活动，中止时交付 `INTERRUPTED(ABORTED)` |
| 30：`read_output` 只读到本 Session、未过期的完整输出（阶段 2） | 单元测试：另一 Session 的 `fullRef` 得到 `INVALID_ARTIFACT_REF`；不带 `fullOutput` 标记的引用得到 `INVALID_INPUT`；到期得到 `ARTIFACT_EXPIRED` 且不派发；修剪时补登的预览可以读取且不过期（阶段 8）；`context-assemble` 输入中的 `fullRef` 被拒绝 |
| 压缩的估算是日志的纯函数（阶段 8） | 单元测试：`headDigest` 相同且其后没有修剪与摘要时使用实测值，否则按字节估算；同一组条目得到相同的估算 |

## 9. 阶段

| 阶段 | 本文增加的内容 |
|---|---|
| 1 | 第 3–8 节（第 5a、6a 节除外），包括第 4a 节 |
| 2 | 影子 git 快照、快照索引、改动检测、`/undo`、`/undo all`、`/diff` 的六个步骤、Fork 时继承产物（沿用原 Session 的保留类别、`retainedSince` 与 `fullOutput` 标记）、打开 Session 时比较工作区、第 5a 节 |
| 3 | 敏感文件列表、受保护路径的新建检查与隔离（包括任一目录中的 `AGENTS.md`：已存在的只读挂载，新建的由改动检测发现后隔离）、EXEC 互斥 |
| 4 | 按 AgentRun 分队列、并发类别与屏障、全局上限、等待调用机会、改动归属 |
| 5 | 按并发类别处理暂停、按执行取消、中止时排队中的尝试也交付 |
| 8 | 第 6a 节：估算、修剪、摘要请求的两种组装与执行 |
