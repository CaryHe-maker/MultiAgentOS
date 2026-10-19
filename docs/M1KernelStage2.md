# MultiAgentOS M1 Kernel 阶段二工作文档

> 状态：临时工作文档，2026-10-19 制定规划；2.1–2.3 已完成，2.4–2.6 未开始。
> 依据：[M1-kernel-infra-plan](M1-kernel-infra-plan.md) 第 6.3 节与 `docs/M1/` 下的 M1 规范。
> 本文件不是规范，不进入 `feature/M1/main`；与 `docs/M1/` 冲突时以规范为准。
> 本文件记录阶段二（2.1–2.6）的目标、工作子阶段、退出条件、风险与提交约定。

## 1. 基线

当前 HEAD 为 `4e70e70`（阶段一两个代码提交与计划状态同步）。2.1–2.3 的代码已在该基线上完成，
尚未提交；工作树还包含本工作文档与一个与阶段二无关的 `.gitignore` 修改。

阶段一已完成并验收：

- `9f7c9f2`：Kernel Core 阶段 1.1–1.3 控制逻辑。
- `1fec492`：Kernel Core 阶段 1.4–1.6 与阶段一实现报告。

阶段一报告见 [M1KernelStage1](M1KernelStage1.md)。阶段一交付了 Core 的运行管理、外部 syscall、
AgentRun、授权与 Lease、CoreSyscalls、预留与结算、结果检查、收敛、非停机异常与审计；
Execution 的阶段 2.1 骨架、2.2 产物/报告发布与 2.3 请求构造已实现；run actor、真实 Supervisor 与
`createKernelCore` 尚未实现。

阶段二从本基线开始，只修改 `packages/modules/kernel` 内的 Execution 及其必要的 Core
集成修正；共享接缝变更须单独评审。

## 2. 目标与边界

### 2.1 目标

按 [M1-kernel-infra-plan](M1-kernel-infra-plan.md) 第 6.3 节完成 Execution、Scheduler 与 Monitor
的真实接入：

- 实现 `ExecutionDuties` / `CoreExecutionPort` 背后的 Execution。
- UnitAttempt 创建、幂等、唯一 FIFO、状态机与执行历史。
- 五类 Executor 请求构造与 ArtifactRef 解析。
- 产物写入、归属登记、内建 `report-publish` 与 RunSummary 发布。
- 执行事实处理、技术重试、退避、取消、停止未确认与未知效果。
- 通过真实 `CoreAttempts` 使用真实 Monitor 与 Scheduler，验证预算、预留、结算、调用机会与收尾。
- 以测试替身 Supervisor 驱动纵向链，完成阶段二测试矩阵与实现报告。

### 2.2 不包含

- run actor、双通道 Inbox、OrderedSender、真实 Outbox：阶段四。
- Supervisor 的真实 `execute` / `cancelRun`：阶段三。
- `createKernelCore` 装配与真实启动：阶段四、六。
- 真实模型 E2E、Workflow/UI 联调、F1–F5：M1 整机验收。
- 基础设施故障矩阵：阶段五。
- 修改 `packages/libraries/contracts`、`packages/testing` 或工厂签名：阶段二预期不需要；
  确需修改时按 M1Plan 第 4.1 节单独协调。

### 2.3 验收形态

```text
CoreRequestHandler / CoreAttempts
  + Execution（真实）
  + Monitor（真实）
  + Scheduler + InProcessProviderCapacity（真实）
  + LocalArtifactStore（真实）
  + Fake Supervisor / Fake Catalog（测试替身）
```

测试可以驱动 `submitUnit`、检查构造出的 `ExecutionRequest`、手工回送 `ExecutionFact`。
测试替身不得进入产品入口，也不代表阶段三、阶段四或整机 M1 已完成。

## 3. 数据流与关键约束

```text
Workflow submitUnit
  → CoreAttempts.startAttempt
  → Execution.createAttempt
      → core.registerAttempt
      → 建立 UnitAttempt，进入 FIFO
      → 解析输入 ArtifactRef、构造 ExecutionRequest
      → core.registerExecution
      → SupervisorPort.execute（阶段二为 fake）
  → ExecutionFact 回到 Execution.handleExecutionFact
      → 产物写入 ArtifactStore、登记归属
      → core.submitResultCheck
      → Core 结算、释放调用机会、形成 UnitReport
  → 下一 FIFO 尝试
```

关键约束：

