# MultiAgentOS M1 Kernel 内部交互

## 1. 目的与范围

本文规定 M1 Kernel 六组件之间的交互：通讯主体与模块化隔离、Kernel 私有接口、运行管理与运行 actor、
Unit 的内部执行路径、收敛、关闭与 panic。各组件的数据与规则见同目录下的组件文档，
Kernel 对外提供的 syscall 与返回信息见 [Kernel（外部视角）](../Module/Kernel.md)，跨模块类型见 [M1Interface](../M1Interface.md)，
长期规划见 [Kernel 架构](../../Architecture/Module/Kernel.md)。

| 组件 | M1 职责 |
|---|---|
| [Gateway](Gateway.md) | 统一申请入口、调用方身份与准入检查 |
| [Core](Core.md) | 运行管理、授权、租约、控制裁决、运行计时、结果检查与事件交付 |
| [Scheduler](Scheduler.md) | API 调用机会 |
| [Monitor](Monitor.md) | 资源账本与额度控制 |
| [Execution](Execution.md) | 尝试、执行队列、产物与内建 Unit |
| [Supervisor](Supervisor.md) | 系统生命周期；Executor 的派发、装配、截止时间、终止与回收；上报执行事实 |

## 2. 术语

| 术语 | 定义 |
|---|---|
| 运行管理（`RunRegistry`） | Core 中跨运行的部分：创建与回收运行 actor、按 `workflowRunId` 分发消息、处理 `createRun` 与 `shutdown`。只保存映射与生命周期，不保存任何运行状态 |
| 运行 actor | 一个运行的邮箱、串行处理循环，以及该运行在 Core、Execution、Monitor、Scheduler 中的状态分块。每个运行一个，不是第七个组件 |
| runEpoch | 运行控制状态的版本号，从 1 开始，只在运行进入 CONVERGING 时加 1 |
| 在途执行 | 已派发给 Supervisor、尚未收到终态事实的执行实例 |
| Outbox | Core 状态分块中的事件出口，每个接收方一个 `seq` 计数与一个待发队列 |
| 待发送 | 处理函数登记、在处理结束后由 actor 之外的发送器发出的跨主体消息 |
| 墓碑 | actor 回收后，运行管理为该运行保留的 `workflowRunId → CLOSED, closeReason` 记录 |

## 3. 组织与调用关系

### 3.1 通讯主体

| 通讯主体 | 组成 | M1 实现 |
|---|---|---|
| Kernel 核心 | Core、Monitor、Scheduler、Execution，模块化单体 | 单个实例，不分片 |
| Supervisor | Supervisor 及其管理的 Executor | 与 Kernel 核心同进程；Executor 在进程内运行，`rg` 以子进程运行 |
| Gateway | Gateway | 逻辑独立，与 Kernel 核心同进程 |

Kernel 核心与 Supervisor、Gateway 之间只经 Fabric 交换可序列化数据（M1Interface 第 2 节）。

### 3.2 Kernel 核心内部的模块化隔离

Core、Monitor、Scheduler、Execution 同进程、同通讯主体，但各自的数据按模块隔离。

| 约束 | M1 实现 |
|---|---|
| 运行状态分块 | 运行 actor 的状态分为 Core、Execution、Monitor、Scheduler 四块，每个组件只拿到自己的一块 |
| 模块边界 | `packages/kernel` 下按组件分目录（`core/`、`execution/`、`monitor/`、`scheduler/`、`gateway/`、`supervisor/`），每个目录只经 `index.ts` 导出第 3.4 节的接口；Lease 等内部类型不导出 |
| 依赖规则 | ESLint `no-restricted-imports` 禁止跨组件导入内部文件，纳入 `pnpm run check` |
| 按需注入 | 组合根只把第 3.4 节的接口交给各组件：Execution 只拿到 `CoreSyscalls`，拿不到 Core 对象；Monitor、Scheduler 拿不到任何其他组件 |
| 运行时私有 | Lease、账本等状态以 ES 私有字段保存，接口返回冻结的只读值 |
| 持久化隔离 | 各组件使用自己的存储命名空间；Lease 不写入审计与日志 |
| 架构测试 | `packages/testing` 的架构测试断言导入规则与调用方向 |

### 3.3 调用关系

