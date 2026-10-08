# MultiAgentOS M1 Kernel 内部交互

## 1. 目的与范围

本文规定 M1 Kernel 六组件之间的交互：内部 syscall、Unit 的内部执行路径、运行停止、收敛与 panic。
各组件的职责见同目录下的组件文档，Kernel 对外提供的 syscall 与返回信息见
[Kernel（外部视角）](../module/Kernel.md)，长期规划见 [Kernel 架构](../../Architecture/module/Kernel.md)。

| 组件 | M1 职责 |
|---|---|
| [Gateway](Gateway.md) | 统一申请入口与准入 |
| [Core](Core.md) | 授权、租约与控制裁决 |
| [Scheduler](Scheduler.md) | API 调用机会 |
| [Monitor](Monitor.md) | 资源账本与额度控制 |
| [Supervisor](Supervisor.md) | 系统生命周期与执行任务监管 |
| [Execution](Execution.md) | 尝试、执行队列与产物发布 |

## 2. 术语

| 术语 | 定义 |
|---|---|
| runEpoch | 运行控制状态的版本号，每次控制状态变化加 1，用于防止判定与交付之间的竞态 |
| 终止信号 | Core 结束 Kernel 内部等待中的调用时给出的信号，不携带任何结果 |
| Outbox | Core 维护的事件出口，按接收方与 `seq` 顺序向 Workflow、UserInteraction 的 Inbox 投递 |

## 3. 组织与 syscall

系统仅设 UserInteraction、Workflow、Kernel 三个 Module。Execution 纳入 Kernel；
上下文算法归 ExecutorSet，所需运行状态归 Execution，不再设置独立 ContextEngine。
各类状态仍只有一个权威写入 Owner，不因同处一个进程而开放内部状态的跨模块修改。
通讯主体与调用形式见 [Communication](../infrastructure/Communication.md)。

| 请求关系 | 定义 |
|---|---|
| 外部 syscall | UserInteraction、Workflow 经 Gateway 向 Core 请求 Kernel 服务 |
| 内部 syscall | Kernel 其他组件向 Core 发起的请求（申请预留、提交结果检查、上报异常等） |
| 职责接口调用 | Core 处理请求时调用 Monitor、Scheduler、Execution 的职责接口；不属于 syscall |

外部模块与独立基础设施的受保护服务、执行及控制请求统一通过 Gateway 移交 Core。
内部组件向 Core 发起请求无需绕回 Gateway，但仍须校验调用身份与职责权限。
观测数据可直接交给 Monitor；影响账本或权限状态的事实（如用量结算）必须随内部 syscall 交给 Core。

## 4. 一次 submitUnit 的内部路径

```text
Workflow → submitUnit → Gateway 准入
  ├─ 被拒 → AdmissionException
  └─ 通过 → Core：SyscallAck → 定义核验 → 权限检查（受保护 Unit）
       ├─ 被拒 → Core 交付 UnitReport
       └─ 通过 → Execution：建立 UnitAttempt，进入 FIFO
            → model-call：内部 syscall 申请预留，Core 调用 Scheduler 与 Monitor
              （预留被拒 → Core 交付 UnitReport(BUDGET_WRAP_UP 或 BUDGET_EXHAUSTED)）
            → 提交 executionKind、参数、范围约束、限制 → Supervisor 装配并执行 → 交回事实
            → 内部 syscall 提交结果检查；Core 核对结果，model-call 调用 Monitor 结算
            → Core 核对 runEpoch，将 UnitReport 放入 Outbox → 投递到 Workflow 的 Inbox
  → Workflow 作业务判断，结束或提交后续 UnitIntent
```

- 预留与结算见 [Monitor](Monitor.md)，权限检查与结果检查见 [Core](Core.md)。
- Core 交付前核对 UnitAttempt 建立时的 runEpoch；不一致则不交付，结果只作为证据保存（见 [Core](Core.md) 第 5 节）。
- FIFO 约束执行请求的推进顺序，不阻塞取消、停止、Exception 和查询等控制处理。
- 重复请求、重复结果和迟到结果不得导致重复执行、重复结算或重新推进业务。