- Execution 不直接调用 Monitor 或 Scheduler，只经 `CoreSyscalls`。
- Execution 不向 Workflow 或 UserInteraction 发事件，结果只经 Core 的 `submitResultCheck`。
- Execution 不解释 FINISH/HANDOFF，也不决定 Round；这些属于 Workflow。
- Execution 不直接运行 Executor；执行由 Supervisor 派发。
- 只有 Execution 写正式 ArtifactStore；Executor、Workflow 与 UserInteraction 不直接写入。
- 运行状态、Lease、账本、Outbox、Inbox 仍只在内存中；阶段二不实现持久化运行状态。

## 4. 子阶段总览

| 子阶段 | 主题 | 主要交付 | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| 2.1 | Execution 骨架与 Attempt/FIFO | Execution facade、UnitAttempt、FIFO、状态机、幂等创建、`abortQueued` | 阶段一 CoreAttempts | 已完成（2026-10-19） |
| 2.2 | 产物归属与内建 Unit | 归属索引、`ownsArtifact`/`readArtifact`、`report-publish`、`publishRunSummary` | 2.1、ArtifactStore | 已完成（2026-10-19） |
| 2.3 | 执行请求与上下文/模型输入 | 五类 `ExecutionRequest`、ArtifactRef 解析、Assemble/Model 输入、估算与预留 | 2.1、2.2 | 已完成（2026-10-19） |
| 2.4 | 执行事实、重试与收敛副作用 | `handleExecutionFact`、技术重试、退避、取消、`STOP_UNCONFIRMED`、未知效果 | 2.2、2.3 | 未开始 |
| 2.5 | 预算与容量集成 | 真实 Monitor/Scheduler 接通、final reserve、回滚、释放、`finalize`、异常审计 | 2.3、2.4 | 未开始 |
| 2.6 | 阶段二整链验证与报告 | 纵向链 harness、测试矩阵、覆盖率、阶段报告、计划状态更新 | 2.1–2.5 | 未开始 |

建议顺序：2.1 → 2.2 → 2.3 → 2.4 → 2.5 → 2.6。
2.2 可以在 2.1 骨架稳定后立即开始；2.5 的边界测试可在 2.4 实现过程中并行准备。

## 5. 子阶段详情

### 5.1 阶段 2.1：Execution 骨架与 Attempt/FIFO

**状态：已完成（2026-10-19）。** 实现与测试证据见本节末尾的完成记录。

**目标**

让 Execution 成为真实的 `ExecutionDuties` 实现，先把尝试生命周期与串行队列做对，
再接入请求构造与执行事实。

**主要工作**

- 在 `packages/modules/kernel/src/execution/` 下建立内部结构；建议按职责拆分为
  attempt、queue、index 与测试文件，实际文件名以实现为准。
- `createAttempt(spec)`：
  - 生成 `unitAttemptId`（`una_` + ULID）。
  - 以 `requestId` 幂等：同一请求返回同一 attempt；不同 spec 视为内部错误，不创建第二次尝试。
  - 先调用 `core.registerAttempt`，再入队；保证 Core 在首次预留或结果检查前已有登记。
  - 记录 `requestId`、`agentRunId`、`unitRef`、`executionKind`、`runEpoch`、`state`、
    `executions[]`、`retryCount` 与 `outputRef`。
- FIFO：
  - 同一时刻只允许一个尝试处于 `STARTING` 或 `DISPATCHED`。
  - 前一个尝试提交结果检查后才取下一个队首。
  - 内部 syscall 返回后若 `core.currentRunEpoch()` 已变，不再取下一个队首。
- 状态机：

```text
QUEUED → STARTING → DISPATCHED → CHECKED
QUEUED / STARTING → ABORTED
DISPATCHED → DISPATCHED（技术重试，新的 executionId）
```

- `abortQueued()`：
  - 清空未启动队列，标记 `ABORTED`。
  - 返回当前在途 `{ unitAttemptId, executionId }[]`，供 Core 登记 `SupervisorPort.cancelRun`。
  - 不替未启动尝试生成 `UnitReport`。
- `synthesizeStopUnconfirmed`、`collectUnknownEffects` 与 `modelRequestCount` 已实现基础版本；
  `handleExecutionFact` 在 2.1 处理非 `COMPLETED` 事实，`COMPLETED` 的产物写入与完整结果路径在 2.2/2.4 完成。

**测试**

- 同一 `requestId` 重复创建返回同一 attempt。
- 多个 Unit 按 `createAttempt` 顺序执行，不并发。
- 前一个未提交结果检查时，后一个不启动。
- `runEpoch` 变化后不再取队首。
- `abortQueued` 清空排队、保留在途、状态正确。
- 非法状态转换被拒绝或忽略。

**退出条件**

- Execution 已导出并实现 `ExecutionDuties` 的基础方法。
- FIFO、幂等、状态机与 abort 测试全部通过。
- 产品路径中不存在“成功返回但未做任何事”的占位分支。

