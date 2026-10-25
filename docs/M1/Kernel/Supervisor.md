# MultiAgentOS M1 Kernel.Supervisor

## 1. 定位

Supervisor 是独立的通讯主体，直接管理执行载体：负责系统生命周期，以及 Executor 的派发、装配、截止时间、终止与回收，
并把执行事实上报给 Kernel 核心。组件间交互见 [Interaction](Interaction.md)，长期规划见 [Supervisor 架构](../../Architecture/Kernel/Supervisor.md)。

M1 为单进程部署：Supervisor 与 Kernel 核心同进程，Executor 在进程内运行，但 Supervisor 与 Kernel 核心之间只经
`SupervisorPort` 与 `ExecutionFactSink` 协作，后续独立成进程时接口不变。仓库检索使用的 `rg` 作为子进程运行，
由 Supervisor 启动并在取消或截止时间到达时终止。

## 2. 维护的数据与职责

职责按“谁使用数据谁维护”划分。

| 类别 | Supervisor 维护的数据 | M1 职责 |
|---|---|---|
| 系统生命周期 | 模块生命周期、启动与关闭顺序 | 第一个启动、最后一个退出；驱动 ModuleHost 按依赖启动与按序停止其余模块（[ModuleHost](../Infrastructure/ModuleHost.md) 第 2 节）；启动时清理上次遗留的临时数据 |
| 执行实例 | `executionId →` `workflowRunId`、`unitAttemptId`、`runEpoch`、`notBefore`、截止时间、状态、中止控制器；已取消运行的取消 runEpoch | 按 `executionKind` 从组合根注入的 Executor 注册表（`createExecutorRegistry()` 的结果）取得 Executor，注入 `ExecutorEnvironment`；到截止时间或取消时中止；宽限期内未结束时报告 `STOP_UNCONFIRMED`；每个执行实例只上报一个终态 |
| 子进程与残余 | `rg` 子进程、临时文件 | 终止并回收子进程，清理每次执行的临时文件 |
| 凭据 | 无（只转交） | 经 `ProviderCredentials` 把配置边界读到的 API Key（如 `DEEPSEEK_API_KEY`）只交给 model-call Executor |

以下数据不由 Supervisor 维护：尝试状态与执行队列（Execution）、runEpoch、准入封锁与运行总时长（Core）、
额度（Monitor）、调用机会（Scheduler）。是否接受执行结果由 Core 决定。

M1 不实现心跳、子进程健康判断、进程池与工作区准备，这些在 Supervisor 独立成进程后引入。

Supervisor 的启动分为两段：

1. 引导：组合根调用 `start()` 后，Supervisor 清理临时数据，驱动 ModuleHost 依次启动
   fabric、artifact-store、persistence、kernel-core、gateway、workflow、user-interaction。这一段不依赖通信。
2. 服务：fabric 就绪后注册 `SupervisorPort` 的处理器；全部模块就绪后才接受请求。
   执行派发与取消必须真实执行或明确拒绝，不得返回占位的成功结果。

模块的构造与依赖注入由组合根完成，Supervisor 只决定启动与停止的顺序。
工厂 `createSupervisor`、`SupervisorDeps`、`ModuleHostControl` 与 `SupervisorModule.whenStopped()` 的定义见
[M1Interface](../M1Interface.md) 第 14.1 节。

`SubprocessRunner` 已实现为 `supervisor/subprocess-runner.ts` 的 `createSubprocessRunner()`：只运行 `rg`，以参数数组启动、不经 shell；
`signal` 触发或输出超过 `maxOutputBytes` 时终止子进程；二进制不存在或无法启动时以 `exitCode: null` 返回，不抛出异常。
它由 `@multiagentos/kernel` 导出，供 Supervisor 注入 `ExecutorEnvironment`，也供 ExecutorSet 的测试直接使用。

## 3. 与 Kernel 核心的接口

```text
Execution（待发送）→ SupervisorPort.execute(ExecutionRequest)
Core（待发送）     → SupervisorPort.cancelRun({ workflowRunId, runEpoch })
运行管理           → SupervisorPort.shutdown({ requestId })
Supervisor         → ExecutionFactSink.report(ExecutionFact)
```

