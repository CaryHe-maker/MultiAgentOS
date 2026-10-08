# MultiAgentOS M1 Kernel 内部交互

## 1. 目的与范围

本文规定 M1 Kernel 六组件之间的交互：通讯主体与模块化隔离、内部 syscall、Unit 的内部执行路径、运行停止、收敛与 panic。
各组件的职责见同目录下的组件文档，Kernel 对外提供的 syscall 与返回信息见
[Kernel（外部视角）](../module/Kernel.md)，长期规划见 [Kernel 架构](../../Architecture/module/Kernel.md)。

| 组件 | M1 职责 |
|---|---|
| [Gateway](Gateway.md) | 统一申请入口与准入 |
| [Core](Core.md) | 授权、租约、控制裁决与运行计时 |
| [Scheduler](Scheduler.md) | API 调用机会 |
| [Monitor](Monitor.md) | 资源账本与额度控制 |
| [Supervisor](Supervisor.md) | 系统生命周期；Executor 的派发、装配、截止时间、终止与回收；上报执行事实 |
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

### 3.1 通讯主体

Kernel 对外是一个 Module，以 Gateway 为唯一入口；对内由三个通讯主体组成：

| 通讯主体 | 组成 | M1 实现 |
|---|---|---|
| Kernel 核心 | Core、Monitor、Scheduler、Execution，模块化单体 | 单个实例，不分片 |
| Supervisor | Supervisor 及其管理的 Executor | 与 Kernel 核心同进程；Executor 在进程内运行，`rg` 以子进程运行 |
| Gateway | Gateway | 逻辑独立，与 Kernel 核心同进程 |

Kernel 核心内部以内部 syscall 与职责接口调用协作；Kernel 核心与 Supervisor、Gateway 之间只交换可序列化数据。
通讯主体与调用形式见 [Communication](../infrastructure/Communication.md)。

### 3.2 运行 actor 与消息队列

Kernel 核心为每个 WorkflowRun 维护一个运行 actor，按顺序逐条处理该运行的消息，同一时刻只处理一条：

| 通道 | 消息 | 处理顺序 |
|---|---|---|
| 控制通道 | 取消、授权回答、关闭系统、运行超时、Supervisor 上报的终止或违规 | 优先处理 |
| 工作通道 | `registerAgentRun`、`submitUnit`、`endAgentRun`、`closeRun`、Supervisor 交回的执行事实、读取产物 | 控制通道为空时处理 |

- 消息按类型而非来源分配通道；同一来源在同一通道内保持顺序。
- Core 与 Monitor 的定时器到点也以消息进入队列，不在定时器回调中直接修改运行状态。
- 处理一条消息时，Kernel 核心以内部 syscall 与职责接口调用同步完成检查与状态修改，不等待外部 I/O；
  执行交给 Supervisor，等待用户回答只记录待回答状态，执行事实与回答作为新消息返回。
- Supervisor 对每个执行实例只上报一个终态；Core 依据 runEpoch 决定是否接受，迟到或过期的执行事实只作为证据保存。
- Gateway 在入队前完成契约与准入封锁检查，被拒的请求不进入队列。

### 3.3 Kernel 核心内部的模块化隔离

Core、Monitor、Scheduler、Execution 同进程、同通讯主体，但各自的数据按模块隔离，
Execution、Monitor、Scheduler 不能直接读写 Core 的信息。数据归属与调用方向见
[Kernel 架构](../../Architecture/module/Kernel.md) 3.4，M1 按以下方式落实：

| 约束 | M1 实现 |
|---|---|
| 运行状态分块 | 运行 actor 的状态按组件分为 Core、Execution、Monitor、Scheduler 四块，处理消息时每个组件只拿到自己的一块 |
| 模块边界 | `packages/kernel` 下按组件分目录，每个目录只经 `index.ts` 导出接口类型；Lease 等内部类型不导出 |
| 依赖规则 | 用 ESLint 的 `no-restricted-imports` 禁止跨组件导入内部文件，纳入 `pnpm run check` |
| 按需注入 | 组合根只把需要的接口交给各组件，例如 Execution 只拿到 Core 的内部 syscall 接口（申请预留、提交结果检查、上报违规），拿不到 Core 对象 |
| 运行时私有 | Lease、账本等状态以 ES 私有字段保存，接口返回冻结的只读值 |
| 持久化隔离 | 各组件使用自己的存储命名空间；Lease 只保存在 Core 的命名空间，不写入日志 |
| 架构测试 | `packages/testing` 的架构测试断言导入规则与调用方向 |

