# M1 错误、Exception 与系统故障处理

> 状态：已评审并定稿，2026-10-11。第 8 节列出已经实现和尚未实现的部分；
> 未实现的部分随 [M1 实现计划](M1-kernel-infra-plan.md) 的 P06、P08、P10 落地。
> 本文与 [Interaction](M1/Kernel/Interaction.md)、[ModuleHost](M1/Infrastructure/ModuleHost.md)、
> [Supervisor](M1/Kernel/Supervisor.md) 不一致时，以这三份规范为准并修正本文。

## 1. 范围与界限

M1 是单进程、单活动运行的系统。Supervisor、Core、UserInteraction 等是同一 Node 进程内的模块，
不是可由操作系统逐个监视的进程；只有 `rg` 是子进程。因此：

- 进程内的处理只在事件循环仍能运行时有效；事件循环卡死或进程崩溃后，没有任何进程内机制能提供保证。
- M1 不恢复崩溃前未完成的运行，也不承诺崩溃后生成正常的 RunFinished。
- 没有完成的清理或结果交付不得报告为成功；无法确认的效果按未知记录。

本文回答四个问题：错误分哪几级、每一级由谁处理、四个角色各自的权限、关闭怎样保证完成。

## 2. 四级分类与升级

分界线不是“业务还是系统”，而是“是不是契约的一部分”。契约内的结果用返回值或消息表达；
只有缺陷和不变量被破坏才用 `throw`，而且 `throw` 不跨通讯主体（Interaction 第 11 节第 1 条）。

| 级别         | 含义                                             | 例子                                                                                         | 形式                       | 处理主体                   |
| ------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------- | -------------------------- |
| L0 结果      | 契约内的预期分支，不是异常                       | SyscallRejected、UnitReport(REJECTED/FAILED)、ExecutionFact(FAILED)、结算异常、额度不足      | 返回值或消息               | 契约的接收方               |
| L1 Exception | 运行无法正常继续，但运行 actor 仍可信            | 运行超时、安全违规、停止未确认、处理函数抛错、发送器契约失败（[Kernel](M1/Module/Kernel.md) 第 11 节） | 控制通道消息               | Core，按收敛三步结束该运行 |
| L2 系统故障  | 无法归属某个运行，或处理 L1 的机制自身失效       | 模块启停失败、Fabric 或存储不可用、收敛过程抛错、Inbox 处理器崩溃、命令入口抛错              | 进程内函数 `reportFault`   | 组合根的系统控制           |
| L3 进程级    | 进程内状态已不可信                               | `uncaughtException`、`unhandledRejection`、事件循环卡死、进程崩溃                            | —                          | 最后防线退出；进程外是用户 |

L1 沿用现行规范的 Exception 一词，不新造术语。L1、L2、L3 是升级阶梯：
**处理某一级时再次失败，升到上一级，不在同级重试。** 例如 Core 处理 `KERNEL_FAULT` 时收敛过程抛错，
不再投递第二个 `KERNEL_FAULT`，而是调用 `reportSystemFault`；系统控制的关闭步骤超时，不重做该步骤，
而是进入下一步，最终以非零退出码结束。

故障的去向由**捕获位置**静态决定，不由某个协调者在运行时判断“Core 是否还能处理”：
外部无法核实 Core 的状态是否可信。运行 actor 内捕获的走 L1；其他位置捕获的走 L2。
L2 的关闭总是先请求 Core 收敛并等待一个期限，超时即继续强制停止，Core 能否处理由期限回答。

### 2.1 不经过 Core 的错误

Core 只对运行终态有权威，不是所有错误的必经之路。