| 调用方 → 被调用方 | 形式 | 内容 |
|---|---|---|
| Gateway → Core | Fabric（`GatewayForward`） | 外部 syscall |
| Supervisor → Core | Fabric（`ExecutionFactSink.report`） | 执行事实，作为消息进入运行 actor |
| Execution → Supervisor | 待发送 | `SupervisorPort.execute` |
| Core → Supervisor、Gateway | 待发送 | `SupervisorPort.cancelRun`、`SupervisorPort.shutdown`、`AdmissionProjection` |
| 运行 actor → Execution | 函数调用 | `handleExecutionFact`：分派执行事实，用量与违规经 Execution 的结果检查交给 Core |
| Core → Monitor、Scheduler、Execution | 职责接口（函数调用） | 第 3.4 节 |
| Execution → Core | 内部 syscall（函数调用） | 申请预留、提交结果检查、申请重试 |
| Monitor、Scheduler → Core | 只通过返回值 | 额度或机会不足以拒绝结果返回，异常以返回值表达 |
| Execution → Monitor、Scheduler；Monitor ↔ Scheduler；Monitor、Scheduler → Execution | 不允许 | — |
| 任何组件 → 其他组件的私有状态 | 不允许 | — |

Monitor 只在被 Core 调用时运行，不接收任何组件的直接上报；Executor 与 Supervisor 的用量、违规等事实随执行事实进入运行 actor，
由 Core 在处理中调用 Monitor。

### 3.4 Kernel 私有接口

以下接口只在 `packages/kernel` 内使用，不进入 contracts。`reservationId`（前缀 `rsv`）由 Monitor 生成，
`grantId`（前缀 `grt`）由 Scheduler 生成，二者都不跨出 Kernel 核心。

```ts
// Execution → Core：内部 syscall
interface CoreSyscalls {
  requestReservation(request: { unitAttemptId: string; estimatedTokens: number; final: boolean }): ReservationDecision;
  submitResultCheck(check: ResultCheck): void;                     // 同步函数，返回值不是 Promise
  retryExecution(request: { unitAttemptId: string; previousExecutionId: string;
                            requestState?: RequestState }): RetryDecision;
  currentRunEpoch(): number;                                       // 只读值
}

type ReservationDecision =
  | { granted: true; reservationId: string; grantId: string }
  | { granted: false; reason: 'BUDGET_WRAP_UP' | 'BUDGET_EXHAUSTED' | 'FINAL_CALL_USED'      // Core 已交付 UnitReport
                             | 'RUN_CONVERGING' };                                         // 尝试随 RunClosed 结束

type RetryDecision =
  | { allowed: true; reservationId?: string; grantId?: string }   // MODEL 时带新的预留与机会
  | { allowed: false; reason: 'RUN_CONVERGING' | 'RETRY_LIMIT' | 'REQUEST_MAY_BE_SENT'
                              | 'BUDGET_WRAP_UP' | 'BUDGET_EXHAUSTED' };                       // 额度类：Core 已交付 UnitReport

interface ResultCheck {
  unitAttemptId: string;
  executionId?: string;                                            // 派发前结束时为空
  outcome: ExecutionOutcome | 'NOT_DISPATCHED';
  reasonCode?: ReasonCode;
  output?: UnitOutput;
  outputRef?: ArtifactRef;
  usage?: TokenUsage;
  requestState?: RequestState;
  stopVerdictBy?: 'SUPERVISOR' | 'CORE';                           // STOP_UNCONFIRMED 的判定来源
}

// Core → Execution：职责接口；handleExecutionFact 例外，由运行 actor 的 dispatch 调用
interface ExecutionDuties {
  createAttempt(spec: AttemptSpec): Promise<string>;              // 返回 unitAttemptId，进入 FIFO 并在空闲时启动
  handleExecutionFact(fact: ExecutionFact): Promise<void>;        // 运行 actor 收到 EXECUTION_FACT 时调用，不经 Core
  abortQueued(): { inFlight: { unitAttemptId: string; executionId: string }[] };
  synthesizeStopUnconfirmed(executionIds: string[]): void;        // 收敛兜底：Core 判定的停止未确认
  ownsArtifact(ref: ArtifactRef): boolean;
  readArtifact(ref: ArtifactRef): Promise<{ ok: true; text: string } | { ok: false }>;
  collectUnknownEffects(): UnknownEffect[];
  modelRequestCount(): number;                                     // 派发给 Supervisor 的 MODEL 执行实例数，含技术重试
  publishRunSummary(summary: RunSummary): Promise<ArtifactRef>;
}

interface AttemptSpec {
  requestId: string;
  agentRunId: string;
  unit: UnitDefinition;
  input: UnitInput;
  scope: ExecutionScope;                                           // Core 派生
  pinned: PinnedDefinitionSet;                                     // 该 AgentRun 的固定定义
  runEpoch: number;
}

// Core → Monitor：职责接口
interface MonitorDuties {
  reserve(request: { estimatedTokens: number; final: boolean }):
    { ok: true; reservationId: string } | { ok: false; reasonCode: 'BUDGET_WRAP_UP' | 'BUDGET_EXHAUSTED' };
  settle(reservationId: string, settlement: Settlement): BudgetState;   // 以 reservationId 幂等
  budgetState(): BudgetState;
  finalize(): BudgetSummary;                                       // 把未结算的预留按未知消耗结算
}

type Settlement = { type: 'ACTUAL'; usage: TokenUsage } | { type: 'NOT_SENT' } | { type: 'UNKNOWN' };

interface BudgetSummary {
  limit: number; used: number; unknown: number;
  inputTokens: number; outputTokens: number; finalBudgetState: BudgetState;
}

// Core → Scheduler：职责接口
interface SchedulerDuties {
  acquire(provider: string): { ok: true; grantId: string } | { ok: false };
  release(grantId: string): void;                                  // 幂等
  stopGranting(): void;
  releaseAll(): number;
}

// Scheduler → 跨运行容量（Port）
interface ProviderCapacityPort {                                   // M1 为进程内实现，每个 provider 容量为 1
  tryAcquire(provider: string): string | null;                     // 返回令牌
  release(token: string): void;
}

// 运行管理：实现 GatewayForward 的处理器与 ExecutionFactSink
interface RunRegistry {
  handleForward(forward: GatewayForward): Promise<SyscallAck | SyscallRejected | RunCreated | ArtifactContent>;
  report(fact: ExecutionFact): Promise<void>;
}
```