| 请求关系 | 定义 |
|---|---|
| 外部 syscall | UserInteraction、Workflow 经 Gateway 向 Core 请求 Kernel 服务 |
| 内部 syscall | Kernel 核心其他组件向 Core 发起的请求（申请预留、提交结果检查、上报异常等） |
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
            → Execution 把 executionKind、输入、范围约束与限制交给 Supervisor → Supervisor 执行并交回执行事实
            → 内部 syscall 提交结果检查；Core 核对结果，model-call 调用 Monitor 结算
            → Core 核对 runEpoch，将 UnitReport 放入 Outbox → 投递到 Workflow 的 Inbox
  → Workflow 作业务判断，结束或提交后续 UnitIntent
```

- 预留与结算见 [Monitor](Monitor.md)，权限检查与结果检查见 [Core](Core.md)。
- Core 交付前核对 UnitAttempt 建立时的 runEpoch；不一致则不交付，结果只作为证据保存（见 [Core](Core.md) 第 5 节）。
- FIFO 约束执行请求的推进顺序；取消、停止、Exception 等控制处理经控制通道优先处理，不受 FIFO 阻塞。
- 重复请求、重复结果和迟到结果不得导致重复执行、重复结算或重新推进业务。

产物引用的归属检查见 [Execution](Execution.md) 第 3 节。

## 5. AgentRun 登记

```text
UserInteraction → Gateway 生成 workflowRunId → Core：创建运行并建立运行 actor
  → Core 开始运行总时长计时 → Outbox：RunStart → Workflow
Workflow → registerAgentRun → Gateway 准入 → Core 读取定义并核对 digest，登记为 ACTIVE → SyscallAck
```

## 6. 运行超时

额度不足不停止运行，只拒绝 model-call 的预留（见 [Monitor](Monitor.md)）。运行总时长由 Core 计时，到点时：

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
  → Execution 清空 FIFO；Core 通知 Supervisor 取消本运行的在途执行，Supervisor 终止并回收子进程与临时文件
  → Core 调用 Scheduler 释放调用机会
  → Core 调用 Monitor 完成最终结算，取得用量摘要
  → 全部 AgentRun 标记为 ENDED，Lease 与用户授权记录失效
  → Core 停止运行总时长计时
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
| 执行与控制 | 技术重试的错误分类、单次调用的中断细节、取消宽限期 |
| 生命周期与故障 | panic 判定边界与安全停机通路、用户通知 |
| 记录与验证 | 运行记录与审计的具体格式、验证场景及验收证据 |

本阶段不规定多进程与 IPC、并行调度、强隔离、暂停/恢复和崩溃续跑的后续交付排期。

## 10. 为后续演进保留的实现约束

M1 是单进程、串行执行，但实现必须守住以下约束，使 Supervisor 独立成进程、执行并行与 Kernel 核心分片
不需要改动 Kernel 核心的结构（长期组织见 [Kernel 架构](../../Architecture/module/Kernel.md) 第 3 节）：

1. 通讯主体之间只传可序列化数据，跨主体不抛出异常，一律返回结构化结果。
2. Kernel 核心与 Supervisor 只经 [Supervisor](Supervisor.md) 第 3 节的接口协作，取消以消息表达。
3. 运行状态（Lease、账本、尝试、队列、runEpoch、Outbox）以 `workflowRunId` 为键，不存在跨运行的共享可变状态。
4. 跨运行的资源只经 Port 获取：Scheduler 的调用机会以“申请令牌、归还令牌”的接口提供。
5. 原子性只在运行 actor 的一次消息处理内成立，不依赖跨通讯主体的同步执行。
6. Kernel 核心内的组件只经职责接口与内部 syscall 交互，按 3.3 节的方式隔离各自的数据。
