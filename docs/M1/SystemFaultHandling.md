# MultiAgentOS M1 错误与系统故障处理

## 1. 目的与范围

本文规定 M1 中跨组件的错误处理规则：错误分哪几级、每一级由谁处理、各角色的权限、关闭怎样保证完成，
以及进程的退出码。它是这些规则的权威来源；各组件自身的行为见各自的文档，字段见 [M1Interface](M1Interface.md)：

| 内容 | 权威文档 |
| --- | --- |
| 分级、升级、捕获边界、角色权限、故障关闭步骤、退出码 | 本文 |
| 模块生命周期账本 | [ModuleHost](Infrastructure/ModuleHost.md) 第 3 节 |
| 运行的收敛、`abortAllRuns` 在 Kernel 核心内的处理 | [Kernel 内部交互](Kernel/Interaction.md) 第 6、7 节 |
| 执行实例的终止与事实 | [Supervisor](Kernel/Supervisor.md) |
| Workflow 与 UserInteraction 自身错误的处理 | [Workflow](Module/Workflow.md) 11.1、[UserInteraction](Module/UserInteraction.md) 6.1 |
| `SystemFault`、`System`、`StopReport` 等类型 | [M1Interface](M1Interface.md) 第 10、14 节 |

M1 是单进程、单活动运行的系统。Supervisor、Core、UserInteraction 等是同一 Node 进程内的模块，
不是可由操作系统逐个监视的进程；只有 `rg` 是子进程。因此：

- 进程内的处理只在事件循环仍能运行时有效；事件循环卡死或进程崩溃后，没有任何进程内机制能提供保证。
- M1 不恢复崩溃前未完成的运行，也不承诺崩溃后生成正常的 RunFinished。
- 没有完成的清理或结果交付不得报告为成功；无法确认的效果按未知记录。

## 2. 分级与升级

分界线不是“业务还是系统”，而是“是不是契约的一部分”。契约内的结果用返回值或消息表达；
只有缺陷和不变量被破坏才用 `throw`，而且 `throw` 不跨通讯主体（[Kernel 内部交互](Kernel/Interaction.md) 第 11 节）。

| 级别 | 含义 | 例子 | 形式 | 处理主体 |
| --- | --- | --- | --- | --- |
| L0 结果 | 契约内的预期分支，不是异常 | SyscallRejected、UnitReport(REJECTED/FAILED)、ExecutionFact(FAILED)、结算异常、额度不足 | 返回值或消息 | 契约的接收方 |
| L1 Exception | 运行无法正常继续，但运行 actor 仍可信 | 运行超时、安全违规、停止未确认、处理函数抛错、发送器契约失败（[Kernel](Module/Kernel.md) 第 11 节） | 控制通道消息 | Core，按收敛三步结束该运行 |
| L2 系统故障 | 无法归属某个运行，或处理 L1 的机制自身失效 | 模块启停失败、Fabric 或存储不可用、收敛过程抛错、Inbox 处理器崩溃、命令入口抛错 | 进程内函数 `SystemFaultReporter` | 组合根的系统控制 |
| L3 进程级 | 进程内状态已不可信 | `uncaughtException`、`unhandledRejection`、事件循环卡死、进程崩溃 | — | 最后防线退出；进程外是用户 |

L1、L2、L3 是升级阶梯：**处理某一级时再次失败，必须升到上一级，不得在同级重试。**
Core 处理 `KERNEL_FAULT` 时收敛过程抛错，不再投递第二个 `KERNEL_FAULT`，而是调用 `reportSystemFault`；
系统控制的关闭步骤超时，不重做该步骤，而是进入下一步，最终以非零退出码结束。

故障的去向由**捕获位置**静态决定，不由某个协调者在运行时判断“Core 是否还能处理”：
外部无法核实 Core 的状态是否可信。运行 actor 内捕获的走 L1；其他位置捕获的走 L2。
L2 的关闭总是先请求 Core 收敛并等待一个期限，超时即继续强制停止，Core 能否处理由期限回答。

### 2.1 不经过 Core 的错误

Core 只对运行终态有权威，不是所有错误的必经之路。