## 4. 运行管理与运行 actor

### 4.1 运行管理

- **创建**：只有 `createRun` 能创建 actor。运行管理按 `requestId` 幂等处理：系统正在关闭或本进程已经创建过运行时返回
  `RUN_LIMIT`；`repositoryPath` 不是绝对路径、不存在、不是目录，或其 realpath 与系统数据目录互相包含时返回 `REPOSITORY_INVALID`。
  通过后建立空 actor（只建状态，不开始计时），向其控制通道投递 `RUN_INIT`，登记待发送 `AdmissionProjection(RUNNING)`，
  返回 `RunCreated`。
- **分发**：按 `workflowRunId` 把 `GatewayForward` 与 `ExecutionFact` 投递给对应 actor。找不到 actor 时：有墓碑则按 CLOSED 处理
  （第 4.5 节），否则返回 `RUN_NOT_FOUND`（执行事实只写入审计）。不隐式创建 actor。
- **回收**：actor 进入 CLOSED 后通知运行管理；运行管理在该 actor 的 Outbox 投递完毕后才可将其移出，并留下墓碑。
  M1 一个进程只有一个运行，回收在关闭系统时进行（第 7 节）。

### 4.2 运行 actor 的构成

| 部分 | 内容 |
|---|---|
| 邮箱 | 控制通道与工作通道两个队列 |
| 处理循环 | 一次只处理一条消息：`while (message = 取下一条（控制通道优先）) { await dispatch(message); await core.settleConvergence(); }`；两步合起来是一次处理 |
| 状态 | Core 分块（控制状态、runEpoch、AgentRun 登记、Lease、授权记录、请求记录、Outbox、待发送、计时器）、Execution 分块（尝试、FIFO、产物归属索引、上下文构建记录）、Monitor 分块（账本、预留）、Scheduler 分块（本运行持有的机会） |