| 发生位置                                   | 处理主体                                                         | 是否经 Core            |
| ------------------------------------------ | ---------------------------------------------------------------- | ---------------------- |
| CLI 参数、系统配置、目录加载               | CLI 与组合根；此时模块尚未构造或启动                             | 否                     |
| 缺失或非法 `requestId` 的传输契约错误      | Fabric 抛给发送方，属于发送方的缺陷                              | 否                     |
| 畸形 syscall、调用方不符、准入封锁         | Gateway 结构化拒绝                                               | 否                     |
| Executor 抛错、超时、不响应中止、`rg` 崩溃 | Supervisor 转成该执行实例唯一的 ExecutionFact                    | 作为 L0 事实进入       |
| 模块 `start()`、`stop()` 失败              | ModuleHost 回滚并记账，Supervisor 上抛，组合根决定退出码         | 否                     |
| 运行 actor 处理函数抛错、发送器失败        | actor 循环捕获，投递 `KERNEL_FAULT`                              | 是，L1                 |
| 收敛过程自身抛错                           | 升级：`reportSystemFault`                                        | 否，Core 已不可信      |
| Workflow 发现自身内部错误                  | Workflow 调用 `closeRun(FAILED)`，原因码 `WORKFLOW_INTERNAL`     | 作为普通 syscall       |
| Workflow 连 `closeRun(FAILED)` 也无法完成  | 升级：Inbox 失败观察者调用 `reportSystemFault`                   | 仅被请求收敛（第 5 节） |
| Workflow 静默卡死                          | `RUN_TIMEOUT`                                                    | 是，L1                 |
| UserInteraction 的 Inbox 处理器、询问任务或命令抛错 | 系统控制；错误由组合根写到 stderr，因为 UserInteraction 可能已坏 | 仅被请求收敛（第 5 节） |

`health()` 只是调用时刻的快照，不是异步故障的通知，也不作为恢复路径。静默失败靠已有的期限发现：
Unit 截止时间、授权超时、运行总时长、收敛兜底，以及本文第 5 节的关闭期限。

### 2.2 捕获边界

`catch` 只出现在以下五处；其他位置不捕获，除非是把错误转成契约规定的返回值。

| 边界                                    | 捕获后                                                  | 状态         |
| --------------------------------------- | ------------------------------------------------------- | ------------ |
| 组合根入口 `main()` 与 `System.run`     | 记录系统故障，保证关闭，给出退出码                      | 已实现       |
| ModuleHost 的每次模块启停               | 记入账本，回滚或继续停其余模块，汇总抛出                | 已实现       |
| 运行 actor 的每条消息                   | 投递 `KERNEL_FAULT`；收敛中再失败则 `reportSystemFault` | P06、P10     |
| Supervisor 的每个执行实例               | 形成唯一终态事实，原因码 `INTERNAL`                     | P08          |
| Inbox、OrderedSender、定时器的失败观察者 | actor 内投递 `KERNEL_FAULT`；actor 外 `reportSystemFault` | P06 起接入   |

## 3. 四个角色

| 角色                 | 拥有的状态与决定                                                                 | 不得做的事                                   |
| -------------------- | -------------------------------------------------------------------------------- | -------------------------------------------- |
| ModuleHost           | 依赖顺序、逐模块生命周期账本、每次停止的期限与结果                               | 判断故障等级、决定是否关闭系统、重试失败的停止 |
| Supervisor           | 正常路径的启停顺序；执行实例、中止信号、`rg` 子进程；把 Executor 的一切结局转成事实 | 修改运行状态、裁决系统故障（它自己也可能失效） |
| Core                 | 运行状态 `RUNNING → CONVERGING → CLOSED`、结束原因、预算与授权；L1 的唯一处理者  | 宣称整个进程或 UserInteraction 健康          |
| 组合根的系统控制     | 关闭意图、各步期限、故障记录、进程退出码；L2 的唯一处理者                        | 持有或改写任何领域状态                       |

**组合根不是模块。** 它没有 `moduleId`，不注册进 ModuleHost，没有 Fabric 身份和 Inbox，不实现 `LifecyclePort`；
否则就要再回答“谁来启停和监管它”。`composeSystem` 返回的 `System` 是一个带少量运行期状态的进程级控制对象，
地位相当于 `main`。它受三条约束：

1. 只对自己构造的对象做直接函数调用，不发送 Fabric 消息。
2. 不持有、不改写运行状态、Lease、账本等领域状态。
3. 只决定三件事：何时开始关闭、每一步等多久、进程退出码。

实现位于 `apps/control-plane/src/bootstrap/system-control.ts`；`compose-system.ts` 仍只负责构造与注入。

