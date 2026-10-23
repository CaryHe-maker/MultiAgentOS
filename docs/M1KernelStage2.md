# MultiAgentOS M1 Kernel 阶段二实现报告

> 状态：工作文档，2026-10-19 完成阶段二实现验收。
> 依据：[M1-kernel-infra-plan](M1-kernel-infra-plan.md) 第 6.3 节与 `docs/M1/` 下的 M1 规范。
> 本文件不是规范；随本分支进入 `feature/M1/main`，由项目主管人后续归档整理。与 `docs/M1/` 冲突时以规范为准。
> 本文件记录阶段二（2.1–2.6）的实际实现、验证证据、边界与遗留事项。

## 1. 验收结论

阶段二（Execution、Scheduler 与 Monitor 接入）通过验收。

验收范围：

- Execution 的 UnitAttempt、唯一 FIFO、状态机与执行历史；
- 五类 `ExecutionRequest` 与 ArtifactRef 解析；
- 产物归属、内建 `report-publish` 与 RunSummary 发布；
- 全部执行终态、技术重试、退避与旧 epoch 处理；
- 真实 Monitor 与 Scheduler 经 Execution/Core 的预算、结算与容量行为；
- 阶段二纵向链、FIFO、产物读取与终态事件。

本阶段不包含：

- run actor、双通道 Inbox、OrderedSender 与真实 Outbox；
- Supervisor 的真实 `execute` / `cancelRun`；
- `createKernelCore` 装配与真实启动；
- 基础设施故障矩阵；
- 真实模型 E2E 与 M1 整机验收。

阶段二代码工作已收敛。后续改动应属于阶段三至六、缺陷修复或单独的接口调整，不再以阶段二子阶段名义扩展功能。

## 2. 交付范围与代码结构

阶段二实现集中在：

```text
packages/modules/kernel/src/execution/
  attempt.ts              UnitAttempt、ExecutionRecord 与 AttemptState
  queue.ts                唯一 FIFO
  dispatcher.ts           已构造 ExecutionRequest 的派发接口
  artifact-ownership.ts   按运行登记产物归属与生产者
  request-builder.ts      五类 ExecutionRequest 与输入解析
  index.ts                ExecutionDuties、重试、终态与 RunSummary
  execution.test.ts       Execution 单元与集成测试
  artifact-ownership.test.ts
packages/modules/kernel/src/core/
  attempts.ts             结果检查的交付资格前置
  attempts.test.ts        旧 epoch COMPLETED 测试
  index.ts                供测试与后续接线使用的组件导出
packages/modules/kernel/src/
  budget-capacity.test.ts 真实 Monitor/Scheduler 集成
  stage2-integration.test.ts
                          CoreRequestHandler 纵向链与 FIFO
```

未修改：

- `packages/libraries/contracts`；
- `packages/testing`；
- 根构建、检查与锁文件；
- 其他 Module、静态库或基础设施目录。

阶段 2.1–2.3 已由提交 `51fec05` 提交；2.4–2.6 与本报告随文档收尾提交进入工作分支。

## 3. 实现内容

### 3.1 Execution 骨架与 FIFO

- `Execution.createAttempt` 先 `core.registerAttempt`，再入队；以 `requestId` 幂等。
- `AttemptQueue` 是唯一 FIFO；同一时刻只启动一个尝试。
- 状态机：

```text
QUEUED → STARTING → DISPATCHED → CHECKED
QUEUED / STARTING → ABORTED
```

- `runEpoch` 变化后不再启动旧尝试。
- `abortQueued` 清空排队并返回在途执行，供 Core 登记取消。
- `synthesizeStopUnconfirmed`、`collectUnknownEffects` 与 `modelRequestCount` 已有实现。

### 3.2 产物归属与内建 Unit

- `ArtifactOwnership` 以 `(artifactId, mediaType)` 为键：
  - 登记 `sha256`、`size` 与多个 producer；
  - 同一身份出现不同完整性字段时拒绝；
  - `ownsArtifact` 与 `readArtifact` 先检查本运行归属。
- Execution 是唯一写正式 Artifact 的组件，写入后登记归属。
- `report-publish` 在 FIFO 中直接执行，不派发给 Supervisor：
  - 校验 `ReportPublishInput`；
  - 规范 JSON 序列化；
  - 检查 `maxReportBytes`；
  - 写入报告并返回 `reportRef`；
  - 写入失败转换为 `FAILED(INTERNAL)`。
- `publishRunSummary` 写入 RunSummary，允许在运行不再是 RUNNING 时调用。

### 3.3 执行请求构造

`ExecutionRequestBuilder` 构造五类请求：