`dispatch` 把 `EXECUTION_FACT` 交给 `Execution.handleExecutionFact`，其余消息交给 Core 的处理函数。
`core.settleConvergence()` 是 Core 的收尾步骤：本次处理中登记了收敛时，在这里完成需要调用 Execution 或等待 I/O 的部分（第 6 节）；
没有登记时立即返回。

### 4.3 消息

| kind | 通道 | 来源 | 处理者 |
|---|---|---|---|
| `RUN_INIT` | 控制 | 运行管理 | Core |
| `CANCEL_RUN` | 控制 | UserInteraction（`cancelRun`）、运行管理（`shutdown`） | Core |
| `AUTHORIZATION_ANSWER` | 控制 | UserInteraction | Core |
| `RUN_TIMEOUT` | 控制 | Core 定时器 | Core |
| `AUTHORIZATION_TIMEOUT` | 控制 | Core 定时器 | Core |
| `CONVERGENCE_DEADLINE` | 控制 | Core 定时器 | Core |
| `KERNEL_FAULT` | 控制 | actor 之外的发送器 | Core |
| `EXECUTION_FACT`（outcome 为 TERMINATED、VIOLATION、STOP_UNCONFIRMED） | 控制 | Supervisor | Execution |
| `REGISTER_AGENT_RUN`、`SUBMIT_UNIT`、`END_AGENT_RUN`、`CLOSE_RUN` | 工作 | Workflow | Core |
| `EXECUTION_FACT`（outcome 为 COMPLETED、REJECTED、FAILED） | 工作 | Supervisor | Execution |
| `READ_ARTIFACT` | 工作 | UserInteraction | Core |

消息按类型分配通道；同一来源在同一通道内保持顺序。Gateway 在入队前完成契约、调用方与准入封锁检查，被拒的请求不进入邮箱。

### 4.4 处理规则

1. **不可重入**：一条消息处理完（处理函数的 Promise 结束）之前，不开始处理下一条。控制通道的优先只在两条消息之间生效，
   不打断正在处理的消息。新消息到达时只入队。
2. **I/O 分两类**：
   - 本地 I/O 可以在处理函数中 `await`：读取目录定义（`CatalogPort`）、读写 ArtifactStore、写入 `runs/<workflowRunId>/`。
     由于不可重入，等待期间该运行的队列整体暂停。
   - 跨主体 I/O 一律不在处理函数中等待：`SupervisorPort` 调用、`AdmissionProjection`、Outbox 投递。处理函数只登记为待发送，
     处理结束后由 actor 之外的发送器发出。每个目标一个发送器：Supervisor、Gateway、Workflow 的 Inbox、UserInteraction 的 Inbox
     各一个，按登记顺序依次发出，前一个返回后才发下一个；Outbox 的 `seq` 即该接收方的登记顺序。
     因此同一运行的 `SupervisorPort.execute` 一定先于其后登记的 `SupervisorPort.cancelRun` 到达 Supervisor。
   - 发送失败（只可能是契约缺陷，如 Schema 校验不通过）不重试：发送器把失败写入审计，跳过该消息继续发送后续消息，
     并向控制通道投递 `KERNEL_FAULT`。Core 处理 `KERNEL_FAULT` 时，运行为 RUNNING 则以 `FAILED(KERNEL_INTERNAL)` 进入收敛，否则只写入审计。
     RunClosed、RunFinished 本身发送失败时只写入审计。
3. **结果检查同步**：`CoreSyscalls.submitResultCheck` 是同步函数，“核对 runEpoch”与“放入 Outbox”之间不可能插入 `await`。
   Core 在同步的内部 syscall（`requestReservation`、`submitResultCheck`、`retryExecution`）中不回调 Execution、不等待 I/O：
   需要收敛时只执行第 6 节第 ① 步中不涉及 Execution 的部分并登记收敛，其余部分由 `settleConvergence` 在同一次处理的末尾完成。
   Execution 在内部 syscall 返回后若发现 runEpoch 已变（`currentRunEpoch()`），不再取下一个队首。
4. **定时器只入队**：定时器回调只向控制通道投递对应消息，不直接修改运行状态。
5. **响应**：Gateway 转发的请求，其响应是处理函数的返回值，在本次处理结束时返回。同一次处理中放入 Outbox 的事件可能先于该响应到达接收方。
6. **持久化**：M1 不按消息持久化运行状态，没有“状态持久化后再发送”的步骤；只有审计与运行摘要写入存储。