| 发生位置 | 处理主体 | 是否经 Core |
| --- | --- | --- |
| CLI 参数、系统配置、目录加载 | CLI 与组合根；此时模块尚未构造或启动 | 否 |
| 缺失或非法 `requestId` 的传输契约错误 | Fabric 抛给发送方，属于发送方的缺陷 | 否 |
| 畸形 syscall、调用方不符、准入封锁 | Gateway 结构化拒绝 | 否 |
| Executor 抛错、超时、不响应中止、`rg` 崩溃 | Supervisor 转成该执行实例唯一的 ExecutionFact | 作为 L0 事实进入 |
| 模块 `start()`、`stop()` 失败 | ModuleHost 回滚并记账，Supervisor 上抛，组合根决定退出码 | 否 |
| 运行 actor 处理函数抛错、发送器失败 | actor 循环捕获，投递 `KERNEL_FAULT` | 是，L1 |
| 收敛过程自身抛错 | 升级：`reportSystemFault` | 否，Core 已不可信 |
| Workflow 发现自身内部错误 | Workflow 调用 `closeRun(FAILED)`，原因码 `WORKFLOW_INTERNAL` | 作为普通 syscall |
| Workflow 连 `closeRun(FAILED)` 也无法完成 | 升级：Inbox 失败观察者调用 `reportSystemFault` | 仅被请求收敛（第 5 节） |
| Workflow 静默卡死 | `RUN_TIMEOUT` | 是，L1 |
| UserInteraction 的 Inbox 处理器、询问任务或命令抛错 | 系统控制；错误由组合根写到 stderr，因为 UserInteraction 可能已坏 | 仅被请求收敛（第 5 节） |

`health()` 只是调用时刻的快照，不是异步故障的通知，也不作为恢复路径。静默失败靠已有的期限发现：
Unit 截止时间、授权超时、运行总时长、收敛兜底，以及第 5 节的关闭期限。

### 2.2 捕获边界

`catch` 只出现在以下位置；其他位置不得捕获，除非是把错误转成契约规定的返回值。

| 边界 | 捕获后 |
| --- | --- |
| 组合根入口 `main()` 与 `System.run` | 记录系统故障，保证关闭，给出退出码 |
| ModuleHost 的每次模块启停 | 记入账本，回滚或继续停其余模块，汇总抛出 |
| 运行 actor 的每条消息 | 投递 `KERNEL_FAULT`；收敛中再失败则 `reportSystemFault` |
| Supervisor 的每个执行实例 | 形成唯一终态事实，原因码 `INTERNAL` |
| Kernel 核心的 Inbox、OrderedSender、定时器的失败观察者 | actor 内投递 `KERNEL_FAULT`；actor 外 `reportSystemFault` |
| Workflow 的 Inbox 处理器 | 先 `closeRun(FAILED, WORKFLOW_INTERNAL)`；做不到时由失败观察者 `reportSystemFault` |
| UserInteraction 的 Inbox 处理器、询问任务、中断处理 | `reportSystemFault` |

`reportSystemFault` 是组合根注入的同一个进程内函数（`SystemFaultReporter`，[M1Interface](M1Interface.md) 第 10 节），
Kernel 核心、Workflow 与 UserInteraction 各自经依赖清单取得。它不经 Fabric，不抛错。
Executor 不持有它：Executor 的一切结局由 Supervisor 转成 ExecutionFact。
Inbox 的处理器抛错而没有失败观察者时，错误只在模块停止时暴露，因此产品模块必须接入失败观察者。

## 3. 角色

| 角色 | 拥有的状态与决定 | 不得做的事 |
| --- | --- | --- |
| ModuleHost | 依赖顺序、逐模块生命周期账本、每次停止的期限与结果 | 判断故障等级、决定是否关闭系统、重试失败的停止 |
| Supervisor | 正常路径的启停顺序；执行实例、中止信号、`rg` 子进程；把 Executor 的一切结局转成事实 | 修改运行状态、裁决系统故障（它自己也可能失效） |
| Core | 运行状态 `RUNNING → CONVERGING → CLOSED`、结束原因、预算与授权；L1 的唯一处理者 | 宣称整个进程或 UserInteraction 健康 |
| 组合根的系统控制 | 关闭意图、各步期限、故障记录、进程退出码；L2 的唯一处理者 | 持有或改写任何领域状态 |