**完成记录（2026-10-19）**

实现文件：

```text
packages/modules/kernel/src/execution/attempt.ts
packages/modules/kernel/src/execution/queue.ts
packages/modules/kernel/src/execution/dispatcher.ts
packages/modules/kernel/src/execution/index.ts
packages/modules/kernel/src/execution/execution.test.ts
```

已完成：

- `Execution` 实现 `ExecutionDuties` 的骨架；`createAttempt` 先 `registerAttempt` 再入队。
- `AttemptQueue` 提供唯一 FIFO；同一时刻只启动一个尝试，结果检查后才推进。
- `runEpoch` 变化后拒绝启动旧尝试。
- `abortQueued` 清空排队并返回在途执行。
- `handleExecutionFact` 的非 `COMPLETED` 路径、`synthesizeStopUnconfirmed`、
  `collectUnknownEffects` 与 `modelRequestCount` 已有基础实现。
- 派发失败转换为 `FAILED(INTERNAL)` 结果检查，避免未处理的派发异常。

验证：

```text
pnpm run check
  45 个测试文件、445 项测试通过
pnpm run test:coverage
  全仓语句 92.28%、分支 82.76%、函数 88.61%、行 94.21%
  execution：语句 72.41%、分支 61.76%、函数 65.51%、行 77.50%
```

边界：

- `COMPLETED` 产物写入、`ownsArtifact` / `readArtifact` 与 `publishRunSummary` 留到 2.2/2.4。
- 2.1 代码尚未提交；`.gitignore` 的 `opencode.json` 修改与本阶段无关。
- execution 覆盖率在 2.2–2.4 补齐后随阶段报告一并复核。

### 5.2 阶段 2.2：产物归属、内建 report-publish 与 RunSummary

**状态：已完成（2026-10-19）。** 实现与测试证据见本节末尾的完成记录。

**目标**

建立 Execution 对 Artifact 的唯一写入与归属权威，完成报告发布与 RunSummary 发布。

**主要工作**

- 产物归属索引，按运行保存在 Execution 状态中：

```text
(artifactId, mediaType)
  → { sha256, size, producers: (unitAttemptId | 'RUN_SUMMARY')[] }
```

- 写入：
  - 只通过 `ArtifactStorePort.put` 写入。
  - 同一运行内相同内容得到同一 `artifactId`。
  - 不同尝试写入相同内容时追加 `producers`，不覆盖已有登记。
  - 写入失败或完整性校验失败时，不登记归属。
- 读取与解析：
  - `ownsArtifact(ref)`：检查 `(artifactId, mediaType)`、`sha256` 与 `size`。
  - `readArtifact(ref)`：归属通过后调用 `ArtifactStorePort.get`，复验后返回 UTF-8 文本；
    失败返回 `{ ok: false }`。
  - `resolveArtifact(ref)`：供输入解析使用，失败统一映射为 `INVALID_ARTIFACT_REF`，
    不区分“不存在”和“不属于本运行”。
  - 只解析规范允许的位置：`ContextAssembleInput.orientPackRef`、
    `ToolResultStep.outputRef` 与 `ModelCallInput.contextPackRef`。
- 内建 `report-publish`：
  - 不派发给 Supervisor。
  - `ReportPublishInput.report` 已由 Core 按 `inputContract` 校验；Execution 再做规范 JSON 序列化。
  - 超过 `KernelConfig.maxReportBytes` → `submitResultCheck(NOT_DISPATCHED, REJECTED, LIMIT_EXCEEDED)`。
  - `ArtifactStorePort.put(..., ANALYSIS_REPORT_MEDIA_TYPE)`；登记归属（producer = unitAttemptId）。
  - `submitResultCheck(COMPLETED, output = { conclusionCount, unconfirmedCount, degraded },
    outputRef = reportRef)`。
  - ArtifactStore 写入或完整性失败 → `FAILED(INTERNAL, retryable = false)` 或既有受控错误路径；
    不得伪造 reportRef。
- `publishRunSummary(summary)`：
  - 规范 JSON 序列化，mediaType 为 RunSummary。
  - 写入并登记，producer 为 `'RUN_SUMMARY'`。
  - 这是收敛第③步的明确例外：运行已不处于 RUNNING 时仍允许发布 RunSummary。
- 不判断报告内容是否合格；来源核验属于 Workflow。

**测试**

- 相同内容重复写入得到同一引用；不同 producers 追加。
- 不同 mediaType、错误 sha256/size、缺失或损坏内容被拒绝。
- `ownsArtifact` 只认本运行且字段一致的引用。
- `readArtifact` 正常、缺失、损坏、非本运行。
- `report-publish` 正常、超限、写入失败与输出计数。
- `publishRunSummary` 正常写入；失败时由 Core 形成 `finalizationError`。
- Fake Supervisor 不收到 `REPORT_PUBLISH` 请求。