### 4.5 运行状态与各请求的处理

运行控制状态：`RUNNING → CONVERGING → CLOSED`，只能前进。

| 消息 | RUNNING | CONVERGING | CLOSED |
|---|---|---|---|
| `REGISTER_AGENT_RUN`、`SUBMIT_UNIT` | 处理 | `RUN_BLOCKED` | `RUN_BLOCKED` |
| `END_AGENT_RUN` | 处理 | SyscallAck，无效果 | SyscallAck，无效果 |
| `CLOSE_RUN` | 进入收敛 | SyscallAck，无效果 | SyscallAck，无效果 |
| `CANCEL_RUN` | 进入收敛（CANCELLED） | SyscallAck，无效果 | SyscallAck，无效果 |
| `AUTHORIZATION_ANSWER` | 处理 | `QUESTION_NOT_PENDING` | `QUESTION_NOT_PENDING` |
| `READ_ARTIFACT` | 处理 | 处理 | 处理，直到系统关闭 |
| `RUN_TIMEOUT` | 进入收敛（RUN_TIMEOUT） | 忽略，写入审计 | 忽略 |
| `AUTHORIZATION_TIMEOUT` | 处理 | 忽略 | 忽略 |
| `CONVERGENCE_DEADLINE` | — | 收敛兜底（第 6 节） | 忽略 |
| `KERNEL_FAULT` | 进入收敛（FAILED(KERNEL_INTERNAL)） | 写入审计 | 写入审计 |
| `EXECUTION_FACT` | 处理 | 只结算与记录（第 6 节） | 作为证据写入审计 |

结束原因以先进入收敛者为准。唯一例外：收敛中收到 `VIOLATION` 事实时，`closeReason` 升级为 VIOLATION，`failure` 改为该违规，
`reportRef` 不再交付。

`CLOSE_RUN` 在 RUNNING 时先按 `requestId` 去重（同第 5.1 节第 1 步）；`outcome = COMPLETED` 时再经 `Execution.ownsArtifact`
核对 `reportRef`，不属于本运行返回 `INVALID_ARTIFACT_REF`，运行保持 RUNNING。核对通过后才进入收敛。

## 5. 一次 submitUnit 的内部路径

### 5.1 受理与定义核验

Core 处理 `SUBMIT_UNIT`，依次检查，任一不通过即返回 `SyscallRejected`，不建立尝试：

1. `requestId` 已记录：内容相同返回原响应，不同返回 `REQUEST_CONFLICT`。
2. 运行不在 RUNNING：`RUN_BLOCKED`。
3. AgentRun 未登记或不属于该运行：`AGENT_RUN_NOT_FOUND`；已结束：`AGENT_RUN_ENDED`。
4. `unitRef` 不在该 AgentRun 固定集合的 `units` 中（id、version、digest 全部相同）：`FORBIDDEN`。
5. executionKind 为 `FILE_WRITE`、`COMMAND`、`TEST`：`UNSUPPORTED_CAPABILITY`。
6. `input` 不符合 Unit 的 `inputContract`：`INVALID_INPUT`。

通过后记录请求，本次处理结束时返回 `SyscallAck`；此后该请求恰好得到一个 UnitReport，或随 RunClosed 结束。

M1 目录不含 executionKind 为 `FILE_WRITE`、`COMMAND`、`TEST` 的 Unit，真实目录下这类请求先在第 4 步得到 `FORBIDDEN`；
第 5 步由使用 fake 目录的测试覆盖。模型提出的写入、命令或测试动作不对应任何工具，在 Workflow 的 Validation 中以 `UNKNOWN_TOOL` 拒绝。

### 5.2 权限

| Unit 的受保护能力 | 处理 |
|---|---|
| 无 | Core 派生范围（`MODEL` 或 `NONE`），调用 `Execution.createAttempt` |
| `repo.read`，授权已同意 | 签发或复用 Lease，派生 `REPOSITORY` 范围，调用 `createAttempt` |
| `repo.read`，授权已拒绝或超时 | 交付 `UnitReport(REJECTED, USER_DECLINED)`，不建立尝试 |
| `repo.read`，授权询问中 | 挂起该请求，等待同一结果 |
| `repo.read`，尚无授权 | 建立授权记录，Outbox 发出 `AuthorizationRequest`，启动询问计时，挂起该请求 |