## 4. 模块生命周期契约与 ModuleHost 账本

`LifecyclePort.stop()` 的契约：重复调用安全；在 `start()` 之前、中途失败之后调用也安全；只清理本模块已取得的资源。
模块在取得每项资源后登记释放动作，按逆序释放。ModuleHost 不了解模块内部的句柄、定时器或任务。

ModuleHost 为每个模块记录一个状态：

```text
REGISTERED → STARTING → READY → STOPPING → STOPPED
                 └→ START_FAILED ──────────┘      └→ STOP_FAILED（保留为证据，不重试）
```

- 某模块 `start()` 或其 `afterStart` 钩子失败时，**先停该失败模块**，再逆序停此前已启动的模块，然后抛出原始错误；
  回滚也失败时抛出同时包含两者的 `AggregateError`。回滚干净时主机可以再次启动。
- `stop()` 结束主机，此后 `start()` 被拒绝。并发与重复的 `stop()` 共用同一次执行。
- `start()` 进行中收到 `stop()`：正在启动的模块无法打断，等它结束后不再启动后续模块，随即回滚。
- 一个模块停止失败不跳过其余模块。配置了 `stopTimeoutMs` 时，超时的停止记为 `STOP_FAILED`（`STOP_TIMEOUT`）并继续。
- 只要账本里有 `STOP_FAILED`，`stop()` 就拒绝，重复调用得到同样的结果，不会再次调用该模块的 `stop()`。
- `ledger()` 返回每个模块的状态与错误，这是事实；是否退出进程由调用方决定。

## 5. 关闭路径

**正常关闭**（不变）：UserInteraction → `shutdown` → Gateway → Core 运行管理 → 运行收敛、Outbox 排空 →
`SupervisorPort.shutdown` → Supervisor 驱动 ModuleHost 逆序停止 → 终止残留子进程、清理临时目录。

**故障关闭**：任何位置调用 `reportFault`，或命令入口抛错、命令结束后系统未在期限内停止，都进入以下步骤。
每一步有期限；失败或超时只追加到同一故障记录，然后继续下一步。

```text
1. 记录故障，生成本次关闭唯一的 faultId，写 stderr
2. kernelCore.abortAllRuns({ faultId, deadlineMs })      期限 abortRunsMs
     Core 封锁新运行，向每个未 CLOSED 的运行的控制通道投递 KERNEL_FAULT
     RUNNING 的运行按 FAILED(KERNEL_INTERNAL) 收敛，faultId 写入 failure.detail 与审计
     全部运行 CLOSED 且 Outbox 排空后返回
3. supervisor.stop()                                     期限 stopMs
4. 第 3 步失败或超时：moduleHost.stop()                  期限 stopMs
5. 终止残留子进程
6. 汇总 StopReport { intent, faults, modules }
```

- `abortAllRuns` 是组合根专用的受控维护入口，不经 Gateway：故障关闭不能依赖 UserInteraction 发起 shutdown，
  它可能正是出故障的一方。该入口只交给组合根，不注册到 Fabric，不改变“外部主体必须经 Gateway”的规则。
- 结束原因复用 `FAILED(KERNEL_INTERNAL)`，`failure.source = KERNEL`，不新增原因码，也不改公共 Schema；
  真实来源由 `faultId` 关联到 stderr 与审计。运行已在 CONVERGING 或 CLOSED 时不改写其结束原因。
- 引导未完成时跳过第 2 步。此时没有运行，只需停止已启动的模块。
- 关闭意图由系统控制自己判定：Supervisor 只有两条停止路径（Core 的 shutdown 请求、被直接调用 `stop()`），
  系统控制没有发起过故障关闭且没有任何故障记录时，才是 `REQUESTED`；否则是 `FAULT`。
- UserInteraction 仍然可用时，它会收到这次收敛产生的 RunFinished 并照常展示；它不可用时用户只看到 stderr 的故障行。

**退出码**：

