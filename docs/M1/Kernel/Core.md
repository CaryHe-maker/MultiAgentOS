# MultiAgentOS M1 Kernel.Core

## 1. 定位

Core 负责运行管理、授权、租约与控制裁决，是内外部 syscall 的处理者与 Kernel 对外事件的唯一出口。
组件间交互见 [Interaction](Interaction.md)，长期规划见 [Kernel 架构](../../Architecture/Module/Kernel.md) §5、§6。

## 2. 职责

- 运行管理（`RunRegistry`）：处理 `createRun` 与 `shutdown`，创建与回收运行 actor，按 `workflowRunId` 分发消息（Interaction 4.1）。
- 处理运行 actor 中除执行事实之外的全部消息（Interaction 4.3），按控制通道优先的顺序逐条处理。
- 维护 AgentRun 登记（第 6 节），不持有 AgentRun 实例。
- 授权依据与能力上限：本地用户的回答提供授权依据，固定定义限定能力上限；模型输出、工具注册和能力声明本身不产生授权。
- 是否需要 Lease，以 Unit 定义的 `protectedCapabilities` 为准；M1 的受保护能力只有 `repo.read`。
- Lease 是 Core 私有的运行时数据：签发、检查、复用与失效都在 Core 内完成，对外只给出裁决与派生的 `ExecutionScope`。
- 派生每个尝试的 `ExecutionScope`：受保护 Unit 由 Lease 派生 `REPOSITORY`；model-call 由该 AgentRun 固定的 Model 定义与 Agent 的
  `modelSettings` 派生 `MODEL`；context-assemble 为 `NONE`。
- 代为调用 Scheduler 分配与释放调用机会、调用 Monitor 预留与结算额度；保证每个运行至多一次 final-call。
- 结果检查（第 5 节），并作为唯一出口经 Outbox 交付 RunStart、UnitReport、RunClosed、AuthorizationRequest、AuthorizationResolved 与 RunFinished。
- 维护运行控制状态（`RUNNING`、`CONVERGING`、`CLOSED`）与 runEpoch，组织收敛（Interaction 第 6 节）。
- 运行总时长计时：`RUN_INIT` 时开始，进入收敛时停止；到点按 `RUN_TIMEOUT` 收敛。
- 通知 Supervisor 取消与关闭（`SupervisorPort.cancelRun`、`SupervisorPort.shutdown`），区分执行归属、费用结算与 runEpoch 交付资格。
- 推送 `AdmissionProjection` 给 Gateway。
- 写入审计记录（第 7 节）；统计 Unit 的受理与交付（`RunSummary.units`），组装 RunSummary 并交 Execution 写成产物。
- 处理 actor 之外的发送器投递的 `KERNEL_FAULT`（Interaction 4.4）。
- 运行管理实现组合根的 `abortAllRuns`（Interaction 7.1）；收敛过程自身失败时经 `reportSystemFault` 请求组合根 panic。

M1 只支持只读分析所需的基础人工授权，不引入任意能力扩权、复杂审批、委派与再委派或长期跨运行租约。

## 3. 私有数据

| 数据 | 内容 |
|---|---|
| 运行控制状态 | `runState`、`runEpoch`、`closeReason`、`failure`、`reportRef`、开始与收敛时间、pending 集合 |
| 请求记录 | `requestId →` 请求摘要与响应，用于幂等与 `REQUEST_CONFLICT`；被受理的 `submitUnit` 另记 `agentRunId`、Unit 的 executionKind 与交付结果（OK、REJECTED、FAILED 或未交付） |
| AgentRun 登记 | `agentRunId →` `agentRef`、`PinnedDefinitionSet`、状态（ACTIVE、ENDED）、登记与结束时间、`rounds`（已交付的 OK 或 FAILED 的 model-call UnitReport 数，与 Workflow 的 `roundsUsed` 计法相同） |
| 授权记录 | `questionId`、状态（PENDING、GRANTED、DECLINED、TIMED_OUT、CANCELLED）、询问与回答时间、挂起的 `requestId` 列表 |
| Lease | `capability = repo.read`、`repositoryRoot`（realpath）、`exclusions`、`provider`、签发时间；绑定本运行 |
| final-call 记录 | 已发起 final-call 的 `unitAttemptId`（至多一个） |
| Outbox | 每个接收方（`workflow`、`user-interaction`）的 `seq` 计数与待发事件 |
| 计时器 | 运行总时长、授权询问、收敛兜底 |

Execution、Monitor、Scheduler 只能取得裁决与派生值（Interaction 3.2、3.4）。

## 4. Lease 与用户授权

- `repo.read` 的范围：仓库根目录（`createRun` 时 `repositoryPath` 的 realpath）、排除规则、外发目标 provider（`KernelConfig.provider`）。
- 默认排除规则是 contracts 的 `DEFAULT_REPOSITORY_EXCLUSIONS`，匹配语义见 [M1Interface](../M1Interface.md) 3.5；
  `KernelConfig.repositoryExclusions` 只能追加，不能删除。Executor 使用同一份列表与同一个匹配器。
