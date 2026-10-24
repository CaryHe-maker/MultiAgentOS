# MultiAgentOS M1 Kernel 阶段一实现报告

> 状态：工作文档，2026-10-19 完成阶段一实现验收。
> 依据：[M1-kernel-infra-plan](M1-kernel-infra-plan.md) 第 6.2 节与 `docs/M1/` 下的 M1 规范。
> 本文件不是规范；随本分支进入 `feature/M1/main`，由项目主管人后续归档整理。与 `docs/M1/` 冲突时以规范为准。
> 本文件记录阶段一（1.1–1.6）的实际实现、验证证据、边界与遗留事项。

## 1. 验收结论

阶段一（Kernel Core 控制逻辑与 Gateway 偏差修正）通过验收。

验收范围：

- Core 的运行管理、外部 syscall、AgentRun 生命周期；
- 授权、Lease、范围派生；
- CoreSyscalls、预留、结算、结果检查与技术重试；
- 三步收敛、终态事件、RunSummary、shutdown 与 abortAllRuns；
- Core 非停机异常入口与 panic 请求；
- Core 审计完整性；
- Gateway 身份、准入与结构化拒绝日志。

本阶段不包含：

- Execution 的真实执行队列与执行事实；
- Supervisor 的真实执行派发与取消；
- run actor、Inbox、OrderedSender、真实 Outbox；
- 四类基础设施真实故障联调；
- `createKernelCore` 装配与真实启动；
- 真实模型 E2E 与 M1 整机验收。

阶段一代码工作已收敛。后续改动应属于阶段二至六或单独缺陷修复，不再以阶段一子阶段名义修改。

## 2. 交付范围与代码结构

阶段一实现集中在：

```text
packages/modules/kernel/src/core/
  attempt-identity.ts    尝试与执行实例身份、结算资格
  attempts.ts            CoreSyscalls、预留、结算、结果检查、技术重试
  audit.ts               Core 审计类型与注入接口
  authorization.ts       授权记录、Lease、挂起队列
  events.ts              内部事件出口
  exceptions.ts          非停机异常输入
  finalize-run.ts        终态事件构造（阶段一前已有）
  request-ledger.ts      requestId 幂等
  request-handler.ts     运行内 syscall、收敛、终态、异常入口
  run-registry.ts        单运行管理、shutdown、abortAllRuns、墓碑
  run-state.ts           运行状态、AgentRun、Unit 决策、计数
  scope.ts               REPOSITORY / MODEL / NONE 范围派生
packages/modules/kernel/src/gateway/index.ts
  Gateway 身份、准入投影与结构化拒绝日志
```

未修改：

- `packages/libraries/contracts`；
- `packages/testing`；
- 根构建、检查与锁文件；
- 其他 Module、静态库或基础设施目录。

阶段 1.1–1.3 已由提交 `9f7c9f2` 提交。阶段 1.4–1.6 与本报告随后续提交进入工作分支。

## 3. 实现内容

### 3.1 运行管理与生命周期

`RunRegistry` 实现 M1 单运行管理：

- `createRun`：
  - 绝对路径、存在性、目录检查；
  - `realpath` 解析；
  - 仓库与 `dataDir` 双向包含检查；
  - 单进程单运行；
  - requestId 幂等；
  - `RUN_LIMIT` 与 `REPOSITORY_INVALID`。
- `shutdown`：
  - 标记系统正在关闭；
  - 后续 `createRun` 返回 `RUN_LIMIT`；
  - 启动运行取消收敛；
  - `whenClosed()` 等待收敛完成。
- `abortAllRuns`：
  - 组合根故障路径；
  - 传递 `faultId`；
  - 有期限等待；
  - 超时后不假定收敛已经完成。
- 墓碑：
  - 运行 CLOSED 后保留 `workflowRunId → closeReason`；
  - 用于迟到消息与关闭后查询。
- `report(fact)`：
  - 按 `workflowRunId` 路由执行事实；
  - CLOSED 后只作为证据处理，不重新打开运行。

运行状态只前进：

```text
RUNNING → CONVERGING → CLOSED
```

`runEpoch` 只在首次进入 CONVERGING 时增加一次。收敛中确认 VIOLATION 只升级结束原因，不重复增加 epoch。

### 3.2 外部请求与幂等

`CoreRequestHandler` 实现运行内七种请求：