| executionKind | 输入要点 |
| --- | --- |
| `REPOSITORY_ORIENT` | objective、orientBudget、maxFiles |
| `REPOSITORY_SEARCH` | query、mode、maxItems、searchBudget |
| `FILE_READ` | Unit 输入原样 |
| `CONTEXT_ASSEMBLE` | instructions、toolSpecs、orientPack、history、status、tokenBudget |
| `MODEL` | ASSEMBLE ContextPack、final、输入预算与输出上限 |

统一处理：

- deadline = `(notBefore ?? 派发时间) + executionLimits[kind].timeoutMs`；
- scope 使用 Core 派生值；
- 只解析规范允许的三个 ArtifactRef 位置；
- 普通上下文包含 Unit 工具、finish 与 handoff；final 只包含 finish；
- `TOOL_RESULT` 且 `status = OK` 时解析 `outputText`。

MODEL 在派发前：

- 校验 ContextPack 为 ASSEMBLE 且 tokenBudget 与 final 一致；
- 重新计算 `estimatePackTokens(contextPack) + maxOutputTokens`；
- 复核模型窗口；
- 通过 `core.requestReservation` 申请预留；
- 预留被拒时不派发。

### 3.4 执行事实、重试与收敛

- `handleExecutionFact` 处理全部终态：
  - `COMPLETED`：写入产物、登记归属、提交结果检查；
  - `REJECTED`、`FAILED`、`TERMINATED`：不写产物，原样提交原因码与 requestState；
  - `VIOLATION`、`STOP_UNCONFIRMED`：隔离输出，不写产物；
  - 重复、迟到与旧 execution 事实不会产生第二次结果检查。
- 技术重试：
  - 仅 `FAILED && retryable`；MODEL 还要求 `requestState = NOT_SENT`；
  - 经 `retryExecution` 授权；
  - 新 `executionId`、`retryCount` 与指数退避 `notBefore`；
  - 重试请求携带 `notBefore`；
  - `BUDGET_WRAP_UP` / `BUDGET_EXHAUSTED` 由 Core 交付后直接结束尝试。
- 旧 epoch `COMPLETED`：
  - Execution 不写新产物、不生成 `outputRef`；
  - Core 在构造 UnitReport 前先判断交付资格；
  - 不可交付结果只结算、计数 `notDelivered` 并审计。
- `modelRequestCount` 包含技术重试；未知效果与停止未确认保持可解释。

### 3.5 预算与容量

阶段二通过真实 `CoreAttempts`、`Monitor`、`Scheduler` 与 `InProcessProviderCapacity` 验证：

- 普通与 final 预留；
- 硬阈值下的 `WRAP_UP` 拒绝；
- final reserve 在普通额度耗尽后仍可使用；
- 预留拒绝时立即释放调用机会；
- 结果检查、重试、取消与收尾的调用机会释放；
- `STOP_UNCONFIRMED` 保留调用机会到最终清理；
- `finalize` 把未结算预留计入未知消耗；
- 实际用量超过估算时产生 `SETTLEMENT_ANOMALY`；
- 两个 Scheduler 实例共享同一 provider 容量。

### 3.6 纵向链

`stage2-integration.test.ts` 使用真实 `CoreRequestHandler`、`CoreAttempts`、Execution、
RequestBuilder、Monitor、Scheduler 与 ArtifactStorePort 测试替身，验证：

```text
registerAgentRun
  → submitUnit(model-call)
  → ExecutionRequest
  → fake Supervisor 回送 COMPLETED
  → 写入 ModelRawOutput
  → UnitReport(OK)
  → submitUnit(report-publish)
  → 写入 AnalysisReport
  → closeRun(COMPLETED)
  → 收敛与 RunSummary
  → RunClosed / RunFinished
  → readArtifact(reportRef / runSummaryRef)
```

另验证两个 MODEL Unit 的 FIFO 串行：前一个结果检查完成前，后一个不会派发。

## 4. 关键设计决定

### 4.1 结算资格与交付资格分离

`AttemptIdentityRegistry` 只判断尝试、执行实例与 Lease 归属；交付资格由 runEpoch 与运行状态另行判断。
旧 epoch 的事实仍可结算，但不能覆盖当前状态或再次交付。

### 4.2 旧 epoch COMPLETED 不要求 outputRef

Core 的 `submitResultCheck` 在构造 UnitReport 前判断交付资格。不可交付的 COMPLETED 结果只结算、
计入 `notDelivered` 并审计，不要求 Execution 为已收敛的运行写新产物。

### 4.3 Artifact 归属是运行级权威

产物引用不是读取权限。Execution 先按本运行归属与 `(artifactId, mediaType)` 检查，再由
ArtifactStore 复验内容；不同 producer 写入相同内容时追加 producer，不覆盖已有登记。

### 4.4 请求构造与执行派发分离