**退出条件**

- Execution 是唯一写 Artifact 的组件。
- 报告与 RunSummary 均可发布并可读取。
- 产物归属、媒体类型与完整性检查测试通过。

**完成记录（2026-10-19）**

实现文件：

```text
packages/modules/kernel/src/execution/artifact-ownership.ts
packages/modules/kernel/src/execution/artifact-ownership.test.ts
packages/modules/kernel/src/execution/index.ts
packages/modules/kernel/src/execution/execution.test.ts
```

已完成：

- `ArtifactOwnership` 以 `(artifactId, mediaType)` 为键登记产物，记录多个 producer；
  同一身份出现不同 `sha256` 或 `size` 时拒绝登记。
- `ownsArtifact` 先检查本运行归属；`readArtifact` 在归属通过后经 `ArtifactStorePort.get`
  读取，并复验内容。
- `report-publish` 作为内建 Unit 在 FIFO 中直接执行，不派发给 Supervisor：
  - 校验 `ReportPublishInput`；
  - 规范 JSON 序列化；
  - 超过 `maxReportBytes` 返回 `REJECTED(LIMIT_EXCEEDED)`；
  - 写入 ArtifactStore、登记归属并返回 `reportRef`；
  - 成功时返回 `ReportPublishOutput`，写入失败转换为 `FAILED(INTERNAL)`。
- `publishRunSummary` 以规范 JSON 写入 RunSummary 媒体类型，登记 producer 为 `'RUN_SUMMARY'`，
  允许在运行不再是 RUNNING 时调用。
- Execution 新增 `workflowRunId`、`artifacts` 与 `maxReportBytes` 依赖；构造时校验报告上限。

验证：

```text
pnpm run check
  46 个测试文件、457 项测试通过
pnpm run test:coverage
  全仓语句 92.42%、分支 82.87%、函数 88.91%、行 94.41%
  execution：语句 80.72%、分支 67.96%、函数 80.00%、行 86.06%
```

边界：

- `COMPLETED` 执行事实的产物写入仍留在 2.4；2.3 负责请求构造。
- 2.2 使用测试 ArtifactStore 验证归属、读写与失败路径；真实 ArtifactStore 故障矩阵仍属阶段五。
- 2.2 代码尚未提交；execution 覆盖率随 2.3–2.4 继续提升。

### 5.3 阶段 2.3：执行请求构造与上下文/模型输入

**状态：已完成（2026-10-19）。** 实现与测试证据见本节末尾的完成记录。

**目标**

把 `AttemptSpec` 转换成合法的 `ExecutionRequest`，覆盖五类 Executor，并完成输入解析、
上下文组装输入、模型估算与预算申请。

**主要工作**

- 五类 `ExecutionRequest` 构造：

| executionKind | input | scope | limits |
| --- | --- | --- | --- |
| `REPOSITORY_ORIENT` | `{ objective, tokenBudget: orientBudget }` | `REPOSITORY` | `maxFiles = maxSnapshotFiles` |
| `REPOSITORY_SEARCH` | `{ query, mode 默认 AUTO, maxItems 默认 20, tokenBudget: searchBudget }` | `REPOSITORY` | — |
| `FILE_READ` | Unit 输入原样 | `REPOSITORY` | — |
| `CONTEXT_ASSEMBLE` | `AssembleExecutorInput` | `NONE` | — |
| `MODEL` | `{ contextPack, final }` | `MODEL` | `maxOutputTokens` |

- `deadline = (notBefore ?? 派发时间) + executionLimits[kind].timeoutMs`；
  `maxOutputBytes` 取配置。
- `scope` 直接使用 Core 在 `AttemptSpec` 中给出的派生值，不修改。
- `CONTEXT_ASSEMBLE`：
  - `instructions` 来自固定的 Prompt 正文。
  - `toolSpecs`：
    - 普通调用：该 Agent 全部 UNIT 工具、finish 控制工具与（存在时）handoff 控制工具。
    - final：只有 finish 控制工具。
    - 参数由 Protocol Registry 从 `parametersContract` 生成 JSON Schema。
  - `orientPack` 从 `orientPackRef` 解析。
  - `history` 为 `StepRecord[]`；`TOOL_RESULT` 的 `outputRef` 解析为 `outputText`，
    只对 `status = OK` 的 `TOOL_RESULT` 提供正文。
  - `handoff` 与 `status` 原样传递，不解释 Round/final 业务语义。
  - `tokenBudget = final ? finalInputBudget : perCallInputLimit`。