- `registerAgentRun`
- `submitUnit`
- `endAgentRun`
- `closeRun`
- `answerAuthorization`
- `cancelRun`
- `readArtifact`

`createRun` 与 `shutdown` 由 `RunRegistry` 处理。

所有改变状态的请求：

- 使用 canonical JSON 的 SHA-256 作为请求指纹；
- 相同 requestId、相同内容返回第一次响应；
- 相同 requestId、不同内容返回 `REQUEST_CONFLICT`；
- 响应与拒绝都记录，保证重放一致。

运行状态矩阵按 Interaction 4.5 实现：

- CONVERGING / CLOSED 下拒绝开启新工作；
- `endAgentRun`、`closeRun`、`cancelRun` 在封锁后只返回 Ack、无效果；
- `answerAuthorization` 在封锁后返回 `QUESTION_NOT_PENDING`；
- `readArtifact` 在所有运行状态下可处理，直到系统关闭。

### 3.3 AgentRun 生命周期

`registerAgentRun`：

- 调用 `CatalogPort.pinAgent`；
- 核对 Agent digest；
- 核对固定模型 provider 与 `KernelConfig.provider`；
- 拒绝重复 `agentRunId`；
- 同一时刻只允许一个 ACTIVE AgentRun；
- 保存 `PinnedDefinitionSet`、登记时间与 Round 计数。

失败映射：

| 情况 | 原因码 |
|---|---|
| 定义不存在、不可用 | `DEFINITION_UNAVAILABLE` |
| digest 不一致 | `DEFINITION_MISMATCH` |
| provider 不一致 | `FORBIDDEN` |
| 重复 AgentRun | `AGENT_RUN_EXISTS` |
| 已有 ACTIVE AgentRun | `AGENT_RUN_ACTIVE` |

`endAgentRun`：

- 未登记 → `AGENT_RUN_NOT_FOUND`；
- 已结束 → `AGENT_RUN_ENDED`；
- 正常结束记录 `endedAt`；
- 收敛开始后只返回 Ack、无效果。

### 3.4 submitUnit 受理

按 Interaction 5.1 顺序检查：

1. requestId 幂等/冲突；
2. 运行状态；
3. AgentRun 存在与状态；
4. Unit 是否属于固定定义闭包（id、version、digest）；
5. `executionKind` 是否为 `FILE_WRITE`、`COMMAND`、`TEST`；
6. 输入是否符合 `inputContract`。

通过后：

- 无受保护能力：派生 `NONE` 或 `MODEL` 范围，创建 Attempt；
- `repo.read` 已授权：派生 `REPOSITORY` 范围，创建 Attempt；
- `repo.read` 尚无授权：建立授权询问，挂起请求；
- `repo.read` 被拒绝/超时：交付 `UnitReport(REJECTED, USER_DECLINED)`，不创建 Attempt。

`units.submitted` 对每个得到 SyscallAck 的 submitUnit 计数。

### 3.5 授权、Lease 与范围

`AuthorizationManager` 实现：

- 一个运行只询问一次 `repo.read`；
- 状态：`PENDING / GRANTED / DECLINED / TIMED_OUT / CANCELLED`；
- 询问内容：仓库根 realpath、排除规则、目标 provider、`expiresAt`；
- 询问期间多个请求进入同一挂起队列，按到达顺序处理；
- YES 签发 Lease，释放挂起请求；
- NO / 超时保留拒绝状态，后续同类请求直接 `USER_DECLINED`；
- 收敛开始时取消进行中的询问；
- 收敛第③步失效 Lease。

排除规则：

```text
DEFAULT_REPOSITORY_EXCLUSIONS + KernelConfig.repositoryExclusions
```

默认规则不可删除。Core 与 Executor 使用 contracts 中同一份规则与匹配器。

范围派生：

- `REPOSITORY`：仓库根目录与排除规则，只来自 Lease 派生值；
- `MODEL`：固定 Model 定义与 Agent `modelSettings`；
- `NONE`：context-assemble、report-publish 等。

Lease 不进入 `ExecutionScope`，不写审计，不暴露给其他组件。

### 3.6 CoreSyscalls、预留与结果检查

`CoreAttempts` 实现：

- `registerAttempt`
- `registerExecution`
- `requestReservation`
- `submitResultCheck`
- `retryExecution`
- `currentRunEpoch`

预留：