- Lease = Agent 定义的能力 ∩ 用户授权 ∩ 系统策略；绑定 WorkflowRun，在收敛第 ③ 步失效。
- 一个运行只询问一次。用户同意后，后续 `repo.read` 申请直接签发或复用 Lease，不再询问；危险行为每次询问（M1 不涉及）。

```text
受保护 Unit 通过定义核验（Interaction 5.1）
  ├─ 授权记录为 GRANTED → 签发或复用 Lease → 派生 REPOSITORY 范围 → createAttempt
  ├─ 授权记录为 DECLINED 或 TIMED_OUT → UnitReport(REJECTED, USER_DECLINED)
  ├─ 授权记录为 PENDING → 挂起该请求
  └─ 无授权记录 → 建立 PENDING 记录 → Outbox：AuthorizationRequest → 启动询问计时 → 挂起该请求

AUTHORIZATION_ANSWER（questionId 匹配且为 PENDING）
  ├─ YES → GRANTED，签发 Lease，挂起的请求依次 createAttempt，Outbox：AuthorizationResolved(GRANTED)
  └─ NO  → DECLINED，挂起的请求依次交付 USER_DECLINED，Outbox：AuthorizationResolved(DECLINED)
AUTHORIZATION_TIMEOUT → TIMED_OUT，处理同 NO，AuthorizationResolved(TIMED_OUT)
questionId 不匹配或记录不为 PENDING → SyscallRejected(QUESTION_NOT_PENDING)
```

`AuthorizationRequest` 的内容：`questionId`、`capability = repo.read`、`repositoryPath`、`exclusions`、`provider`、
`expiresAt = 询问时间 + authorizationTimeoutMs`。拒绝或超时不视为同意，并在本运行内保留。

## 5. 结果检查

结果检查是同步函数（Interaction 5.4），不回调 Execution、不等待 I/O；需要收敛时只登记，收尾由 `settleConvergence` 完成（Interaction 4.4、第 6 节）。按以下顺序：

```text
① 核对归属：尝试属于本运行；executionId 是该尝试当前的执行实例；受保护 Unit 的 Lease 仍有效
② MODEL：Monitor.settle（按 Interaction 5.4 的结算表）→ Scheduler.release（STOP_UNCONFIRMED 除外）
③ VIOLATION → 进入收敛（VIOLATION）；运行为 RUNNING 时的 STOP_UNCONFIRMED → 进入收敛（FAILED, EXECUTION_STOP_UNCONFIRMED）
④ 按映射表形成 UnitReport { status, reasonCode, output, outputRef, budgetState }
⑤ 尝试的 runEpoch 等于当前 runEpoch 且运行为 RUNNING → 放入 Outbox；否则不交付，只作为证据
```

执行前被拒（授权、额度预留、产物引用）的 Unit 同样由 Core 形成 UnitReport 并放入 Outbox。
Core 检查结果的执行归属与可接受性，Workflow 判断业务结果；执行完成、Core 接受结果与业务验收分别表达。
执行失败或结果被拒绝都不能免除已发生的消耗。

### 5.1 预留与 final-call

```text
requestReservation(unitAttemptId, estimatedTokens, final)
  运行不为 RUNNING → 返回 RUN_CONVERGING
  final 且已有其他尝试发起过 final-call → 交付 UnitReport(REJECTED, FINAL_CALL_USED)，返回 FINAL_CALL_USED
  grant = Scheduler.acquire(provider)
    失败（M1 串行执行，正常不会发生）→ 登记 FAILED(KERNEL_INTERNAL) 收敛（Interaction 4.4 第 3 条），返回 RUN_CONVERGING
  r = Monitor.reserve(estimatedTokens, final)
    被拒 → Scheduler.release(grant) → 交付 UnitReport(REJECTED, r.reasonCode)，返回 r.reasonCode
    成功 → final 时记录该 unitAttemptId → 返回 { granted: true, reservationId, grantId }
```

同一尝试的技术重试再次申请 final 预留不算第二次 final-call。技术重试见 [Execution](Execution.md) 第 6 节：
`retryExecution` 先以 `NOT_SENT` 结算旧预留并释放旧机会，再按上述流程重新申请。

## 6. AgentRun 登记

```text
REGISTER_AGENT_RUN
  agentRunId 已登记 → AGENT_RUN_EXISTS
  已有 ACTIVE 的 AgentRun → AGENT_RUN_ACTIVE
  CatalogPort.pinAgent({ id, version }) 失败 → DEFINITION_UNAVAILABLE
  固定结果的 digest ≠ agentRef.digest → DEFINITION_MISMATCH
  model.provider ≠ KernelConfig.provider → FORBIDDEN
  否则登记为 ACTIVE，保存固定集合 → SyscallAck

END_AGENT_RUN
  未登记 → AGENT_RUN_NOT_FOUND；已为 ENDED → AGENT_RUN_ENDED
  否则标记为 ENDED → SyscallAck（已受理的 Unit 继续执行并交付 UnitReport）
```