- `MODEL`：
  - 解析 `contextPackRef` 为 ASSEMBLE 包。
  - 核对 `operation = ASSEMBLE` 且 `tokenBudget = final ? finalInputBudget : perCallInputLimit`；
    不一致 → `NOT_DISPATCHED, INVALID_INPUT`。
  - `est = estimatePackTokens(contextPack) + maxOutputTokens`，不采信 Executor 报告的 `tokenCount`。
  - 做模型窗口一致性检查，见第 6 节。
  - 调用 `core.requestReservation({ unitAttemptId, estimatedTokens: est, final })`。
  - 被拒 → 按 Core 已交付的 `BUDGET_*` 或 `FINAL_CALL_USED` 结束尝试，不再派发。
- 派发：
  - 生成 `executionId`，记录 `executions[]`。
  - 先 `core.registerExecution`，再构造并校验 `ExecutionRequest`，最后登记 `SupervisorPort.execute`。
  - 不直接调用 Executor。
- 输入 ArtifactRef 无效 → `NOT_DISPATCHED, INVALID_ARTIFACT_REF`。
- 不解释 FINISH/HANDOFF；不实现 Workflow 的 Round、Validation 或 `failurePolicy`。

**测试**

- 五类请求逐字段构造，全部通过 `ExecutionRequestSchema`。
- ORIENT/SEARCH 的默认值与 tokenBudget。
- FILE_READ 输入透传。
- CONTEXT_ASSEMBLE 的段输入、工具集、final 工具裁剪、handoff 与 history 解析。
- MODEL 的 final 一致性、估算包含输出、预留成功或拒绝、`FINAL_CALL_USED`。
- ArtifactRef 无效、ContextPack 类型错误、ASSEMBLE 包不匹配。
- `registerExecution` 必须先于 `SupervisorPort.execute`。

**退出条件**

- 五类请求可被构造并被 Schema 校验。
- 所有输入解析位置与规范一致。
- 预算拒绝路径不会派发执行。
- Fake Supervisor 收到的请求与 M1Interface 第 7 节一致。

**完成记录（2026-10-19）**

实现文件：

```text
packages/modules/kernel/src/execution/request-builder.ts
packages/modules/kernel/src/execution/dispatcher.ts
packages/modules/kernel/src/execution/index.ts
packages/modules/kernel/src/execution/execution.test.ts
```

已完成：

- 新增 `ExecutionRequestBuilder`，构造五类 `ExecutionRequest`：
  - ORIENT、SEARCH、FILE_READ 的输入、scope 与 limits；
  - CONTEXT_ASSEMBLE 的 instructions、toolSpecs、orientPack、history、status 与 tokenBudget；
  - MODEL 的 ASSEMBLE ContextPack、final、输入预算与输出上限。
- 只解析规范允许的三个 ArtifactRef 位置：`orientPackRef`、`StepRecord.outputRef`
  与 `model-call` 的 `contextPackRef`。
- toolSpecs 来自固定定义集合：普通调用包含 Unit 工具、finish 与 handoff；final 只包含 finish。
- `history` 只对 `status = OK` 的 `TOOL_RESULT` 解析 `outputText`。
- MODEL 在派发前核对 ContextPack 的 `operation` 与 `tokenBudget`，重新计算
  `estimatePackTokens + maxOutputTokens`，并复核模型窗口。
- MODEL 经 `requestReservation` 成功后派发；被拒绝时结束尝试，不产生 Supervisor 请求。
- `AttemptDispatcher` 改为接收已构造的 `ExecutionRequest`；`registerExecution` 仍在派发前。
- `ExecutionDeps` 增加 `config`、`registry` 与可选 `ownership`，移除单独的 `maxReportBytes`。
- 请求构造失败按原因码返回受控结果：`INVALID_INPUT`、`INVALID_ARTIFACT_REF`、`LIMIT_EXCEEDED`；
  未知内部错误返回 `FAILED(INTERNAL)`。

验证：

```text
pnpm run check
  46 个测试文件、469 项测试通过
pnpm run test:coverage
  全仓语句 92.21%、分支 82.69%、函数 89.07%、行 94.33%
  execution：语句 82.29%、分支 72.14%、函数 86.53%、行 88.53%
  request-builder：语句 87.87%、分支 81.69%、函数 100.00%、行 96.51%
```

边界：

- `COMPLETED` 执行事实的产物写入与完整结果路径仍属 2.4。
- 技术重试、退避、取消在途事实与 STOP_UNCONFIRMED 的完整处理仍属 2.4。
- 2.3 使用测试 ArtifactStore 与伪 Supervisor；真实 Supervisor 属阶段三，真实故障矩阵属阶段五。
- 2.3 代码尚未提交；execution 覆盖率随 2.4 继续提升。