- 运行不为 RUNNING → `RUN_CONVERGING`；
- final-call 至多一次；
- 同一尝试的技术重试不重复占用 final-call；
- `Scheduler.acquire` 与 `Monitor.reserve` 同时成功或都不持有；
- Monitor 拒绝 → 释放调用机会并交付 `REJECTED(BUDGET_*)`；
- Scheduler 失败 → 登记 `FAILED(KERNEL_INTERNAL)` 收敛。

结果检查：

| 结果 | 结算 | 调用机会 | UnitReport |
|---|---|---|---|
| `COMPLETED` | `ACTUAL` 或 `UNKNOWN` | 释放 | `OK` |
| `REJECTED` | `NOT_SENT` | 释放 | `REJECTED` |
| `FAILED` | 按 `requestState` | 释放 | `FAILED` |
| `TERMINATED(UNIT_TIMEOUT)` | 按 `FAILED` | 释放 | `FAILED(UNIT_TIMEOUT)` |
| `TERMINATED(EXECUTION_CANCELLED)` | 按 `FAILED` | 释放 | 不交付 |
| `VIOLATION` | `UNKNOWN` | 释放 | 不交付，进入收敛 |
| `STOP_UNCONFIRMED` | `UNKNOWN` | 不释放 | 不交付，进入收敛 |
| `NOT_DISPATCHED` | 无预留 | — | `REJECTED` |

关键规则：

- 结算资格与交付资格分离；
- 旧 epoch 的合法在途结果仍结算；
- 只有在运行为 RUNNING 且尝试 epoch 等于当前 epoch 时才交付 UnitReport；
- 重复或归属不符的结果写入 `STALE_FACT`，不重复结算；
- 已交付的结果计入 `ok / rejected / failed`；
- 未交付结果计入 `notDelivered`。

技术重试：

- 每个尝试最多 `technicalRetryLimit` 次；
- 只有 `FAILED`、`retryable` 且 MODEL `requestState = NOT_SENT` 才允许；
- 旧预留按 `NOT_SENT` 结算并释放；
- 新执行实例使用新的 `executionId` 与退避时间；
- 对 Workflow 不可见，不计 Round。

### 3.7 收敛、终态与 RunSummary

三步收敛：

1. 开始收敛：
   - 记录 closeReason / failure / reportRef；
   - 状态改为 CONVERGING；
   - runEpoch 加 1；
   - 发出 AdmissionProjection(CONVERGING)；
   - 取消进行中的授权询问；
   - `Scheduler.stopGranting()`；
   - `Execution.abortQueued()`；
   - pending 非空时登记 `SupervisorPort.cancelRun`。
2. 收敛中：
   - 在途结果继续结算，但不交付；
   - 结果结算后从 pending 删除；
   - pending 清空后进入第③步；
   - VIOLATION 可升级结束原因并清除 reportRef；
   - 兜底期限到达时调用 `synthesizeStopUnconfirmed`。
3. 完成收敛：
   - `Monitor.finalize()`；
   - AgentRun 标记 ENDED；
   - Lease 失效；
   - `Scheduler.releaseAll()`；
   - 收集 unknownEffects；
   - 规范化 Unit 计数；
   - 组装 RunSummary；
   - `finalizeRunEvents`；
   - 写 `RUN_CLOSED` 审计；
   - 发 `RunClosed` 与 `RunFinished`；
   - 状态改为 CLOSED；
   - 发出 AdmissionProjection(CLOSED)；
   - 完成 `whenConverged()`。

RunSummary：

- `units.notDelivered` 按不变量计算：
  `submitted - ok - rejected - failed`；
- 发布失败时保留原结束原因与未知效果，使用
  `finalizationError = RUN_SUMMARY_WRITE_FAILED`，不伪造引用；
- `RunClosed` 与 `RunFinished` 内容一致，各恰好一个。

### 3.8 shutdown 与 abortAllRuns

`shutdown`：

- 标记系统正在关闭；
- 立即返回 SyscallAck；
- 启动运行取消收敛；
- `RunRegistry.whenClosed()` 等待收敛完成；
- 关闭后不再允许 `createRun`。

`abortAllRuns`：

- 停止新运行；
- 对未 CLOSED 运行请求 `FAILED(KERNEL_INTERNAL)`；
- 写入 `SYSTEM_FAULT_ABORT` 审计；
- 有期限等待；
- 不停止模块，不代替组合根决定退出码。