| 情况                                           | 退出码                                     |
| ---------------------------------------------- | ------------------------------------------ |
| 意图为 `REQUESTED`                             | UserInteraction 记录的退出码               |
| 意图为 `FAULT`，命令已返回非零退出码           | 该非零退出码                               |
| 意图为 `FAULT`，命令返回 0、抛错或没有返回     | 70（`EXIT_CODE_SYSTEM_FAULT`）             |
| 引导失败                                       | 70                                         |
| 未捕获异常、未处理的 Promise 拒绝              | 70，不尝试收敛                             |
| 组合阶段抛错（配置、目录、工厂）               | 70；此时没有模块被启动                     |
| 用户第二次按 Ctrl+C                            | 130，不尝试收敛（第 6 节）                 |

出现过系统故障的进程不会以 0 退出。

## 6. 子进程与失控执行

- 子进程在创建时登记到 `SubprocessRunner` 的存活集合。`killAll()` 是同步的，由 Supervisor 的 `stop()`、
  系统控制的关闭末尾、进程的 `exit` 钩子和最后防线调用。组合根自己持有这个 runner 并注入 Supervisor，
  因此不需要向可能已失效的 Supervisor 索取句柄。
- 进程内 Executor 不响应中止信号时无法被强制终止：超过宽限期记为 `STOP_UNCONFIRMED`，效果标记为未知，
  靠进程退出结束。
- 最后防线（`installProcessGuards`）在未捕获异常时只做三件事：写诊断、同步终止子进程、非零退出。
  此时进程内状态不可信，不调用 Core，也不等待任何异步清理。
- Ctrl+C 分两段，两段的主体不同。第一次属于 UserInteraction：它经 `TerminalPort.onInterrupt` 调用 `cancelRun`，
  运行按 CANCELLED 正常收敛，退出码 130；最后防线只计数，不做任何事。第二次属于最后防线：用户不再等待收敛，
  它写诊断、同步终止子进程、以 130 退出，同样不调用任何模块。尚未创建运行时第一次没有可取消的对象，
  用户再按一次即退出。`apps/cli` 的终端适配器只转发中断，不得自行退出进程。
- 事件循环卡死或进程崩溃由进程外处理。M1 的进程外监督者是启动它的用户或 shell；
  M1 不部署独立的监督进程。

## 7. 故障决策示例

| 情况                                    | 结果                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| 模块 `start()` 部分成功后抛错           | ModuleHost 停该模块及此前模块；系统未就绪；组合根以 70 退出                           |
| Provider 返回普通失败                   | L0：Execution 按重试规则处理，Core 交付 UnitReport，Workflow 决定业务结果             |
| 发送器遇到契约缺陷                      | L1：`KERNEL_FAULT`，运行按 `FAILED(KERNEL_INTERNAL)` 收敛，正常关闭，退出码 1         |
| 收敛过程中再次抛错                      | 升级到 L2：故障关闭；不保证 RunFinished；退出码 70                                    |
| 命令入口在运行中抛错                    | L2：`abortAllRuns` 使运行收敛，模块全部停止，退出码 70                                |
| UserInteraction 在 RunFinished 之后失败 | 运行结果不改写；记录系统故障；命令已返回非零码则保留，否则 70                         |
| RunSummary 写入失败                     | 现行 `finalizationError` 规则：不伪造引用，不改结束原因；属于 L1 内的已定义分支       |
| Core 在期限内没有完成 `abortAllRuns`    | 记录后继续停止模块；运行没有正常结束事件；退出码 70                                   |
| 模块 `stop()` 失败或超时                | 账本保留 `STOP_FAILED`，其余模块照常停止；不重试；即使运行已完成也不以 0 退出         |
| Supervisor 的 `stop()` 失败或超时       | 组合根直接调用 `moduleHost.stop()`，与进行中的停止共用同一次执行                      |
| 进程卡死或崩溃                          | 进程内不保证；由用户终止；下次启动只清空 `<dataDir>/tmp/`，不恢复运行                 |

## 8. 实现状态