RequestBuilder 只负责构造合法 `ExecutionRequest` 与计算预留估算；
`AttemptDispatcher` 只接收已构造请求。Execution 不直接调用 Executor，也不解释
FINISH/HANDOFF 等 Workflow 业务语义。

### 4.5 技术重试对 Workflow 不可见

技术重试由 Execution 经 Core 授权后创建新 execution，不计 Workflow Round；
MODEL 请求可能已发出时禁止重试，避免未知消耗被重复计入。

## 5. 验证与证据

### 5.1 质量门

```text
pnpm run check       通过
  48 个测试文件、485 项测试全部通过
pnpm run test:coverage
  全仓语句 92.45%、分支 83.06%、函数 89.43%、行 94.55%
pnpm run demo:fake   退出码 0
git diff --check     通过
```

`demo:fake` 使用 fake Module 与 fake Executor，只证明装配链路，不作为 Stage2 验收依据。

### 5.2 覆盖率

```text
全仓            语句 92.45%  分支 83.06%  函数 89.43%  行 94.55%
kernel/core     语句 87.92%  分支 79.50%  函数 90.98%  行 92.85%
kernel/execution 语句 84.65% 分支 77.64%  函数 87.50%  行 89.62%
kernel/monitor  语句 94.79%  分支 92.47%  函数 100.00% 行 96.59%
kernel/scheduler 语句 92.10% 分支 78.57%  函数 100.00% 行 96.77%
```

### 5.3 测试覆盖矩阵

| 范围 | 覆盖 |
| --- | --- |
| Attempt/FIFO | 幂等、串行、状态转换、abort、旧 epoch |
| Artifact | 归属、多 producer、读写、媒体类型、完整性冲突 |
| Report/RunSummary | 内建发布、大小限制、写入失败、读取 |
| RequestBuilder | 五类请求、默认值、toolSpecs、history、ArtifactRef |
| MODEL | final 一致性、估算、窗口、预留成功/拒绝 |
| ExecutionFact | 全终态、重复/迟到、旧 execution |
| Retry | 允许、拒绝、预算拒绝、退避、新 executionId |
| Budget/Capacity | 普通/final、硬阈值、anomaly、STOP_UNCONFIRMED、共享容量 |
| Vertical chain | registerAgentRun、submitUnit、UnitReport、report-publish、closeRun、RunSummary、readArtifact |
| FIFO chain | 两个 MODEL Unit 的前后顺序 |

## 6. 阶段二退出条件核对

| 条件 | 结果 |
| --- | --- |
| Execution 职责内无占位业务分支 | 满足；`execution/` 无 `NOT_IMPLEMENTED` |
| 五类请求可构造并被 Schema 校验 | 满足 |
| 产物、报告与 RunSummary 可发布读取 | 满足 |
| 全结果矩阵、技术重试与旧 epoch 可验证 | 满足 |
| 真实 Monitor/Scheduler 经 Execution 工作 | 满足 |
| 阶段二纵向链在 fake Supervisor 下完整通过 | 满足 |
| 阶段二质量门通过 | 满足 |
| 未修改共享接缝 | 满足 |

## 7. 边界与遗留

以下事项明确属于后续阶段，不阻断阶段二验收：

| 事项 | 归属 |
| --- | --- |
| Supervisor 的真实 execute/cancel 与执行事实 | 阶段三 |
| run actor、双通道 Inbox、OrderedSender、真实 Outbox | 阶段四 |
| `createKernelCore` 装配、真实启动与组合根联调 | 阶段四、六 |
| ModuleHost/Fabric/Persistence/ArtifactStore 真实故障联调 | 阶段五 |
| 真实模型 E2E 与 F1–F5 | M1 整机验收 |

已知实现边界：

- 2.6 纵向链使用 ArtifactStorePort 测试替身；`LocalArtifactStore` 由其自身测试覆盖，
  真实基础设施故障矩阵属阶段五；
- 真实 Supervisor 尚未接入，执行请求由测试替身接收；
- 运行状态、Lease、账本、Outbox 与 Inbox 仍为内存实现，不提供崩溃恢复；
- 阶段二不实现并行执行、跨进程 IPC、分片或生产级隔离。

## 8. 工作收敛结论

阶段二代码工作已收敛：

- 不再以阶段二子阶段名义扩展功能；
- 后续修复应关联具体缺陷或阶段三至六任务；
- 阶段二以外的能力不得以占位成功响应进入产品路径；
- 共享接缝变更需单独评审并同步 contracts、testing 与相关 fake。

阶段二完成不表示 Kernel 或 M1 整机完成；Stage3 仍需要真实 Supervisor 执行控制，
Stage4 仍需要 run actor 与 `createKernelCore` 装配，M1 验收仍以
[M1Plan](M1/M1Plan.md) 第 7 节和第 8 节为准。
