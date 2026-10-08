# MultiAgentOS M1 Kernel.Execution

## 1. 定位

Execution 负责 UnitAttempt、执行队列、产物与内建 Unit。组件间交互见 [Interaction](Interaction.md)，
长期规划见 [Execution 架构](../../Architecture/Kernel/Execution.md)。

## 2. 职责

- 实现 `ExecutionDuties`（Interaction 3.4），只经 `CoreSyscalls` 与 Core 交互，不读写 Core、Monitor、Scheduler 的数据。
- 幂等建立 UnitAttempt 并记录建立时的 runEpoch，维护执行实例、输入输出、已知与未知效果及新旧执行关系（第 3 节）。
- 维护唯一的 FIFO 执行队列，按 `createAttempt` 的调用顺序串行推进；前一个尝试提交结果检查后才启动下一个。
- 解析 Unit 输入中的 ArtifactRef 并检查归属（第 4 节）；构建 `ExecutionRequest`（第 7 节），登记待发送给 Supervisor。
- 产物只由 Execution 写入 ArtifactStore：执行产物、Workflow 经 `report-publish` 提交的最终报告、RunSummary。
- 执行内建 Unit `report-publish`（第 5 节）。
- 处理执行事实：技术重试（第 6 节）、写入产物、隔离违规输出，再提交结果检查；UnitReport 由 Core 交付，Execution 不直接向 Workflow 发送。
- 维护上下文构建记录（第 8 节），提供运行统计与未知效果（第 9 节）。

非 API 工作并发执行只作为后续演进方向，不纳入 M1。

## 3. UnitAttempt 与 FIFO

| 字段 | 含义 |
|---|---|
| `unitAttemptId` | 本次尝试 |
| `requestId`、`agentRunId`、`unitRef`、`executionKind` | 来自被受理的 submitUnit |
| `runEpoch` | 建立时的 runEpoch |
| `state` | 见下 |
| `executions[]` | 每次派发的 `executionId`、`notBefore`、`dispatchedAt`、结果 `outcome`、`requestState` |
| `retryCount` | 已进行的技术重试次数 |
| `reservationId`、`grantId` | MODEL 当前持有的预留与调用机会 |
| `outputRef` | 写入的产物 |

```text
QUEUED → STARTING → DISPATCHED ─┬→ CHECKED（已提交结果检查）
   │         │                   └→ DISPATCHED（技术重试，新的 executionId）
   │         └→ CHECKED（派发前结束：引用无效、预留被拒、内建 Unit 完成）
   └→ ABORTED（收敛时被清出 FIFO，不交付 UnitReport）
```

## 4. 产物归属与解析

Execution 为每个写入的产物登记归属：`artifactId → { producer: unitAttemptId 或 'RUN_SUMMARY', mediaType, sha256, size }`，
按运行保存在 Execution 状态分块中。`artifactId = 'art_' + sha256`，同一运行内相同内容得到同一个引用。

```text
需要解析的引用（ContextAssembleInput.orientPackRef、ToolResultStep.outputRef、ModelCallInput.contextPackRef、
                 ReadArtifactRequest.ref、CloseRunRequest.reportRef）
  → 归属索引中存在，且 mediaType、sha256、size 与登记一致 → 经 ArtifactStorePort.get 读取（复验 sha256 与 size）
  → 否则 → INVALID_ARTIFACT_REF，不说明是不存在还是不属于本运行
```

- Executor 只接收 Execution 解析后的内容，不持有 ArtifactStore 句柄。
- context-assemble 的 Agent 指令与工具说明由 Execution 从 `AttemptSpec.pinned` 解析，不经 ArtifactRef 传递。
- UserInteraction 的“读取产物”与 `closeRun` 的 `reportRef` 由 Core 调用 `readArtifact`、`ownsArtifact` 按同一规则检查。

## 5. 内建 Unit：report-publish

`report-publish` 不派发给 Supervisor，由 Execution 在运行 actor 的处理中完成：

```text
取到队首的 report-publish 尝试
  → input.report 已在受理时按 kernel.unit.ReportPublishInput 校验（Interaction 5.1）
  → 规范 JSON 序列化；超过 KernelConfig.maxReportBytes → submitResultCheck(REJECTED, LIMIT_EXCEEDED)
  → ArtifactStorePort.put(workflowRunId, 内容, 'application/vnd.multiagentos.analysis-report+json')
  → 登记归属
  → submitResultCheck(COMPLETED, output = { conclusionCount, unconfirmedCount, degraded }, outputRef = reportRef)
```

Execution 不判断报告内容是否合格；报告的来源核验由 Workflow 在提交前完成。

## 6. 技术重试