同一时刻至多一个 ACTIVE 的 AgentRun；收敛第 ③ 步把全部 AgentRun 标记为 ENDED。

## 7. 审计

Core 经 `PersistencePort.auditLog('kernel-core', workflowRunId)` 追加审计条目，每条包含 `at`、`workflowRunId`、`type`，
以及与类型相关的 `requestId`、`agentRunId`、`unitAttemptId`、`executionId`、`reasonCode`。审计不记录 Lease 内容、凭据、Prompt 或源码。

| type | 时机 |
|---|---|
| `RUN_STARTED` | 处理 `RUN_INIT` |
| `AGENT_RUN_REGISTERED`、`AGENT_RUN_ENDED` | 登记与结束 AgentRun |
| `REQUEST_REJECTED` | Core 返回 SyscallRejected |
| `AUTHORIZATION_ASKED`、`AUTHORIZATION_RESOLVED` | 发出询问、得到结果 |
| `UNIT_ACCEPTED`、`UNIT_REPORTED`、`UNIT_NOT_DELIVERED` | Unit 的受理、交付与不交付 |
| `SETTLEMENT_ANOMALY` | 实际用量超过估算，或重复结算数值冲突（[Monitor](Monitor.md) 3.4） |
| `STALE_FACT` | 归属核对失败或 CLOSED 后到达的执行事实 |
| `CONVERGENCE_STARTED`、`CLOSE_REASON_UPGRADED`、`CONVERGENCE_DEADLINE` | 收敛过程 |
| `SYSTEM_FAULT_ABORT` | 组合根调用 `abortAllRuns`，附 `faultId`（Interaction 7.1） |
| `RUN_CLOSED` | 收敛第 ③ 步，附 `runSummaryRef` |

## 8. 配置

| 配置 | 读取者 | 建议初值 |
|---|---|---|
| `KernelConfig.provider` | Core | `deepseek` |
| `KernelConfig.authorizationTimeoutMs` | Core | 300000 |
| `KernelConfig.runTimeoutMs` | Core | 1800000 |
| `KernelConfig.convergenceMarginMs` | Core | 1000 |
| `KernelConfig.repositoryExclusions` | Core | `[]` |

完整配置见 [Interaction](Interaction.md) 第 9 节。

## 9. 非停机异常语义

Core 维护与 syscall 并列的私有异常处理入口；分类以
[异常处理与安全停机](../SystemFaultHandling.md) 为准。
该入口是 Kernel 内部逻辑，不新增外部 syscall、Fabric Schema 或跨模块异常总线。
既有消息、执行结果和同步返回值在各自接收点进入统一的处理规则，不能再投递一次造成重复结算。

处理顺序：

1. 核验来源、workflowRunId、关联 request、attempt 和当前 execution；不信任外部自报的异常类别。
2. 读取运行状态，按下面的语义表决定拒绝、记录、许可重试或登记收敛。
3. 在同步内部 syscall 中只改变 Core 状态、调用 Monitor/Scheduler 和登记待发送项；
   不回调 Execution、不等待 I/O。收尾由本轮末尾的 settleConvergence 执行。
4. 按原契约响应、审计或交付。需要重试时由 Execution 发起申请，Core 只裁决许可。
5. 已知关键状态无法维持或异常处理自身失败时请求组合根 panic，不递归处理自身异常。

| 输入 | Core 语义 |
| --- | --- |
| 权限、输入、预算等拒绝 | 保持已有拒绝码，不自动结束运行；Gateway 边界拒绝仍由 Gateway 处理 |
| 授权超时 | 结束询问，拒绝挂起请求，不直接终止运行 |
| 执行失败、UNIT_TIMEOUT | 核验并结算；按契约交付失败，重试按 Execution 规则申请 |
| 结算异常 | 使用 Monitor 的保守结算结果并审计，不重复收费 |
| RUN_TIMEOUT | 按 RUN_TIMEOUT 收敛 |
| VIOLATION | 隔离输出，按违规收敛；收敛中允许升级结束原因 |
| STOP_UNCONFIRMED | 记录未知效果，按 FAILED 收敛，容量保留到最终清理 |
| KERNEL_FAULT | RUNNING 时按 FAILED(KERNEL_INTERNAL) 收敛；已收敛时只记录 |

CONVERGING 中旧 epoch 的合法在途事实仍需结算与记录，不重试、不发布执行产物、不交付 UnitReport。
CLOSED 后的事实只作为证据，不修改已发布结果。非停机异常可以结束任务，任务结束后的正常退出不等于 panic。
异常类型与当前状态的处理表必须有确定性测试，覆盖重复、迟到、取消竞争以及异常处理再次失败。