| 内容                                                                              | 位置                                               | 状态     |
| --------------------------------------------------------------------------------- | -------------------------------------------------- | -------- |
| ModuleHost 账本、停止失败模块、启动中停止、停止期限、失败不重试                   | `packages/infrastructure/module-host`              | 已实现   |
| 系统控制：故障入口、有界故障关闭、关闭意图、退出码                                | `apps/control-plane/src/bootstrap/system-control.ts` | 已实现   |
| `main()` 保证关闭；最后防线                                                       | `apps/control-plane/src/index.ts`、`process-guards.ts` | 已实现   |
| 进程入口 `multiagentos`；第二次 Ctrl+C 强制退出                                   | `apps/control-plane/src/bin.ts`、`process-guards.ts` | 已实现   |
| 子进程存活集合与 `killAll()`；Supervisor 停止时调用                               | `packages/modules/kernel/src/supervisor`           | 已实现   |
| `KernelCoreModule.abortAllRuns`、`KernelCoreDeps.reportSystemFault` 的接口与注入  | `packages/modules/kernel/src/kernel-core.ts`       | 接口已定 |
| fake Kernel 的 `abortAllRuns`；fake Supervisor 如实报告停止失败                   | `packages/testing/src/fakes/fake-kernel.ts`        | 已实现   |
| 产品 Core 的 `abortAllRuns`、actor 捕获边界、`KERNEL_FAULT`、收敛失败后的升级     | Kernel 核心                                        | P06、P10 |
| Supervisor 每个执行实例的捕获边界、宽限期与 `STOP_UNCONFIRMED`                    | Supervisor                                         | P08      |
| 审计类型 `SYSTEM_FAULT_ABORT`                                                     | Core                                               | P10      |
| `SystemFault`、`SystemFaultReporter` 位于 contracts；`WorkflowDeps`、`UserInteractionDeps` 的 `reportSystemFault` 与注入 | `packages/libraries/contracts/src/ports.ts`、组合根 | 接口已定 |
| Workflow 与 UserInteraction 的捕获边界与上报                                      | 两个模块的产品实现                                 | 随模块实现 |

已定的接缝（2026-10-13），由 Workflow 与 UserInteraction 的产品实现落地：

- 上报函数的类型在 contracts 中，两个模块不依赖 Kernel 包；`WorkflowDeps` 与 `UserInteractionDeps` 各有可选的
  `reportSystemFault`，组合根注入的是与 Kernel 核心相同的入口（M1Interface 第 10、14.2 节）。
- Workflow 先以 `closeRun(FAILED, WORKFLOW_INTERNAL)` 结束运行，做不到才上报（[Workflow](M1/Module/Workflow.md) 11.1）；
  UserInteraction 在 Inbox 处理器、询问任务与中断处理三处直接上报（[UserInteraction](M1/Module/UserInteraction.md) 6.1）。
- 两个模块的 `stop()` 须满足第 4 节的契约。UserInteraction 只记录退出码，70 只由组合根产生。
- ExecutorSet 与 AgentToolPool 不受影响：Executor 不是模块，不持有上报函数。

其余事项：
- 进程入口是 `apps/control-plane/src/bin.ts`：它只调用 `main()` 并设置退出码，最后防线由 `main()` 安装。
  入口与进程信号归组合根；`apps/cli` 只做参数解析与终端适配，UserInteraction 只处理第一次中断（第 6 节）。
- M1 不处理 SIGTERM 等其他信号：进程按 Node.js 的默认行为结束，不保证收敛。

## 9. 验证

故障注入测试在 `apps/control-plane/src/bootstrap/system-control.test.ts` 与
`packages/infrastructure/module-host/src/module-host.test.ts`，使用真实的 Fabric、ModuleHost、存储和组合根，
外围模块为 fake。覆盖：正常结束、命令抛错、重复故障共用一个 faultId、Core 不收敛时超时继续、
模块停止失败、引导失败时停止失败模块、启动中停止、停止超时、最后防线。

fake Kernel 只证明关闭步骤的顺序与期限，不证明产品 Core 的收敛正确；后者在 P10 用真实 Core 重做同一组注入。

参考：[Erlang/OTP Supervisor Behaviour](https://www.erlang.org/doc/system/sup_princ.html)、
[ECMAScript Explicit Resource Management](https://tc39.es/proposal-explicit-resource-management/)、
[Node.js v24 进程异常](https://nodejs.org/download/release/v24.19.0/docs/api/process.html)、
[Kubernetes Pod 终止与宽限期](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination)。
