# MultiAgentOS Kernel.Supervisor

## 1. 定位

Supervisor 是 Kernel 六组件之一，也是独立的通讯主体。它直接管理操作系统进程：
负责系统生命周期，以及 Executor 子进程的派发、装配、截止时间、终止、回收与健康，
并把执行事实上报给 Kernel 核心。

职责按“谁使用数据谁维护”划分：Supervisor 维护执行实例与进程相关的数据；
尝试状态、运行控制状态、结果是否接受与运行总时长由 Kernel 核心中的 Execution 与 Core 维护。
Supervisor 不维护执行队列，不作授权、额度或结果接受的裁决。

## 2. 维护的数据与职责

| 类别 | Supervisor 维护的数据 | 职责 |
|---|---|---|
| 系统生命周期 | 模块与进程的生命周期、启动与关闭顺序 | 协调 ModuleHost 按依赖装配与启动，全部就绪后开放入口；有序关闭时停止新工作、终止或排空在途执行，再关闭基础设施 |
| 执行实例 | 执行实例所在的子进程、截止时间、宽限期与终态 | 按行为与信任等级选择子进程，装配行为并注入范围约束与限制；到达截止时间时终止；在宽限期内确认停止；对每个执行实例只上报一个终态 |
| 进程与宿主 | 子进程、进程组、资源限制、心跳与健康 | 启动、限制、终止与回收子进程；判断健康，剔除失联或多次违规的子进程或宿主 |
| 残余 | 临时目录、工作区与遗留进程 | 每次执行结束后回收；启动时清理上次遗留的进程与临时数据 |

范围约束由 Core 依据 Lease 派生、随执行请求交给 Supervisor；Supervisor 不持有 Lease。

## 3. 与 Kernel 核心的协作

```text
Execution  → Supervisor   execute(attemptId, runEpoch, 行为, 输入, 范围约束, 限制)
Core       → Supervisor   cancel(attemptId) / cancelRun(workflowRunId) / 关闭
Supervisor → Kernel 核心   fact(attemptId, runEpoch, 终态, 输出, 用量, 效果)
Kernel 核心 ↔ Supervisor   心跳
```

从 Supervisor 看，一个执行实例的状态为：

```text
ACCEPTED → RUNNING ─┬→ COMPLETED / REJECTED / FAILED / VIOLATION
                    ├→ TERMINATED（因截止时间或取消被终止）
                    └→ STOP_UNCONFIRMED（宽限期内未能确认停止，效果未知）
```

- 每个执行实例只上报一个终态。进程先完成还是先被终止，由 Supervisor 依据操作系统事实给出唯一结论。
- `attemptId` 与 `runEpoch` 原样带回；是否接受结果由 Core 核对运行控制状态版本后决定，过期结果只作为证据。
- 取消由 Core 决定并以消息发给 Supervisor，不跨进程传递运行时句柄。
- 执行事实作为消息进入所属运行的队列，由 Kernel 核心的运行 actor 按顺序处理。
- Kernel 核心与 Supervisor 互相以心跳检测存活：Supervisor 失联时，Kernel 核心把在途尝试标记为效果未知；
  Kernel 核心失效时，Supervisor 终止并回收其执行，必要时重新拉起 Kernel 核心。

## 4. Executor 子进程

Executor 子进程是 Supervisor 启动的执行载体，只与 Supervisor 通信。子进程内的薄封装层接收执行请求、
注入依赖、运行 ExecutorSet 中的行为并交回结果。

| 信任等级 | 行为 | 进程策略 |
|---|---|---|
| 可信 | 模型调用、仓库读取与检索、上下文处理、产物发布 | 可以常驻复用；每次执行不保留状态；凭据只提供给确实需要的行为 |
| 不可信 | 文件修改、命令执行、测试 | 每次尝试一个子进程，最多在同一运行内复用隔离环境；不跨运行复用；默认不提供凭据与网络 |

Executor 子进程不持有 Lease、额度账本或运行状态，不写入 ArtifactStore 的正式产物，
不直接与 Kernel 核心、Workflow 或 UserInteraction 通信。

## 5. 信任与上报

Supervisor 是可信的 Kernel 组件，它上报的执行事实可以作为依据。对 Executor 子进程：

- 执行可信行为时，子进程交回的结果、用量与违规可以采信；
- 执行不可信行为时，Supervisor 只采信自己从子进程外部观察到的事实（退出状态、终止、超时、资源用量）
  与经校验的输出，子进程内的自报不能单独触发 panic。

## 6. 演进

单进程部署时，Supervisor 可以与 Kernel 核心同进程，Executor 也可以在进程内运行，
但 Supervisor 与 Kernel 核心之间仍按第 3 节的可序列化接口协作，取消以消息表达。
Supervisor 独立成进程后，Executor 改在其子进程中运行；跨主机部署时，Supervisor 按节点部署。
