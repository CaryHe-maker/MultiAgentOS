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
2. 服务：fabric 就绪后注册 `SupervisorPort` 的处理器，开始接受 `execute`、`cancelRun` 与 `shutdown`。

模块的构造与依赖注入由组合根完成，Supervisor 只决定启动与停止的顺序。

## 3. 与 Kernel 核心的接口

```text
Execution（待发送）→ SupervisorPort.execute(ExecutionRequest)
Core（待发送）     → SupervisorPort.cancelRun({ workflowRunId, runEpoch })
运行管理           → SupervisorPort.shutdown({ requestId })
Supervisor         → ExecutionFactSink.report(ExecutionFact)
```

- 字段定义见 [M1Interface](../M1Interface.md) 第 7 节。`workflowRunId`、`unitAttemptId`、`executionId`、`runEpoch` 原样带回；
  执行事实作为消息进入所属运行的邮箱，由 Core 核对 runEpoch 后决定是否接受。
- 取消由 Core 决定并以消息发出，不跨边界传递运行时句柄；进程内实现在 Supervisor 内部把它转换为 `AbortSignal`。

## 4. 执行实例

```text
ACCEPTED（等待 notBefore）→ RUNNING ─┬→ COMPLETED / REJECTED / FAILED / VIOLATION（Executor 返回）
         │                           ├→ TERMINATED（截止时间或取消后，宽限期内结束）
         │                           └→ STOP_UNCONFIRMED（宽限期内未结束）
         └→ TERMINATED（启动前被取消，无 startedAt）
```

- `execute` 受理即返回，到 `notBefore`（缺省立即）后启动 Executor。
- 到达 `limits.deadline`：触发中止信号，原因码 `UNIT_TIMEOUT`。收到 `cancelRun`：对该运行全部执行实例触发中止信号，原因码
  `EXECUTION_CANCELLED`，尚未启动的实例直接以 TERMINATED 结束；并记录该运行的取消 runEpoch。
- 此后到达的 `execute`，若属于已取消的运行且 `runEpoch` 小于记录的取消 runEpoch，不启动 Executor，直接上报
  `TERMINATED(EXECUTION_CANCELLED)`（无 `startedAt`）。Kernel 核心的发送器按登记顺序发出（Interaction 4.4），正常情况下不会出现这种到达顺序，
  此规则是兜底。
- 宽限期为 `KernelConfig.cancelGraceMs`，从触发中止信号的时刻起算。Executor 在宽限期内返回：上报 `TERMINATED`，
  `requestState` 沿用 Executor 返回的值（MODEL 缺失时为 `UNKNOWN`）；未返回：上报 `STOP_UNCONFIRMED`，此后该实例的任何返回都被丢弃。
- 每个 `executionId` 恰好上报一个终态：执行先完成还是先被终止，由 Supervisor 给出唯一结论。

## 5. 信任与上报

Supervisor 是可信的 Kernel 组件。M1 只运行可信的内置 Executor，Executor 交回的结果、用量与违规可以作为依据；
违规由 Supervisor 上报，Execution 隔离输出，Core 以 VIOLATION 收敛。不能仅凭 Executor 自报触发 panic。

## 6. 关闭与失控任务

- 收到 `shutdown` 后，Supervisor 按 [ModuleHost](../Infrastructure/ModuleHost.md) 第 2 节的顺序停止模块，Fabric 最后停止；
  随后终止残留子进程、清理临时文件并退出。此时全部运行 actor 已收敛完毕（[Interaction](Interaction.md) 第 7 节）。
- 进程内执行依赖 Executor 响应中止信号，Supervisor 不能强制终止同一进程中的失控代码，也不能在所在进程卡死或崩溃后继续监管；
  无法确认停止的执行以 `STOP_UNCONFIRMED` 报告，相关效果标记为未知。需要强制终止的行为（如 `rg`）以子进程运行。

## 7. 配置

| 配置 | 读取者 | 建议初值 |
|---|---|---|
| `KernelConfig.cancelGraceMs` | Supervisor、Core | 5000 |