授权回答或超时后，挂起的请求按到达顺序处理：同意则依次 `createAttempt`，拒绝或超时则依次交付 `USER_DECLINED`。
Lease 与授权规则见 [Core](Core.md) 第 4 节。

### 5.3 执行

```text
createAttempt → FIFO（按 createAttempt 的调用顺序）
  → Execution 空闲时取队首
  → 解析输入中的 ArtifactRef（M1Interface 6.1 的三个位置）
       不属于本运行 → submitResultCheck(NOT_DISPATCHED, INVALID_ARTIFACT_REF)
  → REPORT_PUBLISH：Execution 内建完成（Execution 第 5 节）→ submitResultCheck
  → MODEL：核对 ContextPack 与 final 一致：operation 为 ASSEMBLE，且 tokenBudget 等于 final ? finalInputBudget : perCallInputLimit
       不一致 → submitResultCheck(NOT_DISPATCHED, INVALID_INPUT)
     估算 est = estimatePackTokens(ContextPack) + max_tokens → requestReservation
       Core：finalCallUsed 检查 → Scheduler.acquire → Monitor.reserve
       被拒 → Core 交付 UnitReport(REJECTED, BUDGET_* 或 FINAL_CALL_USED)，尝试结束
  → 生成 executionId，登记待发送 SupervisorPort.execute(ExecutionRequest)
  → …… Supervisor 交回 ExecutionFact，作为新消息进入邮箱
  → Execution.handleExecutionFact
       FAILED 且 retryable 且未达上限 → retryExecution → 允许则以新 executionId 重新派发（带退避 notBefore）
       COMPLETED 且运行仍为 RUNNING → 把 result.artifact 写入 ArtifactStore，登记归属，得到 outputRef
       VIOLATION → 隔离输出，不写入
  → submitResultCheck → Core 结果检查（第 5.4 节）
  → Execution 取下一个队首
```

FIFO 只约束执行的推进顺序；取消、停止等控制处理经控制通道，不受 FIFO 阻塞。前一个尝试提交结果检查后才启动下一个。

### 5.4 结果检查

Core 在 `submitResultCheck` 中同步完成：

1. 核对归属：尝试属于本运行，`executionId` 是该尝试当前的执行实例；受保护 Unit 的 Lease 仍有效。不一致的结果写入审计后丢弃。
2. MODEL：按下表结算并释放调用机会；`STOP_UNCONFIRMED` 不释放机会，留到收敛第 ③ 步。
3. VIOLATION：进入收敛（VIOLATION），`failure = { code: 违规原因码, category: 'INTEGRITY', source: 'KERNEL', unitRequestId }`；
   运行为 RUNNING 时收到 STOP_UNCONFIRMED：进入收敛（FAILED），`failure.code = EXECUTION_STOP_UNCONFIRMED`。
4. 按下表形成 UnitReport，附 `Monitor.budgetState()`。
5. 尝试建立时的 runEpoch 等于当前 runEpoch 且运行为 RUNNING：UnitReport 放入 Outbox；否则不交付，计入 `notDelivered`。

| ExecutionOutcome | 交付的 UnitReport | MODEL 的结算 |
|---|---|---|
| `COMPLETED` | `OK`，带 output 与 outputRef | 有用量按 `ACTUAL`，否则 `UNKNOWN` |
| `REJECTED` | `REJECTED`，原因码不变 | `NOT_SENT` |
| `FAILED` | `FAILED`，原因码不变 | 按 `requestState`：`NOT_SENT` → `NOT_SENT`；`SENT` 且有用量 → `ACTUAL`；其他 → `UNKNOWN` |
| `TERMINATED`（`UNIT_TIMEOUT`） | `FAILED(UNIT_TIMEOUT)` | 同 FAILED |
| `TERMINATED`（`EXECUTION_CANCELLED`） | 只出现在收敛中，不交付 | 同 FAILED |
| `VIOLATION` | 不交付 | `UNKNOWN` |
| `STOP_UNCONFIRMED` | 不交付 | `UNKNOWN` |
| `NOT_DISPATCHED` | `REJECTED`，原因码不变 | 无预留 |