- 字段定义见 [M1Interface](../M1Interface.md) 第 7 节。`workflowRunId`、`unitAttemptId`、`executionId`、`runEpoch` 原样带回；
  执行事实作为消息进入所属运行的运行 Inbox，由 Core 核对 runEpoch 后决定是否接受。
- 执行事实沿用 `execute` 请求的 `correlationId`，只用于追踪，不参与裁决。Supervisor 不需要为此新增公共协议或
  第二套事实通道。
- 事实投递失败不改变执行终态，也不触发执行重试；Supervisor 记录诊断，不重复投递同一 `executionId` 的事实。
- 取消由 Core 决定并以消息发出，不跨边界传递运行时句柄；进程内实现在 Supervisor 内部把它转换为 `AbortSignal`。

## 4. 执行实例

```text
ACCEPTED（等待 notBefore）→ RUNNING ─┬→ COMPLETED / REJECTED / FAILED / VIOLATION（Executor 返回）
         │                           ├→ TERMINATED（截止时间或取消后，宽限期内结束）
         │                           └→ STOP_UNCONFIRMED（宽限期内未结束）
         └→ TERMINATED（启动前被取消，无 startedAt）
```

- `execute` 只登记并返回，启动由请求处理之外的调度完成，不得在 handler 内同步运行 Executor。
  到 `notBefore`（缺省立即）后启动 Executor。
- 执行表以 `executionId` 为键，记录请求、状态、`startedAt`、`endedAt`、中止原因与定时器；
  重复 `executionId` 只保留第一次受理。
- 到达 `limits.deadline`：触发中止信号，原因码 `UNIT_TIMEOUT`。收到 `cancelRun`：对该运行全部执行实例触发中止信号，
  原因码 `EXECUTION_CANCELLED`，尚未启动的实例直接以 TERMINATED 结束；并记录该运行的取消 runEpoch。
- 中止由第一个触发者决定原因：先到 deadline 为 `UNIT_TIMEOUT`，先到 `cancelRun` 为 `EXECUTION_CANCELLED`；
  后续触发不改变原因、不重置宽限期。
- 此后到达的 `execute`，若属于已取消的运行且 `runEpoch` 小于记录的取消 runEpoch，不启动 Executor，直接上报
  `TERMINATED(EXECUTION_CANCELLED)`（无 `startedAt`）。Kernel 核心的发送器按登记顺序发出（Interaction 4.4），
  正常情况下不会出现这种到达顺序，此规则是兜底。
- 宽限期为 `KernelConfig.cancelGraceMs`，从触发中止信号的时刻起算。Executor 在宽限期内返回：上报 `TERMINATED`，
  `requestState` 沿用 Executor 返回的值（MODEL 缺失时为 `UNKNOWN`）；未返回：上报 `STOP_UNCONFIRMED`，此后该实例的
  任何返回都被丢弃。
- 宽限期内 Executor 返回 `VIOLATION` 时，Supervisor 上报 `VIOLATION` 而不是 `TERMINATED`，避免安全证据被取消或
  超时路径吞掉；其他结果仍按上一条上报 `TERMINATED`。
- Executor 抛错、执行注册表缺失或 `executionKind` 不一致时，形成唯一的 `FAILED(INTERNAL, retryable = false)` 事实；
  MODEL 的 `requestState` 按 `UNKNOWN` 处理。不得把原始异常跨主体抛出。
- 执行事实只由 Supervisor 产生一次。MODEL 的 `COMPLETED` 的 `requestState` 为 `SENT`；其他结果使用 Executor 给出的值，
  缺失时 `REJECTED` 记 `NOT_SENT`，其余记 `UNKNOWN`；启动前取消记 `NOT_SENT`。
  MODEL 的 `TERMINATED` 与 `FAILED` 在 Executor 给出 `usage` 时保留；非 MODEL 结果一律丢弃 `usage` 与 `requestState`。