### 5.4 阶段 2.4：执行事实、技术重试与收敛副作用

**目标**

完成 Execution 对 `ExecutionFact` 的处理、技术重试、取消、停止未确认与未知效果，
确保收敛期间不产生新交付。

**主要工作**

- `handleExecutionFact(fact)`：
  - 按 `workflowRunId`、`unitAttemptId` 与 `executionId` 找到当前 execution。
  - 未知、重复或已结束的 execution 事实丢弃，不产生第二次结果检查。
  - 校验 `executionKind`、`runEpoch` 与请求一致。
- `COMPLETED`：
  - `result.artifact` 写入 ArtifactStore，登记归属，得到 `outputRef`。
  - `submitResultCheck(COMPLETED, output, outputRef, usage)`。
  - 运行已不处于 RUNNING 或尝试 epoch 过期时，结算但不交付；不写新的执行产物。
    旧 epoch `COMPLETED` 的 `outputRef` 矛盾见第 6 节。
- `REJECTED` / `FAILED` / `TERMINATED`：
  - 不写产物。
  - 原样携带 reasonCode、usage 与 requestState。
  - `FAILED && retryable` 进入技术重试。
- 技术重试：
  - 仅 `FAILED && retryable`；MODEL 还要求 `requestState = NOT_SENT`。
  - 调用 `core.retryExecution({ unitAttemptId, previousExecutionId, requestState })`。
  - 允许：生成新 `executionId`，记录历史，
    `notBefore = now + retryBackoffBaseMs × 2^(retryCount−1)`，重新 `registerExecution` 并派发。
  - 不允许：以最后一次执行事实提交结果检查；`RUN_CONVERGING` 不再重试。
  - 重试对 Workflow 不可见，不计 Round。
- 取消与收敛：
  - `abortQueued` 已在 2.1；2.4 负责在途事实的处理。
  - 收敛中不重试、不写新执行产物、不生成 AnalysisReport；只结算与记录。
  - `synthesizeStopUnconfirmed(executionIds)`：为指定 execution 生成
    `STOP_UNCONFIRMED` 结果检查，`stopVerdictBy: 'CORE'`；不写产物。
  - `collectUnknownEffects()`：
    - 未完成且 `requestState = UNKNOWN` 的 MODEL → `MODEL_REQUEST_UNCONFIRMED`。
    - 全部 `STOP_UNCONFIRMED`（含 Core 判定）→ `EXECUTION_STOP_UNCONFIRMED`。
  - `modelRequestCount()`：已派发给 Supervisor 的 MODEL 执行实例数，包含技术重试。
- 旧 execution 不得覆盖新 execution 的结果；每个 execution 只接受一个终态。

**测试**

- COMPLETED 正常写入产物并交付；REJECTED/FAILED/TERMINATED 不写产物。
- MODEL 的 `requestState` 与 usage 组合。
- 重试：可重试、不可重试、超限、MODEL 已发送、退避时间、新 executionId、旧结果不覆盖。
- 收敛中：不重试、不写产物、只结算；`notDelivered` 计数正确。
- `abortQueued`、在途事实、`synthesizeStopUnconfirmed` 与未知效果。
- 重复或迟到事实只处理一次。
- `modelRequestCount` 包含重试。

**退出条件**

- 全结果矩阵测试通过。
- 重试、取消、停止未确认与旧 epoch 行为符合 Interaction 5.4 与 Execution 第 6、9 节。
- 收敛期间不产生新的业务交付。

### 5.5 阶段 2.5：预算与容量集成

**目标**

用真实 Monitor 与 Scheduler 验证 Execution 经 `CoreSyscalls` 的预算与容量行为，
关闭阶段一中“Monitor/Scheduler 已实现但未接入真实请求”的缺口。

**主要工作**

- 确认 Execution 只调用 `requestReservation` 与 `retryExecution`，不直接引用 Monitor 或 Scheduler。
- 预算：
  - 普通 model-call 与 final-call 的预留。
  - `NORMAL → WRAP_UP → EXHAUSTED` 单调推进。
  - `finalReserve` 只供 final-call 使用。
  - `FINAL_CALL_USED` 每运行至多一次；技术重试不重复占用 final-call。
  - 预留拒绝：释放调用机会，不扣 token，不派发。
  - 结算：ACTUAL、NOT_SENT 与 UNKNOWN；实际用量超估算、重复结算冲突的
    `SettlementResult.anomalies` 由 Core 审计。
  - `finalize()` 把未结算预留按未知消耗结算。