`requestState = UNKNOWN` 且未完成的 MODEL 执行记为 `MODEL_REQUEST_UNCONFIRMED`；任何 STOP_UNCONFIRMED 记为
`EXECUTION_STOP_UNCONFIRMED`，二者进入 `unknownEffects`。

## 6. 收敛

正常结束（`closeRun`）、用户取消、运行超时、安全违规与 Kernel 异常共用以下三步。
触发来源：`CLOSE_RUN`（COMPLETED 或 FAILED）、`CANCEL_RUN`（CANCELLED）、`RUN_TIMEOUT`（RUN_TIMEOUT）、
`KERNEL_FAULT` 与 `requestReservation` 中的内部错误（FAILED(KERNEL_INTERNAL)）、
结果检查中的 VIOLATION（VIOLATION）与 STOP_UNCONFIRMED（FAILED）。

每一步都在一次处理内完成，并分为两段：“登记”只改 Core 自己的状态、调用 Scheduler 与登记待发送，可以在同步的内部 syscall 中执行；
“收尾”调用 Execution 或等待 I/O，只在 `settleConvergence` 中执行（第 4.4 节第 3 条）。

**① 开始收敛**：

- 登记：
  1. 记录 `closeReason`、`failure`、`reportRef`（只有 COMPLETED）；运行状态改为 CONVERGING；runEpoch 加 1；
     登记待发送 `AdmissionProjection(CONVERGING)`；停止运行总时长计时。
  2. 授权询问仍在进行时改为 CANCELLED：挂起的请求不再交付 UnitReport，Outbox 发出 `AuthorizationResolved(CANCELLED)`，停止询问计时。
  3. `Scheduler.stopGranting()`：不再发放新机会，不收回在途机会。
- 收尾：
  4. `Execution.abortQueued()`：清空 FIFO，未启动的尝试不交付 UnitReport；返回在途执行集合，记为 pending。
  5. pending 不为空：登记待发送 `SupervisorPort.cancelRun`（携带新的 runEpoch），启动收敛兜底计时（`cancelGraceMs + convergenceMarginMs`）。
     pending 为空：接着执行第 ③ 步。

**② 收敛中**（逐条处理消息，处理方式见第 4.5 节）：

- 属于 pending 的执行事实：Execution 不重试、不写产物，直接提交结果检查；Core 只做第 5.4 节的第 1–3 步（结算、释放机会、记录效果），
  因 runEpoch 已变而不交付。VIOLATION 使 `closeReason` 升级。处理后从 pending 删除；删空时登记第 ③ 步，由本次处理的 `settleConvergence` 执行。
- `CONVERGENCE_DEADLINE`：对 pending 中剩余的执行调用 `Execution.synthesizeStopUnconfirmed`（判定来源为 CORE），按未知消耗结算，执行第 ③ 步。

**③ 完成收敛**（全部在收尾段执行）：

1. `Monitor.finalize()` 得到 `BudgetSummary`；全部 AgentRun 标记为 ENDED；Lease 与授权记录失效；`Scheduler.releaseAll()`。
2. `unknownEffects = Execution.collectUnknownEffects()`。
3. Core 组装 `RunSummary`（控制状态、AgentRun 与 `units` 来自 Core，`tokens` 来自 `BudgetSummary`，
   `model.requests` 来自 `Execution.modelRequestCount()`，`model.finalCallUsed` 来自 Core 的 final-call 记录），
   调用 `Execution.publishRunSummary` 写成产物，得到 `runSummaryRef`。
4. Core 向审计追加 `RUN_CLOSED`。
5. Outbox 放入 `RunClosed`（Workflow）与 `RunFinished`（UserInteraction），二者内容相同（M1Interface 5.3）。
6. 运行状态改为 CLOSED，登记待发送 `AdmissionProjection(CLOSED)`，通知运行管理。

此后再到的执行事实只作为证据写入审计，不改动已发出的 RunClosed。

## 7. 关闭系统