技术重试对 Workflow 不可见，不计 Round；每个尝试最多 `technicalRetryLimit` 次（3）。

- 只有 `outcome = FAILED` 且 `retryable = true` 的执行事实可以重试。MODEL 还要求 `requestState = NOT_SENT`，
  请求可能已发出时不重试，避免同一次调用的未知消耗被多次计入。
- 每次重试都先调用 `CoreSyscalls.retryExecution`。Core 检查运行仍为 RUNNING、次数未超限、MODEL 的请求未发出；
  MODEL 时 Core 先以 `NOT_SENT` 结算旧预留并释放旧调用机会，再重新申请（见 [Core](Core.md) 5.1）。
- 允许时 Execution 生成新的 `executionId`，以 `notBefore = 当前时间 + retryBackoffBaseMs × 2^(retryCount − 1)` 重新派发。
- 不允许时，以最后一次执行事实提交结果检查；额度类拒绝由 Core 直接交付 UnitReport，尝试结束。

## 7. 构建 ExecutionRequest

| executionKind | `input` | `scope` | `limits` |
|---|---|---|---|
| `REPOSITORY_ORIENT` | `{ objective, tokenBudget: budget.orientBudget }` | `REPOSITORY` | `maxFiles = maxSnapshotFiles` |
| `REPOSITORY_SEARCH` | 填入缺省值的查询，`tokenBudget: budget.searchBudget` | `REPOSITORY` | — |
| `FILE_READ` | Unit 输入原样 | `REPOSITORY` | — |
| `CONTEXT_ASSEMBLE` | 见下 | `NONE` | — |
| `MODEL` | `{ contextPack: 解析后的 ASSEMBLE 包, final }` | `MODEL` | `maxOutputTokens = final ? finalMaxOutputTokens : maxOutputTokens` |

- 每种执行的 `deadline = (notBefore ?? 派发时间) + executionLimits[kind].timeoutMs`，`maxOutputBytes = executionLimits[kind].maxOutputBytes`。
- `scope` 由 Core 在 `AttemptSpec` 中给出，Execution 不修改。
- CONTEXT_ASSEMBLE 的输入：`instructions` 为固定 Prompt 的正文；`toolSpecs` 在 `final = false` 时为该 Agent 全部 UNIT 工具、
  finish 控制工具与（存在时）handoff 控制工具，在 `final = true` 时只有 finish 控制工具；每个工具的 `parameters` 由 Protocol Registry
  把 `parametersContract` 转为 JSON Schema；`tokenBudget` 为 `final ? finalInputBudget : perCallInputLimit`；
  `orientPack` 与 `history` 中的正文由第 4 节解析。
- MODEL 在派发前计算 `est = estimateTokens(contextPack) + maxOutputTokens`，调用 `requestReservation`；被拒时尝试结束。

## 8. 上下文构建记录

Execution 为每个 ContextPack 记录 `contextPackId`、`operation`、`unitAttemptId`、`artifactId`、`snapshotId`、`tokenCount`、
`truncated`、`droppedCount`，作为检索台账与来源关联。记录只在 Execution 状态分块中，不跨运行共享。

## 9. 统计与未知效果

- `unitStatistics()` 返回 RunSummary 的 `units` 字段，以及派发给 Supervisor 的 MODEL 执行实例数（`model.requests`，含技术重试）。
- `collectUnknownEffects()` 返回：未完成且 `requestState = UNKNOWN` 的 MODEL 执行（`MODEL_REQUEST_UNCONFIRMED`），
  以及全部 STOP_UNCONFIRMED 的执行（`EXECUTION_STOP_UNCONFIRMED`，包括 Core 在收敛兜底时判定的执行）。
- `publishRunSummary(summary)` 把 RunSummary 以 `application/vnd.multiagentos.run-summary+json` 写入 ArtifactStore，登记归属
  （`producer = 'RUN_SUMMARY'`），返回引用。
- 收到违规事实时隔离该次输出：不写入产物，不交付。运行已不为 RUNNING（尝试的 runEpoch 不等于当前值）时不写入任何产物。

## 10. 配置

| 配置 | 读取者 | 建议初值 |
|---|---|---|
| `KernelConfig.technicalRetryLimit` | Execution、Core | 3 |
| `KernelConfig.retryBackoffBaseMs` | Execution | 1000 |
| `KernelConfig.maxSnapshotFiles` | Execution | 20000 |
| `KernelConfig.maxReportBytes` | Execution | 262144 |
| `KernelConfig.executionLimits` | Execution | 见 [Interaction](Interaction.md) 第 9 节 |
| `KernelConfig.budget` | Execution | 见 [Monitor](Monitor.md) 第 4 节 |