### 3.9 非停机异常

`CoreException` 覆盖：

- `KERNEL_FAULT`
- `RUN_TIMEOUT`
- `AUTHORIZATION_TIMEOUT`
- `VIOLATION`
- `STOP_UNCONFIRMED`
- `EXECUTION_FAILED`
- `SETTLEMENT_ANOMALY`

`handleCoreException` 路由：

| 异常 | 处理 |
|---|---|
| `KERNEL_FAULT` | RUNNING → `FAILED(KERNEL_INTERNAL)`；CONVERGING/CLOSED 只审计 |
| `RUN_TIMEOUT` | 按 `RUN_TIMEOUT` 收敛 |
| `AUTHORIZATION_TIMEOUT` | 结束询问，生成 `USER_DECLINED`，运行继续 |
| `VIOLATION` | 按 `VIOLATION` 收敛或升级 |
| `STOP_UNCONFIRMED` | RUNNING 时按 `FAILED(EXECUTION_STOP_UNCONFIRMED)` 收敛 |
| `EXECUTION_FAILED` | 保持结构化结果路径 |
| `SETTLEMENT_ANOMALY` | 保持 Monitor 审计路径 |

收敛、结算或摘要发布自身失败时：

- 调用 `reportSystemFault`；
- `source = 'kernel-core'`；
- `phase = 'RUN'`；
- 带 `workflowRunId`；
- 同时拒绝 `whenConverged()`，避免关闭流程无限等待；
- 不递归投递 `KERNEL_FAULT`，不重复收敛。

### 3.10 审计

阶段一已实现以下审计类型：

- `RUN_STARTED`
- `AGENT_RUN_REGISTERED`
- `AGENT_RUN_ENDED`
- `REQUEST_REJECTED`
- `AUTHORIZATION_ASKED`
- `AUTHORIZATION_RESOLVED`
- `UNIT_ACCEPTED`
- `UNIT_REPORTED`
- `UNIT_NOT_DELIVERED`
- `SETTLEMENT_ANOMALY`
- `STALE_FACT`
- `CONVERGENCE_STARTED`
- `CLOSE_REASON_UPGRADED`
- `CONVERGENCE_DEADLINE`
- `SYSTEM_FAULT_ABORT`
- `RUN_CLOSED`

审计字段不包含：

- Lease 内容；
- 凭据；
- Prompt 正文；
- 源码正文；
- 工具输出正文。

### 3.11 Gateway

Gateway 保留以下职责：

- 以 `Envelope.producer` 判定调用方身份；
- 按请求类型检查调用方；
- Schema 校验；
- 运行存在检查；
- 准入封锁执行；
- 按运行维护只前进的 admission 投影；
- createRun 生成 `workflowRunId` 与 `correlationId`；
- createRun 拒绝或重放时清理临时 admission。

所有拒绝路径写入结构化日志：

- `INVALID_REQUEST`
- `CALLER_FORBIDDEN`
- `RUN_NOT_FOUND`
- `RUN_BLOCKED`，附 `closeReason`

Gateway 不保存 Lease、额度或运行状态。

## 4. 关键设计决定

### 4.1 结算资格与交付资格分离

`AttemptIdentityRegistry.check` 验证：

- 尝试属于本运行；
- 执行实例是当前实例；
- 受保护 Unit 的 Lease 仍有效。

它不再因 epoch 不匹配直接拒绝结果。调用方通过 `attemptEpoch` 与当前
`runEpoch` 比较，另行决定是否交付。

这样保证：

- 收敛中的旧 epoch 结果仍会结算与记录；
- 迟到结果不会覆盖新状态；
- 结果只作为证据保存。

### 4.2 Lease 在收敛第③步失效

收敛开始时只取消进行中的授权询问，不提前使 Lease 失效。
旧 epoch 的在途结果完成结算后，第③步统一失效 Lease。

### 4.3 Unit 计数由不变量收敛

RunSummary 的 `notDelivered` 在收敛完成时按
`submitted - ok - rejected - failed` 计算，覆盖：

- 随 RunClosed 结束的挂起请求；
- 被 abortQueued 清出队列的未启动尝试；
- 旧 epoch 未交付结果；
- 授权取消的请求。

### 4.4 定时器与 Outbox 保持接缝

阶段一实现业务触发入口：