**组合根不是模块。** 它没有 `moduleId`，不注册进 ModuleHost，没有 Fabric 身份和 Inbox，不实现 `LifecyclePort`；
否则就要再回答“谁来启停和监管它”。`composeSystem` 返回的 `System` 是一个带少量运行期状态的进程级控制对象，
地位相当于 `main`。它受三条约束：

1. 只对自己构造的对象做直接函数调用，不发送 Fabric 消息。
2. 不持有、不改写运行状态、Lease、账本等领域状态。
3. 只决定三件事：何时开始关闭、每一步等多久、进程退出码。

## 4. 模块生命周期契约

`LifecyclePort.stop()` 必须可重复调用；在 `start()` 之前、中途失败之后调用也必须安全；它只清理本模块已取得的资源。
模块在取得每项资源后登记释放动作，按逆序释放。ModuleHost 不了解模块内部的句柄、定时器或任务。

ModuleHost 为每个模块记录状态，启动失败的模块同样被停止，停止失败的模块保留为 `STOP_FAILED` 且不重试；
状态机与规则见 [ModuleHost](Infrastructure/ModuleHost.md) 第 3 节。账本是事实，是否退出进程由组合根决定。

## 5. 关闭路径

**正常关闭**：UserInteraction → `shutdown` → Gateway → Core 运行管理 → 运行收敛、Outbox 排空 →
`SupervisorPort.shutdown` → Supervisor 驱动 ModuleHost 逆序停止 → 终止残留子进程、清理临时目录
（[ModuleHost](Infrastructure/ModuleHost.md) 第 2 节）。

**故障关闭**：任何位置调用 `reportSystemFault`，或命令入口抛错、命令结束后系统未在期限内停止，都进入以下步骤。
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
- 结束原因复用 `FAILED(KERNEL_INTERNAL)`，`failure.source = KERNEL`，不新增原因码；
  真实来源由 `faultId` 关联到 stderr 与审计。运行已在 CONVERGING 或 CLOSED 时不改写其结束原因。
- 引导未完成时跳过第 2 步。此时没有运行，只需停止已启动的模块。
- 关闭意图由系统控制自己判定：Supervisor 只有两条停止路径（Core 的 shutdown 请求、被直接调用 `stop()`），
  系统控制没有发起过故障关闭且没有任何故障记录时，才是 `REQUESTED`；否则是 `FAULT`。
- UserInteraction 仍然可用时，它会收到这次收敛产生的 RunFinished 并照常展示；它不可用时用户只看到 stderr 的故障行。
- 各步的期限（`ShutdownTimeouts`）见 [M1Interface](M1Interface.md) 14.4。

**退出码**：

| 情况 | 退出码 |
| --- | --- |
| 命令行无法解析（此时不构造系统） | 64 |
| 意图为 `REQUESTED` | UserInteraction 记录的退出码（[UserInteraction](Module/UserInteraction.md) 第 3 节） |
| 意图为 `FAULT`，命令已返回非零退出码 | 该非零退出码 |
| 意图为 `FAULT`，命令返回 0、抛错或没有返回 | 70 |
| 组合阶段抛错（配置、目录、工厂），或引导失败 | 70 |
| 未捕获异常、未处理的 Promise 拒绝 | 70，不尝试收敛 |
| 用户第二次按 Ctrl+C | 130，不尝试收敛（第 6 节） |

出现过系统故障的进程不得以 0 退出。70 只由组合根产生，模块不使用它。

## 6. 进程入口、中断与子进程

- 进程入口是 `apps/control-plane` 的 `bin.ts`（命令名 `multiagentos`）：它只调用 `main()` 并设置退出码。
  入口与进程信号归组合根；`apps/cli` 只做参数解析与终端适配。
- 最后防线由 `main()` 安装。未捕获异常时它只做三件事：写诊断、同步终止子进程、非零退出。
  此时进程内状态不可信，不调用 Core，也不等待任何异步清理。