产物引用的归属检查见 [Execution](Execution.md) 第 3 节。

## 5. AgentRun 登记

```text
UserInteraction → Gateway → Core：创建运行 → Core 启动运行总时长计时（经 Supervisor）→ Outbox：RunStart → Workflow
Workflow → registerAgentRun → Gateway 准入 → Core 读取定义并核对 digest，登记为 ACTIVE → SyscallAck
```

## 6. 运行超时

额度不足不停止运行，只拒绝 model-call 的预留（见 [Monitor](Monitor.md)）。运行超时由 Supervisor 报告：

```text
Core 设置准入封锁(RUN_TIMEOUT)，runEpoch 加 1，通知 Gateway
  → 以终止信号结束 Kernel 内部等待中的调用（不携带结果，不交付 Workflow）
  → 收敛（第 7 节）→ RunClosed(RUN_TIMEOUT) → Workflow 停止推进
  → UserInteraction 显示"运行超时，已停止"
  → 关闭系统（见 ModuleHost）
```

安全违规（`VIOLATION`）与用户取消（`CANCELLED`）同样进入第 7 节的收敛过程。
超时、违规与取消触发时，Core 以终止信号结束 Kernel 内部等待中的调用，不再向 Workflow 交付该 Unit 的结果。

## 7. 收敛过程

取消/停止必须区分请求收到、接受与实际生效。正常结束（`closeRun`）、超时、取消与违规
共用同一收敛过程：

```text
Core 设置准入封锁，runEpoch 加 1
  → Execution 清空 FIFO；在途任务经 Supervisor 中止
  → Core 调用 Scheduler 释放调用机会
  → Core 调用 Monitor 完成最终结算，取得用量摘要
  → 全部 AgentRun 标记为 ENDED，Lease 与用户授权记录失效
  → 通知 Supervisor 停止运行总时长计时
  → Core 把运行记录的执行部分与审计记录写入 runs/<runId>/
  → Core 将 RunClosed 放入 Outbox，并向 UserInteraction 投递 RunFinished
```

runEpoch 加 1 之后，旧尝试的结果不再进入 Outbox；此前已入队的 UnitReport 按顺序先于 RunClosed 投递。
未知效果不得被标记为成功或直接自动重跑。

## 8. panic 与安全停机

panic 仅用于可信基础或关键安全不变量已无法维持的情况，普通工具失败、权限拒绝或 Provider
错误不直接触发全局 panic。除 Core 内部受控维护逻辑外，绕过 Syscall 访问 Lease，或外部主体
绕过 Gateway 的受保护入口执行内核操作，均属于权限边界失守；经可信边界确认后立即拒绝并进入 panic 处置。
Lease 正常过期、撤销或权限不足仅返回拒绝，不触发 panic。不能仅凭 Executor 自报触发 panic。

突然崩溃不保证停机步骤全部执行，不能依赖崩溃后的 Kernel 发出最终通知。
M1 不提供自动故障恢复、透明续跑或高可用。

## 9. 待设计事项

| 主题 | 需要明确的机制 |
|---|---|
| 组织与通信 | ModuleHost 装配顺序、各主体的消息契约与超时 |
| 调度与账本 | tokenLimit、finalReserve、wrapUpMargin、每轮输入上限等数值 |
| 执行与控制 | 技术重试的错误分类、单次调用的中断细节 |
| 生命周期与故障 | panic 判定边界与安全停机通路、用户通知 |
| 记录与验证 | 运行记录与审计的具体格式、验证场景及验收证据 |

本阶段不规定多进程与 IPC、并行调度、强隔离、暂停/恢复和崩溃续跑的后续交付排期。