- 容量：
  - 组合使用同一个 `InProcessProviderCapacity` 实例。
  - `acquire` 与 `release` 配对；Monitor 拒绝时立即释放；结果检查、技术重试、收敛与
    `releaseAll` 各释放点正确。
  - `STOP_UNCONFIRMED` 不提前释放机会，保留到最终清理。
  - `stopGranting` 后不再发放新机会。
  - 两个 Scheduler 实例共享容量，验证跨运行约束。
- `modelRequestCount` 与 `RunSummary.model.requests` 一致，包含重试。
- 取消或失败不按零费用处理。

**测试**

- 预算状态边界：刚好 NORMAL、进入 WRAP_UP、EXHAUSTED、final reserve 隔离。
- 普通与收尾预留成功或拒绝；final-call 第二次。
- 结算三种类型；超估算与重复结算 anomalies。
- 调用机会在拒绝、结果检查、重试、取消与收尾各路径的释放。
- `finalize` 后的未知消耗与 `BudgetSummary`。
- 共享容量下两个 Scheduler 实例互斥。

**退出条件**

- 真实 Monitor 与 Scheduler 经 Execution 路径工作。
- 预算与容量测试覆盖计划 6.3 的“覆盖重试和收尾”。
- 不新增 Execution → Monitor/Scheduler 的直接依赖。

### 5.6 阶段 2.6：阶段二整链验证与报告

**目标**

把 2.1–2.5 的组件串成阶段二纵向链，形成可复现证据，并为阶段三、四留下清晰接缝。

**主要工作**

- 建立阶段二 test harness：
  - 真实 `CoreRequestHandler`、`CoreAttempts`、Execution、Monitor、Scheduler 与 `LocalArtifactStore`。
  - Fake Supervisor：记录 `ExecutionRequest`，按测试需要回送 `ExecutionFact`。
  - Fake Catalog 或固定定义：提供五类 Unit 的 pinned definitions。
  - 临时 `dataDir` 与清理。
- 纵向用例：
  - 一次 `submitUnit` → attempt → 请求 → fake fact → 产物 → 结果检查 → UnitReport。
  - 多 Unit FIFO。
  - 普通 model-call、final-call、预算拒绝与 Execution 侧结果交付。
  - 重试与退避。
  - 取消与收敛：`abortQueued`、在途事实、`STOP_UNCONFIRMED`、未知效果与 `notDelivered`。
  - 报告发布与 RunSummary。
  - 旧 epoch 与迟到事实。
- 质量门：
  - `pnpm run build`
  - `pnpm run check`
  - `pnpm run test:coverage`
  - `git diff --check`
  - `pnpm run demo:fake`（装配链路不回归）
- 编写 `docs/M1KernelStage2.md` 的阶段报告部分：
  - 验收结论、范围、代码结构、实现内容。
  - 测试矩阵、覆盖率、边界与遗留。
  - 明确阶段二不包含 Supervisor、run actor、`createKernelCore` 与真实模型。
- 更新 `docs/M1-kernel-infra-plan.md`：
  - 阶段二标记完成。
  - 2.2 实现状态、6.9 预留表、6.10 证据与 11 进度记录同步。
  - 不提前标记阶段三至六。

**退出条件**

- 计划 6.3 的全部实现项与验证项有对应测试。
- 阶段二纵向链在 fake Supervisor 下完整通过。
- Execution 产品路径无占位实现。
- 质量门通过，覆盖率与测试矩阵记录。
- 阶段报告与计划状态同步。

## 6. 关键设计点与风险

### 6.1 旧 epoch COMPLETED 的结算与交付矛盾

阶段一的 `CoreAttempts.submitResultCheck` 对 `COMPLETED` 要求 `output` 与 `outputRef`，
但 [Execution](../M1/Kernel/Execution.md) 第 9 节规定运行不再是 RUNNING 时不写新的执行产物。

这会造成：

- Execution 不写产物 → 没有 `outputRef`；
- Core 仍要求 `outputRef` → 无法完成结算；
- 若 Execution 写产物 → 违反“不写新的执行产物”。

建议在 2.4 采用以下方案，并形成测试：

- **推荐**：调整 Core 的 `submitResultCheck` 顺序，先判断交付资格；对不可交付的 `COMPLETED`
  只结算、计数 `notDelivered`、审计，不要求 `outputRef`，不构造 `UnitReport`。
- 备选：明确允许“收敛中仍写产物，只是不交付”，并同步修改 Execution 文档与阶段一测试。

该改动只涉及 Kernel 内部行为，不改公共 Schema；应在阶段二开始时确认，避免 2.4 返工。

### 6.2 createAttempt 的登记与启动顺序