- Ctrl+C 分两段，两段的主体不同。第一次属于 UserInteraction：它经 `TerminalPort.onInterrupt` 调用 `cancelRun`，
  运行按 CANCELLED 正常收敛，退出码 130；最后防线只计数。第二次属于最后防线：用户不再等待收敛，
  它写诊断、同步终止子进程、以 130 退出，同样不调用任何模块。尚未创建运行时第一次没有可取消的对象，
  用户再按一次即退出。`apps/cli` 的终端适配器只转发中断，不得自行退出进程。
- 子进程在创建时登记到 `SubprocessRunner` 的存活集合。`killAll()` 是同步的，由 Supervisor 的 `stop()`、
  系统控制的关闭末尾、进程的 `exit` 钩子和最后防线调用。组合根自己持有这个 runner 并注入 Supervisor，
  因此不需要向可能已失效的 Supervisor 索取句柄。
- 进程内 Executor 不响应中止信号时无法被强制终止：超过宽限期记为 `STOP_UNCONFIRMED`，效果标记为未知，
  靠进程退出结束。

## 7. 故障决策示例

| 情况 | 结果 |
| --- | --- |
| 模块 `start()` 部分成功后抛错 | ModuleHost 停该模块及此前模块；系统未就绪；组合根以 70 退出 |
| Provider 返回普通失败 | L0：Execution 按重试规则处理，Core 交付 UnitReport，Workflow 决定业务结果 |
| 发送器遇到契约缺陷 | L1：`KERNEL_FAULT`，运行按 `FAILED(KERNEL_INTERNAL)` 收敛，正常关闭，退出码 1 |
| 收敛过程中再次抛错 | 升级到 L2：故障关闭；不保证 RunFinished；退出码 70 |
| 命令入口在运行中抛错 | L2：`abortAllRuns` 使运行收敛，模块全部停止，退出码 70 |
| Workflow 的 reducer 抛错 | Workflow 以 `closeRun(FAILED, WORKFLOW_INTERNAL)` 结束运行，正常关闭，退出码 1 |
| UserInteraction 在 RunFinished 之后失败 | 运行结果不改写；记录系统故障；命令已返回非零码则保留，否则 70 |
| RunSummary 写入失败 | `finalizationError` 规则：不伪造引用，不改结束原因；属于 L1 内的已定义分支，退出码至少为 1 |
| Core 在期限内没有完成 `abortAllRuns` | 记录后继续停止模块；运行没有正常结束事件；退出码 70 |
| 模块 `stop()` 失败或超时 | 账本保留 `STOP_FAILED`，其余模块照常停止；不重试；即使运行已完成也不以 0 退出 |
| Supervisor 的 `stop()` 失败或超时 | 组合根直接调用 `moduleHost.stop()`，与进行中的停止共用同一次执行 |
| 进程卡死或崩溃 | 进程内不保证；由用户终止；下次启动只清空 `<dataDir>/tmp/`，不恢复运行 |

## 8. 验证要求

故障注入测试必须使用真实的 Fabric、ModuleHost、存储和组合根，至少覆盖：正常结束、命令抛错、
重复故障共用一个 `faultId`、Core 不收敛时超时继续、模块停止失败、引导失败时停止失败模块、启动中停止、
停止超时、模块经注入的 `reportSystemFault` 上报、最后防线与第二次中断。

以 fake Kernel 运行这组测试只证明关闭步骤的顺序与期限，不证明 Kernel 核心的收敛正确；
M1 验收必须以真实的 Kernel 核心重做同一组注入。

## 9. M1 不实现

- 崩溃后的运行恢复，以及独立的进程外监督者：进程卡死或崩溃由启动它的用户或 shell 处理。
- 对失败的 `stop()` 重试，或绕过 Supervisor 的独立执行回收能力。
- SIGTERM 等其他信号的处理：进程按 Node.js 的默认行为结束，不保证收敛。
- 公开的系统级状态机协议：系统故障只在进程内以函数调用上报。

参考：[Erlang/OTP Supervisor Behaviour](https://www.erlang.org/doc/system/sup_princ.html)、
[ECMAScript Explicit Resource Management](https://tc39.es/proposal-explicit-resource-management/)、
[Node.js v24 进程异常](https://nodejs.org/download/release/v24.19.0/docs/api/process.html)、
[Kubernetes Pod 终止与宽限期](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination)。
