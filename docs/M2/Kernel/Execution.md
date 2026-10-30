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
| 启动时不回收产物 | 启动时回收：只按 ACTIVE 的 Session 的登记与保留期标记，其余早于启动的正文删除 | [ArtifactStore](../Infrastructure/ArtifactStore.md) 第 4 节 | 1 |
| — | 压缩过程中组装与执行摘要请求 | M2Design 第 9.6 节 | 8 |
| 唯一的 FIFO | 阶段 1 不变；阶段 4 改为按 AgentRun 分队列与并发类别 | M2Design 第 7.1 节 | 4 |
| 不做快照 | 工作区快照、快照索引、改动检测、回退 | M2Design 第 4.6、7.1 节 | 2 |

UnitAttempt 的状态机、技术重试、`ExecutionRequest` 的构建与上下文构建记录与 M1 相同，见归档的 [M1 Execution](../../History/M1/Kernel/Execution.md) 第 3、6–8 节。

## 3. 产物归属

- 每写入一个产物，Execution 追加一行 `ArtifactOwnerLine`（Interface/Persistence 第 4.3 节），并更新内存中的归属索引。
- 保留类别（M2Design 第 10.1 节）：

  | 产物 | 类别 |
  |---|---|
  | 工具 Unit 的预览（`outputRef`）、模型输出、思考内容、用户输入、回复与运行结果、报告、运行摘要、`AGENTS.md` 与模板文件、压缩的摘要 | `SESSION` |
  | 工具 Unit 截断时的完整输出（`fullRef`）、ContextPack | `EXPIRING` |

- 工具 Unit 的结果检查：Executor 交回预览与（截断时的）完整输出；预览超过该 Unit 的 `maxOutputBytes` 时以 `LIMIT_EXCEEDED` 失败，不写入；
  否则预览存为 `outputRef`，完整输出存为 `fullRef`。M1 Executor 截断后的输出就是预览，所以 `analyze` 看到的内容不变。
- 打开 Session 时从 `artifact-owners.jsonl` 读入归属索引。
- 需要解析的引用（M1 Execution 第 4 节列出的位置，加上 `HumanAnswered.contentRef`、`MessagePublishInput` 中的引用、`readArtifact` 的引用）
  必须在本 Session 的归属索引中，且 `sha256`、`size` 一致，否则返回 `INVALID_ARTIFACT_REF`，不说明是不存在还是不属于本 Session。
  在归属索引中、但正文已被回收时返回 `ARTIFACT_EXPIRED`。
- 上下文组装的输入中不得出现 `fullRef`：完整输出不进入模型上下文（M2Design 第 8.2 节）。
- 授权仍按运行：能引用旧产物，不等于能重新读取仓库（M2Design 第 10.1 节）。

## 4. 用户输入与项目文件

- `storeUserInput({ inputId, text })`：把正文以 `text/plain; charset=utf-8` 存为产物，登记归属；同一 `inputId` 再次调用返回同一引用。
- `readProjectFile(path, scope)`：只接受 Interface/WorkflowKernel 第 2.2 节的白名单路径；经 `RepositoryAccess` 读取（与 `file-read` 共用路径检查与排除规则），
  不跟随符号链接；文件不存在时返回 `exists: false`；存在时把正文存为产物并返回 SHA-256。不计入任何 AgentRun 的额度。

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

## 6. 启动时的产物回收

Kernel 核心启动时、开放服务之前：

1. 读取 Session 引用（`session-refs.jsonl`），只取 ACTIVE 的 Session；
2. 逐个读取它们的 `artifact-owners.jsonl`：`SESSION` 的登记一律标记保留；`EXPIRING` 的登记在 `retainedSince` 之后未满 `expiringRetentionDays` 时标记保留；
3. 以标记集合调用 `ArtifactStorePort.sweep`（[ArtifactStore](../Infrastructure/ArtifactStore.md) 第 4 节），删除其余早于本次启动写入的正文。

DELETED 的 Session 即使残留了归属文件也不参与标记。回收失败只写诊断，不阻止启动。

**Session 删除与失败时的清理**：`deleteSession` 时，不论 Workflow 是否删除成功，Execution 都删除该 Session 的 `kernel-execution` 目录；
新建 Session 失败时（Workflow 回复 `CREATE` 失败），Execution 同样删除已为它写入的归属文件（第一条输入的登记）。正文由下次启动的回收删除。

## 6a. 摘要请求（阶段 8）

压缩过程（M2Design 第 9.6 节）中，Core 请 Execution 组装并执行摘要请求：

- 组装：用 Workflow 交回的投影条目，按该对象普通请求的方式经 `context-assemble` Executor 组装，末尾追加 Prompt `compaction-system` 的指令；
- 执行：作为一次 Kernel 内部的 MODEL 尝试，经 Scheduler 申请调用机会，由 Supervisor 派发给 `model-call` Executor（`purpose = 'COMPACTION'`）；
  不属于任何 Workflow 提交的 Unit，不产生 UnitReport；用量按 Core 指定的账本结算（Monitor 第 3.5 节）；
- 结果：摘要文本存为 `SESSION` 类产物，交回 Core；`COMPACTION_SUMMARY_INVALID` 时由 Core 决定重试一次。

## 7. 配置

| 配置 | 读取者 | 缺省 |
|---|---|---|
| `executionLimits.MESSAGE_PUBLISH`、`REPOSITORY_LIST` | Execution | 前者为内建，不设截止时间；后者 `timeoutMs` 30000、`maxOutputBytes` 1048576 |
| `artifactRetention.expiringRetentionDays` | Execution | 7 |
| 其余 | Execution | 与 M1 Execution 第 10 节相同 |

## 8. 不变量与测试

| 不变量（M2Design 第 12 节） | 测试 |
|---|---|
| 15：ArtifactStore 只由 Execution 写入；日志中只有引用 | 架构测试：只有 Execution 持有 `ArtifactStorePort` |
| 产物引用只在本 Session 内有效 | 单元测试：另一 Session 的引用返回 `INVALID_ARTIFACT_REF`；重开 Session 后旧引用仍然有效 |
| 29：只有 ACTIVE 的 Session 的登记能让正文免于回收 | 单元测试：`EXPIRING` 满 7 天后被回收，读取得到 `ARTIFACT_EXPIRED`；`SESSION` 的正文在 ACTIVE 的 Session 拥有期间不被回收；DELETED 的 Session 残留的归属文件不影响回收；同一正文在两个 Session 中、以不同类别登记时取最长的保留 |
| 7：重建只需要长期保留的正文 | 集成测试：删除全部 `EXPIRING` 正文后，重放日志得到相同的 `context-assemble` 输入 |

## 9. 阶段

| 阶段 | 本文增加的内容 |
|---|---|
| 1 | 第 3–8 节（第 6a 节除外） |
| 2 | 影子 git 快照、快照索引、改动检测、`/undo`、`/undo all`、`/diff` 的六个步骤、Fork 时继承产物（沿用原 Session 的保留类别与 `retainedSince`）、打开 Session 时比较工作区 |
| 3 | 敏感文件列表、受保护路径的新建检查与隔离、EXEC 互斥 |
| 4 | 按 AgentRun 分队列、并发类别与屏障、全局上限、等待调用机会、改动归属 |
| 5 | 按并发类别处理暂停、按执行取消、中止时排队中的尝试也交付 |
| 8 | 第 6a 节：摘要请求的组装与执行 |