- `runTimedOut`
- `authorizationTimedOut`
- `convergenceDeadline`
- `shutdownRun`
- `abortRun`

实际定时消息入队、Inbox、OrderedSender 与 Outbox 的 eventId/seq
属于阶段四 run actor。

事件当前通过同步 `CoreEventSink` 发出，阶段四替换为真实 Outbox。

## 5. 验证与证据

### 5.1 质量门

```text
pnpm run build       通过
pnpm run check       通过
  format:check       通过
  lint               通过
  typecheck          通过
  test               44 个测试文件、433 项测试全部通过
git diff --check     通过
pnpm run demo:fake   退出码 0
```

`demo:fake` 使用 fake Module 与 fake Executor，只证明装配链路，
不作为阶段一 Core 验收依据。

### 5.2 覆盖率

```text
全仓            语句 92.94%  分支 83.73%  函数 89.18%  行 94.83%
kernel/core     语句 86.95%  分支 79.65%  函数 87.70%  行 91.93%
kernel/gateway  语句 87.91%  分支 70.58%  函数 86.36%  行 92.30%
```

### 5.3 测试覆盖矩阵

| 范围 | 覆盖 |
|---|---|
| RunRegistry | createRun、REPOSITORY_INVALID、RUN_LIMIT、幂等、墓碑、shutdown、abortAllRuns |
| 请求层 | 九种 syscall、三态矩阵、重放、冲突 |
| AgentRun | 固定、digest、provider、单 ACTIVE、结束 |
| submitUnit | 状态、闭包、unsupported、输入 Schema |
| 授权 | YES/NO/超时/取消、多请求挂起、Lease、范围 |
| 预留 | 原子性、final-call、预算拒绝、Scheduler 失败 |
| 结果检查 | 全结果矩阵、结算、旧 epoch、迟到结果、违规、停止未确认 |
| 重试 | `NOT_SENT`、`REQUEST_MAY_BE_SENT`、`RETRY_LIMIT`、非 MODEL |
| 收敛 | pending、兜底期限、VIOLATION 升级、RunSummary、终态事件 |
| 异常 | KERNEL_FAULT、RUN_TIMEOUT、授权超时、panic 请求 |
| 审计 | 类型覆盖、脱敏 |
| Gateway | 身份、未知运行、准入、畸形正文、重放 |

## 6. 阶段一退出条件核对

| 条件 | 结果 |
|---|---|
| Core 职责内无占位业务分支 | 满足 |
| 通过替身验证 syscall、授权、结果检查、收敛、异常 | 满足 |
| Gateway 偏差关闭 | 满足 |
| 阶段一质量门通过 | 满足 |
| 未修改共享接缝 | 满足 |

## 7. 边界与遗留

以下事项明确属于后续阶段，不阻断阶段一验收：

| 事项 | 归属 |
|---|---|
| Execution 的 FIFO、执行事实、内建 report-publish | 阶段二 |
| Supervisor 的 execute/cancel 与执行事实 | 阶段三 |
| run actor、双通道 Inbox、OrderedSender、定时器入队、Outbox eventId/seq | 阶段四 |
| ModuleHost/Fabric/Persistence/ArtifactStore 真实故障联调 | 阶段五 |
| `createKernelCore` 装配、真实启动、组合根 panic 联调 | 阶段六 |
| 真实模型 E2E 与 F1–F5 | M1 整机验收 |

当前阶段一的自动化测试使用测试替身驱动 Execution 与 Supervisor，
符合 M1-kernel-infra-plan 第 6.2 节。

已知实现边界：

- `KERNEL_FAULT` 在 CONVERGING/CLOSED 的审计复用
  `SYSTEM_FAULT_ABORT` 并附 `faultId`；
- 审计存储失败在收敛路径中被记录为本地诊断，不阻断终态事件；
- 非停机异常入口不新增公共协议；
- 定时器只实现触发入口，实际入队与取消属于阶段四。

## 8. 工作收敛结论

阶段一代码工作已收敛：

- 不再以阶段一子阶段名义扩展功能；
- 后续修复应关联具体缺陷或阶段二至六任务；
- 阶段一以外的能力不得以占位成功响应进入产品路径；
- 共享接缝变更需单独评审并同步 contracts、testing 与相关 fake。

阶段一完成不表示 M1 整机完成；M1 验收仍以
[M1Plan](M1/M1Plan.md) 第 7 节和第 8 节为准。