- `STOP_UNCONFIRMED` 使用中止原因，保留 `startedAt`，不带 `usage`；此后的 Executor 返回一律丢弃。
- 执行环境按 `executionKind` 最小化：只有 MODEL 取得 `ProviderCredentials`，只有 REPOSITORY_SEARCH 取得真实
  `SubprocessRunner`；其他执行拿到拒绝式实现。`scope`、`limits`、`signal` 与 `now` 始终提供。
- 每个 `executionId` 恰好上报一个终态：执行先完成还是先被终止，由 Supervisor 给出唯一结论。

## 5. 信任与上报

Supervisor 是可信的 Kernel 组件。M1 只运行可信的内置 Executor，Executor 交回的结果、用量与违规可以作为依据；
违规由 Supervisor 上报，Execution 隔离输出，Core 以 VIOLATION 收敛。不能仅凭 Executor 自报触发 panic。

任务收敛属于 Core 的非停机异常处理；系统 panic 由组合根控制（[Interaction](Interaction.md) 第 8 节）。
Supervisor 在任务收敛中的职责是：收到 `cancelRun` 后对该运行的
全部执行实例触发中止信号，在宽限期内给出每个实例的终态，未能确认的以 `STOP_UNCONFIRMED` 上报；不自行决定停机，也不修改运行状态。

## 6. 关闭与失控任务

- 收到 `shutdown` 后，Supervisor 按 [ModuleHost](../Infrastructure/ModuleHost.md) 第 2 节的顺序停止模块，Fabric 最后停止；
  随后终止残留子进程、清理临时文件并退出。此时全部运行 actor 已收敛完毕（[Interaction](Interaction.md) 第 7 节）。
- `stop()` 可重复调用并共用同一次执行，停止失败经 `whenStopped()` 以拒绝表达，不报告为完成。
  故障关闭时由组合根直接调用它（[错误与系统故障处理](../SystemFaultHandling.md) 第 5 节）；
  Supervisor 不裁决系统故障，也不决定进程退出码。
- `stop()` 先封锁新执行、中止全部在途执行并清理定时器；对已启动但未确认停止的执行，以
  `EXECUTION_CANCELLED` 为中止原因尽力上报 `STOP_UNCONFIRMED`，不等待宽限期或事实投递完成，
  再按顺序停止模块并回收子进程。正常路径没有在途执行，不应因此产生额外事实。
- 子进程在创建时登记到 `SubprocessRunner` 的存活集合，`killAll()` 同步终止全部存活子进程。
  runner 由组合根构造并经 `SupervisorDeps.subprocess` 注入，组合根因此能在 Supervisor 不可用时终止子进程。
- 进程内执行依赖 Executor 响应中止信号，Supervisor 不能强制终止同一进程中的失控代码，也不能在所在进程卡死或崩溃后继续监管；
  无法确认停止的执行以 `STOP_UNCONFIRMED` 报告，相关效果标记为未知。需要强制终止的行为（如 `rg`）以子进程运行。

## 7. 配置

| 配置 | 读取者 | 建议初值 |
|---|---|---|
| `KernelConfig.cancelGraceMs` | Supervisor、Core | 5000 |

## 8. panic 协作与启动期限

Supervisor 不持有第二套 panic 状态，不接管 uncaughtException 或 unhandledRejection。
单次执行抛错转换为唯一 `FAILED(INTERNAL, retryable = false)` 事实，运行语义由 Core 裁决。
自身引导或停止失败通过调用结果及 whenStopped 上报组合根，由唯一 panic 控制流程处理。

panic 中 stop 不得假设 Core 已完成收敛：先封锁新执行，对残余执行发出中止，
按 ModuleHost 规则停止模块并清理子进程和临时资源。已经关闭的运行结果不得改写。
无法确认进程内执行停止时保留未知事实，由组合根最终退出；不得报告虚假的执行成功。

ModuleHost 的每模块启动和 afterStart 有期限，组合根另约束 Supervisor 引导总期限。
启动超时或开始停止后不得继续启动后续模块，迟到完成不得令 ready 重新为 true。
这些是待实现目标；当前生命周期代码不等于已完成启动超时与 panic 联调。