- 必须先 `core.registerAttempt`，再首次 `requestReservation` 或 `submitResultCheck`。
- `unitAttemptId` 由 Execution 生成；CoreAttempts 在 `registerAttempt` 时建立 attempt 元数据。
- 建议 `createAttempt` 完成登记与入队后返回，启动通过内部调度器或下一轮事件循环执行；
  测试需证明不会在 Core 元数据建立前派发或检查结果。

### 6.3 运行期模型窗口检查

计划 6.3 要求“运行期估算、模型窗口检查和向 Core 申请预算，与启动期检查一致”。
规范目前只在 Monitor 第 4 节定义启动期检查，没有为运行期超出定义新的原因码。

建议：

- 复用启动期公式复核
  `estimatePackTokens(pack) + maxOutputTokens ≤ model.limits.contextWindowTokens`；
- 超出时优先按 `LIMIT_EXCEEDED` 处理，但需在 2.3 实现前与规范负责人确认；
- 不得静默新增原因码或修改 contracts。

### 6.4 产物写入的例外边界

- 只有 Execution 写 ArtifactStore。
- 收敛第③步的 RunSummary 是明确例外。
- 违规输出、STOP_UNCONFIRMED 与旧 epoch 结果不得写成新的执行产物。
- 报告发布失败与 RunSummary 发布失败必须分别走 `FAILED` 与 `finalizationError`，
  不得伪造引用。

### 6.5 共享接缝

阶段二预期只修改：

```text
packages/modules/kernel/src/execution/**
packages/modules/kernel/src/core/**（仅必要的集成修正）
docs/M1KernelStage2.md（阶段末报告）
docs/M1-kernel-infra-plan.md（阶段末状态同步）
```

若需要修改 `packages/libraries/contracts`、`packages/testing` 或工厂签名，必须单独提交、
说明对其他分支的影响，并先合入 `feature/M1/main`。

## 7. 阶段二完成定义

阶段二完成时至少满足：

- `ExecutionDuties` 全部方法有真实实现，`execution/` 无空导出或占位成功。
- 五类 `ExecutionRequest` 均可构造并通过 Schema 校验。
- UnitAttempt、FIFO、状态机与幂等测试通过。
- Artifact 归属、读取、`report-publish` 与 RunSummary 测试通过。
- 执行事实全结果矩阵、技术重试、取消、停止未确认与未知效果测试通过。
- 真实 Monitor/Scheduler 经 Core 路径完成预算、结算、容量与收尾验证。
- 阶段二纵向链在 fake Supervisor 下完整通过。
- `pnpm run check`、`pnpm run test:coverage` 与 `git diff --check` 通过。
- 阶段报告记录证据、边界与遗留。
- 计划状态更新为阶段二完成，阶段三至六仍未开始。

## 8. 执行与提交约定

- 按 2.1 → 2.2 → 2.3 → 2.4 → 2.5 → 2.6 顺序推进；每个子阶段结束运行定向测试，
  阶段末运行完整质量门。
- 每个子阶段一个逻辑提交，使用 `feat:`、`test:` 或 `fix:`；不把多个子阶段混在一个提交。
- 不自动 push、创建 PR 或修改他人目录；共享接缝变更先协调。
- 阶段报告与计划状态更新放在最后一个提交，避免实现尚未完成时提前标记。
- 源码、测试与注释不得链接本文件或使用本文编号；只有本计划文档可以引用规范。

## 9. 进度记录

| 日期 | 内容 | 验证 |
| --- | --- | --- |
| 2026-10-19 | 制定阶段二工作子阶段规划：2.1 Execution 骨架、2.2 产物与内建 Unit、2.3 请求与上下文、2.4 执行事实与重试、2.5 预算与容量、2.6 整链验证与报告 | 仅文档；阶段二尚未开始，未运行产品测试 |
| 2026-10-19 | 完成 2.1：Execution 骨架、Attempt/FIFO/状态机、幂等创建、`abortQueued`、非 `COMPLETED` 事实基础路径、停止未确认与未知效果 | `pnpm run check`（45 个文件、445 项）；`pnpm run test:coverage`（全仓语句 92.28%，execution 语句 72.41%）；代码未提交 |
| 2026-10-19 | 完成 2.2：产物归属索引、多生产者登记、`ownsArtifact`/`readArtifact`、内建 `report-publish`、RunSummary 发布 | `pnpm run check`（46 个文件、457 项）；`pnpm run test:coverage`（全仓语句 92.42%，execution 语句 80.72%）；代码未提交 |
| 2026-10-19 | 完成 2.3：五类 `ExecutionRequest`、ArtifactRef 解析、上下文/模型输入、toolSpecs、估算与预留 | `pnpm run check`（46 个文件、469 项）；`pnpm run test:coverage`（全仓语句 92.21%，execution 语句 82.29%）；代码未提交 |