```text
UserInteraction → shutdown → Gateway → 运行管理
  → 标记正在关闭（此后 createRun 返回 RUN_LIMIT），返回 SyscallAck
  → 对每个不在 CLOSED 的 actor 投递 CANCEL_RUN，按第 6 节收敛
  → 等全部 actor 为 CLOSED，且各自 Outbox 投递完毕
  → SupervisorPort.shutdown → Supervisor 协调 ModuleHost 按序关闭（见 ModuleHost）
```

actor 必须在 Supervisor 卸载模块之前排空，否则 RunClosed 可能还在 Outbox 中而 Fabric 已经关闭。
关闭顺序见 [ModuleHost](../Infrastructure/ModuleHost.md) 第 2 节。

## 8. panic 与安全停机

panic 只用于可信基础或关键安全不变量已无法维持的情况。普通工具失败、权限拒绝或 Provider 错误不触发 panic。
除 Core 内部的受控维护逻辑外，绕过 syscall 访问 Lease，或外部主体绕过 Gateway 执行内核操作，均属于权限边界失守。
M1 以模块边界、私有字段与端口分离使这类访问在结构上不可达；架构测试负责证明这一点。

M1 的安全停机就是收敛：违规以 VIOLATION 收敛，Kernel 内部不变量被破坏时以
`closeRun` 同样的流程按 `FAILED(KERNEL_INTERNAL)` 收敛。不能仅凭 Executor 自报触发 panic。
进程崩溃时不保证收敛步骤执行，M1 不提供自动故障恢复、透明续跑或高可用。

## 9. 配置（`KernelConfig`）

组合根加载系统配置后，把 `kernel` 部分交给 Kernel。

| 配置 | 读取者 | 建议初值 |
|---|---|---|
| `provider` | Core、组合根校验 | `deepseek` |
| `runTimeoutMs` | Core | 1800000 |
| `authorizationTimeoutMs` | Core | 300000 |
| `cancelGraceMs` | Supervisor、Core | 5000 |
| `convergenceMarginMs` | Core | 1000 |
| `technicalRetryLimit` | Execution、Core | 3 |
| `retryBackoffBaseMs` | Execution | 1000（第 n 次重试等待 `1000 × 2^(n−1)` 毫秒） |
| `repositoryExclusions` | Core | `[]`（追加到默认排除规则之后） |
| `maxSnapshotFiles` | Execution | 20000 |
| `maxReportBytes` | Execution | 262144 |
| `budget` | Monitor、Execution | 见 [Monitor](Monitor.md) 第 4 节 |
| `executionLimits` | Execution | 见下表 |

| executionKind | `timeoutMs` | `maxOutputBytes` |
|---|---|---|
| `REPOSITORY_ORIENT` | 60000 | 1048576 |
| `REPOSITORY_SEARCH` | 30000 | 1048576 |
| `FILE_READ` | 10000 | 16384 |
| `CONTEXT_ASSEMBLE` | 30000 | 2097152 |
| `MODEL` | 180000 | 1048576 |

数值均需用固定任务集校准。

## 10. 待设计事项

| 主题 | 需要明确的内容 |
|---|---|
| 数值 | `tokenLimit` 与第 9 节各项数值的评测校准 |
| 记录与验证 | 审计条目的完整字段、验证场景及验收证据的格式 |

本阶段不规定多进程与 IPC、并行调度、强隔离、暂停/恢复和崩溃续跑的后续交付排期。

## 11. 为后续演进保留的实现约束

M1 是单进程、串行执行，但实现必须守住以下约束，使 Supervisor 独立成进程、执行并行与 Kernel 核心分片不需要改动 Kernel 核心的结构：

1. 通讯主体之间只传可序列化数据，跨主体不抛出异常，一律返回结构化结果。
2. Kernel 核心与 Supervisor 只经 `SupervisorPort` 与 `ExecutionFactSink` 协作，取消以消息表达。
3. 运行状态以 `workflowRunId` 为键；运行管理的注册表是唯一的跨运行结构，只保存映射与生命周期，不保存运行状态。
4. 跨运行的资源只经 Port 获取：Scheduler 的调用机会经 `ProviderCapacityPort` 申请与归还。
5. 原子性只在运行 actor 的一次消息处理内成立，不依赖跨通讯主体的同步执行。
6. Kernel 核心内的组件只经第 3.4 节的接口交互，按第 3.2 节的方式隔离各自的数据。
