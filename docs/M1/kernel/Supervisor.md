# MultiAgentOS M1 Kernel.Supervisor

## 1. 定位

Supervisor 是独立的通讯主体，直接管理执行载体：负责系统生命周期，以及 Executor 的派发、装配、
截止时间、终止与回收，并把执行事实上报给 Kernel 核心。组件间交互见 [Interaction](Interaction.md)，
长期规划见 [Supervisor 架构](../../Architecture/kernel/Supervisor.md)。

M1 为单进程部署：Supervisor 与 Kernel 核心同进程，Executor 在进程内运行，但 Supervisor 与 Kernel 核心之间
只按第 3 节的可序列化接口协作，后续独立成进程时接口不变。仓库检索使用的 `rg` 作为子进程运行，
由 Supervisor 启动并在取消或截止时间到达时终止。

## 2. 维护的数据与职责

职责按“谁使用数据谁维护”划分。

| 类别 | Supervisor 维护的数据 | M1 职责 |
|---|---|---|
| 系统生命周期 | 模块生命周期、启动与关闭顺序 | 协调 ModuleHost 完成装配、依赖就绪与按序卸载（关闭顺序见 [ModuleHost](../infrastructure/ModuleHost.md)）；启动时清理上次遗留的临时数据 |
| 执行实例 | 执行实例、截止时间、宽限期与终态 | 按 `executionKind` 找到 Executor，装配并注入范围约束、限制与受控依赖；截止时间到达时终止；宽限期内未确认停止时报告 `STOP_UNCONFIRMED`；每个执行实例只上报一个终态 |
| 子进程与残余 | `rg` 等子进程、临时文件 | 终止并回收子进程，清理每次执行的临时文件 |

以下数据不由 Supervisor 维护：尝试状态与执行队列（Execution）、runEpoch、准入封锁与运行总时长（Core）、
额度（Monitor）、调用机会（Scheduler）。是否接受执行结果由 Core 决定。

M1 不实现心跳、子进程健康判断、进程池与工作区准备，这些在 Supervisor 独立成进程后引入。

## 3. 与 Kernel 核心的接口

```text
Execution  → Supervisor   execute(attemptId, runEpoch, executionKind, input, scope, limits)
Core       → Supervisor   cancel(attemptId) / cancelRun(workflowRunId)
Supervisor → Kernel 核心   fact(attemptId, runEpoch, outcome, output, usage, effects)
```

- `outcome` 为 `COMPLETED`、`REJECTED`、`FAILED`、`TERMINATED`、`VIOLATION` 或 `STOP_UNCONFIRMED`。
- 每个执行实例只上报一个终态：执行先完成还是先被终止，由 Supervisor 给出唯一结论。
- `attemptId` 与 `runEpoch` 原样带回；执行事实作为消息进入所属运行的队列，由 Core 核对 runEpoch 后决定是否接受。
- 取消由 Core 决定并以消息发出，不跨边界传递运行时句柄；M1 的进程内实现在 Supervisor 内部把它转换为中止信号。

字段定义见 [M1Interface](../M1Interface.md) §7。

## 4. 信任与上报

Supervisor 是可信的 Kernel 组件。M1 只运行可信的内置 Executor，Executor 交回的结果、用量与违规可以作为依据；
违规由 Supervisor 上报，Execution 隔离输出，Core 停止运行（`VIOLATION`）。

## 5. 关闭与失控任务

M1 的关闭限于停止新执行、尽力结束在途任务及程序资源释放，不实现崩溃恢复。
进程内执行依赖 Executor 响应中止信号，Supervisor 不能强制终止同一进程中的失控代码，
也不能在所在进程卡死或崩溃后继续监管；无法确认停止的任务以“停止未确认”报告，相关效果标记为未知。
需要强制终止的行为（如 `rg`）以子进程运行。

## 6. 配置项

| 配置 | 位置 | 读取者 | 建议初值 |
|---|---|---|---|
| 取消宽限期 | 系统配置 | Supervisor | 待定 |
