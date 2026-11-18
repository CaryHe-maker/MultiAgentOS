# MultiAgentOS M2 Kernel 内部交互

> 状态：已实现（`packages/modules/kernel/src/session`）。

## 1. 定位

本文规定 M2 Kernel 各组件之间的交互：Session 管理与 Session actor、消息与处理规则、Session 与运行的生命周期、
一次 `submitUnit` 的内部路径、收敛与关闭。各组件的数据与规则见同目录下的组件文档；对外的 syscall 与事件见
[Module/Kernel](../Module/Kernel.md) 与 [Interface](../Interface/README.md)；长期规划见 [Kernel 架构](../../Architecture/Module/Kernel.md) 第 3 节。

## 2. 相对 M1 的变化

| M1 | M2 | 依据 |
|---|---|---|
| 运行管理 `RunRegistry`：`workflowRunId → 运行 actor` | Session 管理：`sessionId → Session actor`，另外持有系统级状态 | M2Design 第 2.6 节 |
| 运行 actor：一个运行的队列与状态分块 | Session actor：一个 Session 的队列，Session 级状态分块与当前运行的状态分块 | 同上 |
| 只有 `createRun` 能创建 actor；一个进程一个运行 | `startSession`、`openSession`、`startRun` 建立 actor；Session 中的运行先后进行 | M2Design 第 2.3 节 |
| 事件只有运行级序列 | 增加 Session 级序列与系统级序列 | Interface 第 4 节 |
| 没有输入的概念 | Core 依据开放输入开启与结束一次输入的工作，以这条输入的 checkpoint 命名（Orchestration 第 7.1 节） | M2Design 第 2.3 节 |
| 运行超时、额度耗尽都由 Kernel 收敛运行 | 额度不触发收敛；超时按中止处理，结束由 Workflow 报告 | M2Design 第 2.3、7.3 节 |
| `STOP_UNCONFIRMED` 使运行以 FAILED 收敛 | 系统停机 | M2Design 第 4.7 节 |
| 唯一的 FIFO 执行队列 | 按 AgentRun 分队列 | M2Design 第 7.1 节 |

通讯主体、Kernel 核心内部的模块化隔离与调用关系不变，见归档的 [M1 Interaction](../../History/M1/Kernel/Interaction.md) 第 3.1–3.3 节。

## 3. 术语

| 术语 | 定义 |
|---|---|
| Session 管理 | Core 中跨 Session 的部分：创建与回收 Session actor、按 `sessionId` 分发消息、处理 Session 请求与 `shutdown`，持有系统级状态与系统级 Outbox |
| Session actor | 一个 Session 的 Inbox（Session Inbox）、串行处理循环，以及 Session 级与当前运行的状态分块；不是第七个组件 |
| 系统级状态 | Session 引用、项目指令的信任记录、产物正文的回收；只由 Session 管理写入 |
| Session 级状态 | 跨越同一 Session 中多个运行的状态：Core 的审计写入器与 Session 级 Outbox，Execution 的产物归属 |
| 运行级状态 | 一个运行的状态分块，内容与 M1 运行 actor 的分块相同，增加当前输入（`openInput`）与它的账本 |
| runEpoch、在途执行、待发送、墓碑 | 与 M1 相同（M1 Interaction 第 2 节）；墓碑按运行保留，在 Session actor 中 |

## 4. Kernel 私有接口的变化

只列相对 M1 的变化；接口的其余部分与 M1 Interaction 第 3.4 节相同。

- **运行的工作**（`RunWork`，`session/run-work.ts`）：一个运行的 Core 部分，受理 Workflow 的 syscall（登记、提交、委派、checkpoint、任务的请求）与授权的回答，持有当前输入、授权、委派与活动；尝试与执行交给 `RunAttempts` 与 Execution。
- **Execution 增加的职责**：产物归属改为"属于本 Session"；`storeUserInput`；`readProjectFile`；内建 Unit `message-publish`；删除 Session 的文件；定期回收产物；Fork 时继承产物；组装的估算、修剪与摘要请求（Execution 第 6a 节）。
- **账本**（`monitor/run-ledgers.ts`，Monitor 第 3 节）：运行、输入、任务三级。`openInputLedger(inputId)` 总是开启（份额不足 `minShare(main)` 时为 WRAP_UP），`closeInputLedger(inputId)` 把剩余还给运行级账本；`reserve`、`settle` 按 AgentRun 找到它的账本；`reserveDelegation`、`registerAgentRun`、`endAgentRun`、`releaseDelegation` 管任务的份额；`inputWants`、`delegationWants`、`extendInput` 是规则 6 的追加；`openCompactionLedger` 给没有输入开启时的压缩；`budgetView(agentRunId)` 给出三级的状态。
- 尝试的登记（`RunAttempts.registerAttempt`）不带输入：一次输入的工作结束时它的尝试都已结束（结束要求静止），迟到的提交由运行的 `runEpoch` 与 `openInput` 拒绝（`NO_OPEN_INPUT`）。

main 直接使用输入的账本（M2Design 第 7.3 节）；main 的 `BudgetView.agentRun` 等于 `input`。

## 5. Session 管理与 Session actor

### 5.1 Session 管理

- **系统级状态**：Session 引用（`session-refs.jsonl`）与信任记录（`trusted-instructions.jsonl`）在启动时读入内存；写入只经 Session 管理。
- **建立 actor**：只有 `startSession`、`openSession`、`startRun` 能建立 Session actor。同一时刻至多一个打开的 Session：
  已有 Session 时，先在当前 actor 中完成关闭（第 6.4 节），再建立新的 actor。
- **分发**：按 `sessionId` 把 `GatewayForward` 与 `ExecutionFact` 投递给对应 actor；Session 已关闭时按墓碑处理（只写审计，请求返回 `SESSION_NOT_FOUND`）。
- **`listSessions`、`deleteSession`**：在 Session 管理中处理，与 Session actor 无关。Session 管理有自己的系统级 Outbox（每个接收方一个 `seq` 计数），
  以系统级事件向 Workflow 发出 `SessionListQuery`、`SessionDelete`，在系统级待回复表中按 `queryId`、`commandId` 核对 `reportSessionList`、`reportSessionCommand(DELETE)`，
  再以系统级事件向 UserInteraction 发出 `SessionList`、`SessionDeleted`。Session 管理的处理同样串行：一个请求处理完（包括等待回复）才处理下一个 Session 请求。
- **`SessionList` 的内容**：Workflow 交来的列表中，只保留 Session 引用存在、ACTIVE 且仓库与本进程一致的条目；标题由 Execution 读取 `titleRef` 的前 80 个字符。
- **回收**：Session actor 关闭、Session 级 Outbox 投递完毕后移出，保留墓碑。
- **产物回收**：启动时、开放服务之前由 Execution 完成一次（[ModuleHost](../Infrastructure/ModuleHost.md) 第 3 节）；之后 Session 管理的定时器每隔 `artifactRetention.sweepIntervalMinutes` 产生内部消息 `ARTIFACT_SWEEP_TICK`，
  与 Session 请求一样按顺序处理：调用 `startArtifactSweep()` 后立即处理下一条，不等待回收完成（Execution 第 6 节）。

### 5.2 Session actor 的构成

| 部分 | 内容 |
|---|---|
| Session Inbox | 控制与工作两个通道，控制优先（与 M1 相同） |
| 处理循环 | `while (m = 取下一条) { await handle(m); await settle(); }`：`settle` 收敛出了故障的运行、为等待调用机会的尝试重新申请、在运行排空时结束它、核对输入的计时；两步合起来是一次处理 |
| Session 级分块 | Core：审计写入器、Session 级 Outbox、Session 命令的待回复表；Execution：产物归属索引 |
| 运行级分块 | 当前运行（至多一个）的 Core、Execution、Monitor、Scheduler 分块；已结束的运行只保留墓碑 |

`execution.drainCapacityWaiters()` 为等待调用机会的尝试重新申请（M2Design 第 7.2 节，[Execution](Execution.md) 第 4c 节）。

### 5.3 消息

Session actor 的 Inbox 只有四种消息（`session/session-actor.ts`）：

| kind | 来源 | 内容 |
|---|---|---|
| `SESSION_BEGIN` | Session 管理（`startSession`、`startRun`、`openSession`） | 新建、Fork 或打开这个 Session，并开启它的第一个运行 |
| `SESSION_CLOSE` | Session 管理（切换、新建、`shutdown`） | 收敛当前运行、关闭 Session |
| `COMMAND_REPORT` | Workflow（`OPEN`、`CREATE`、`FORK`、`CLOSE` 的回复；`DELETE` 与列表查询的回复由 Session 管理直接处理） | 交给等这条命令的那一步 |
| `CALL` | 其余一切 | 一次要在本 Session 中串行处理的工作：Gateway 转来的请求（按 `GatewayForward.requestType` 分发，即各 syscall 的名字）、执行事实、定时器（墙钟、输入的超时、暂停的上限、唤醒）、压缩的修剪与摘要结果 |

授权询问不超时，运行也没有总时长（M2Design 第 5.3、7.4 节）。UserInteraction 不直接取消运行：切换、新建与关闭时由 Session 管理收敛当前运行。

### 5.4 处理规则

与 M1 Interaction 第 4.4 节相同：不可重入；跨主体 I/O 只登记为待发送；结果检查同步；定时器只入队；请求的响应在处理结束时返回。M2 补充：

1. **三个 Outbox，一个发送器**：运行级、Session 级与系统级事件对同一接收方使用同一个有序发送器，按登记顺序发出（[Fabric](../Infrastructure/Fabric.md) 第 3 节）。
2. **本地 I/O 可以等待**：读写系统级状态与 Session 目录中的 Kernel 文件、ArtifactStore、目录定义，可以在处理函数中 `await`。
3. **持久化**：M2 不按消息持久化运行状态（与 M1 相同）；持久写入的只有审计、Session 引用、信任记录与产物归属。

## 6. 生命周期

### 6.1 新建 Session（`startSession`、`startRun`）

```text
Gateway 生成 sessionId 与 correlationId（Interface 第 3 节）；Session 管理受理请求：若有打开的 Session，先按第 6.4 节关闭
  → 写入 Session 引用（ACTIVE，仓库根目录取本进程的仓库）
  → 建立 Session actor，投递 SESSION_BEGIN
Session actor：
  → Execution 把第一条输入存为产物（storeUserInput），登记归属
  → Session 级 Outbox 发出 SessionCommand(CREATE)（Fork 时为 FORK）
  → 等待 COMMAND_REPORT：
       READY  → 向 UserInteraction 发出 SessionOpened；开启运行（第 6.3 节，RunStart(initialInput: true)），
                把第一条输入以 HumanAnswered(origin: initial) 交给 Workflow，开启第一次输入的工作
       FAILED → Session 引用改为 DELETED；删除 Kernel 已为它写入的文件（removeSessionFiles 与 Core 的审计）；
                向 UserInteraction 发出 SessionFailed（该 Session 序列的最后一个事件），关闭 actor
```

### 6.2 打开 Session（`openSession`）

```text
Session 管理检查引用存在、ACTIVE，否则 SESSION_NOT_FOUND
  → 引用中的文件夹不是本进程的：没有 confirmWorkspaceChange 则 WORKSPACE_CHANGE_NOT_CONFIRMED，什么都不做
  → 若有打开的 Session，先按第 6.4 节关闭；建立 Session actor，投递 SESSION_BEGIN
  → 换文件夹时（已确认）：快照另起一段（索引追加 EPOCH，此前的 checkpoint 不再可回退），然后把引用改为本进程的文件夹
Session actor：
  → 读入本 Session 的产物归属索引
  → 发出 SessionCommand(OPEN)，等待回复
       READY  → 向 UserInteraction 发出 SessionOpened；比较工作区并发出 WorkspaceDiverged（换文件夹后快照另起一段，没有可比较的，不发）
                开启运行（RunStart(initialInput: false)）；由 Workflow 请求开放输入，或重新发起上一个进程中未答复的人类请求
       FAILED → 发出 SessionFailed（该 Session 序列的最后一个事件），关闭 actor（引用保持 ACTIVE）
```

**在当前 Session 中继续**（对当前 Session 的 `openSession`，例如因额度结束后用户确认继续）：Session 管理让当前 actor 继续；
当前运行已 CLOSED 时，直接按第 6.3 节开启新的运行（`RunStart(initialInput: false)`），不下达 Session 命令、不发出 `SessionOpened`；
否则以 `SESSION_IN_USE` 拒绝。

### 6.3 运行

- **开启**：Core 生成 `workflowRunId`，建立运行级分块，Outbox 发出 `RunStart`。
- **一次输入的工作**：开放输入得到答复时开启、下一次请求开放输入或运行收敛时结束（M2Design 第 2.3 节）。基本规则：
  - 开启：先拍这条输入的 checkpoint（Orchestration 第 7.2 节），调用 `openInputLedger`，在 `HumanAnswered` 中带上 `checkpointId`；
  - 结束：`requestHuman(prompt)` 到达时检查没有 ACTIVE 的 AgentRun 与在途尝试，通过后调用 `closeInputLedger`，Outbox 发出 `InputSettled`；
    没有开启中的输入时（`initialInput: false` 的运行请求第一个开放输入）直接进入 AWAITING_INPUT；
  - 输入的超时（`inputTimeoutSeconds`，Mission 运行为 `orchestrationTimeoutSeconds`）：没有已派发或待派发的尝试（挂起在授权询问上的不算）且有待答复的人类请求或授权询问时暂停计时，每次处理消息的末尾重新判断（M2Design 第 7.4 节）。每次执行另有截止时间（M1 的 `executionLimits`）。
- **结束**：收敛过程与 M1 Interaction 第 6 节的三步相同。差别：
  - 触发来源：`closeRun`（COMPLETED、FAILED、BUDGET、CANCELLED、TIMEOUT、INTERRUPTED）、Session 管理的收敛（ENDED_BY_USER、SHUTDOWN）、
    Kernel 的故障、结果检查中的 VIOLATION；额度不触发收敛；
  - 开启中的输入在第 ③ 步以 `RUN_CLOSED` 结束，`InputSettled` 在 `RunClosed` 之前放入 Outbox；
  - `Lease` 与授权条目在第 ③ 步失效；Session 级状态不受影响。

### 6.4 关闭 Session

```text
SESSION_CLOSE（原因：SWITCHED、SHUTDOWN）
  → 有运行且不在 CLOSED：按第 6.3 节收敛（closeReason：ENDED_BY_USER 或 SHUTDOWN），等待 CLOSED 与运行级 Outbox 投递完毕
  → 发出 SessionCommand(CLOSE)，等待回复（Workflow 释放 Session 锁）；等待不超过 sessionCloseTimeoutMs，超过时放弃这个 Session，后续请求照常处理，Session 锁按过期规则处理
  → 发出 SessionClosed；Session 级 Outbox 投递完毕后通知 Session 管理回收
```

删除 Session（`deleteSession`）只能针对未打开的 Session（M2Design 第 2.3 节 Session 第 3 条），不经过 Session actor：Session 管理把引用改为 DELETED，
以系统级事件 `SessionDelete` 让 Workflow 删除日志，收到回复后——不论 Workflow 成功与否——删除 Kernel 命名空间中该 Session 的文件（审计、产物归属），再发出 `SessionDeleted`；
正文由下一次回收删除（[ArtifactStore](../Infrastructure/ArtifactStore.md) 第 4 节）。回收只看 Session 引用是否 ACTIVE，所以删除失败而残留的文件不会让正文继续被保留。

### 6.5 运行状态与各请求的处理

| 请求 | RUNNING | AWAITING_INPUT | CONVERGING | CLOSED |
|---|---|---|---|---|
| `registerAgentRun`、`submitUnit` | 处理；没有开启中的输入时 `NO_OPEN_INPUT` | `NO_OPEN_INPUT` | `RUN_BLOCKED` | `RUN_BLOCKED` |
| `endAgentRun` | 处理 | 处理 | SyscallAck，无效果 | SyscallAck，无效果 |
| `closeRun` | 进入收敛 | 进入收敛 | SyscallAck，无效果 | SyscallAck，无效果 |
| `requestHuman(prompt)` | 静止时结束开启中的输入（没有时不结束），进入 AWAITING_INPUT；否则 `AGENT_RUN_ACTIVE` | `REQUEST_CONFLICT`（已有待答复的开放输入） | `RUN_BLOCKED` | `RUN_BLOCKED` |
| `answerHuman`（开放输入） | `HUMAN_REQUEST_NOT_PENDING` | 开启下一次输入的工作，回到 RUNNING | `HUMAN_REQUEST_NOT_PENDING` | 同左 |
| `readProjectFile` | 处理 | 处理 | `RUN_BLOCKED` | `RUN_BLOCKED` |
| `answerAuthorization`、`readArtifact`、执行事实 | 与 M1 的 RUNNING 列相同 | 同左 | 与 M1 的 CONVERGING 列相同 | 与 M1 的 CLOSED 列相同 |

状态转移只有：RUNNING ⇄ AWAITING_INPUT；任一非终态 → CONVERGING → CLOSED。另有 PAUSING、PAUSED、INTERRUPTING。

## 7. 一次 `submitUnit` 的内部路径

与 M1 Interaction 第 5 节相同，补充：

- **受理**（第 5.1 节）：在第 2 步之后检查有开启中的输入，否则 `NO_OPEN_INPUT`；第 5 步的 `UNSUPPORTED_CAPABILITY` 改为依据 Unit 定义的能力判断。
- **权限**（第 5.2 节）：按 [Core](Core.md) 的两步判定。
- **执行**（第 5.3 节）：内建 Unit `MESSAGE_PUBLISH` 由 Execution 直接完成（M1 的 `REPORT_PUBLISH` 已删除）；产物引用的归属检查改为"属于本 Session"。
- **结果检查**（第 5.4 节）：UnitReport 带 `unitRunId` 与 `BudgetView`；工具 Unit 的结果分为预览（`outputRef`）与截断时的完整输出（`fullRef`），由 Execution 登记保留类别。
- **`read_output`**：Workflow 填入的 `fullRef` 在派发前由 Execution 检查归属与过期（Execution 第 5a 节）；过期时以 `REJECTED(ARTIFACT_EXPIRED)` 交付，不派发。
- **压缩检查点**：受理 `context-assemble` 之后、派发之前，Core 按 [Core](Core.md) 第 6a 节检查是否需要压缩；需要时这次尝试保持在途但不派发，
  直到压缩结束（修剪或摘要生效后以 `REJECTED(CONTEXT_COMPACTED)` 交付，否则照常派发）。修剪与摘要请求是 Kernel 内部的尝试，不对应任何 `submitUnit`，不产生 UnitReport。
  `/compact` 进行中开启的下一次输入，main 的第一次 `context-assemble` 同样挂起到压缩结束。
- **技术重试的等待**：按 Execution 第 4a 节计算 `notBefore`；等待期间 Core 发出 `RETRYING` 的 ActivityEvent。

## 8. 关闭与故障关闭

- **关闭系统**：`shutdown` → Session 管理标记正在关闭（此后 Session 请求返回 `RUN_LIMIT`）→ 按第 6.4 节以 SHUTDOWN 关闭当前 Session →
  `SupervisorPort.shutdown`（[ModuleHost](../Infrastructure/ModuleHost.md) 第 4 节）。
- **故障关闭**：`abortAllRuns` 与 M1 Interaction 第 7.1 节相同，作用于当前打开的 Session 中的运行；不向 Workflow 发出 `SessionCommand(CLOSE)`，
  Session 锁由下次打开时按过期规则处理。
- 非停机异常与 panic 的规则与 M1 Interaction 第 8 节相同；`STOP_UNCONFIRMED` 改为停机（M2Design 第 4.7 节）。

## 9. 配置（`KernelConfig` 的变化）

| 配置 | 读取者 | 缺省 | 说明 |
|---|---|---|---|
| `repositoryRoot` | Core | 组合根依据工作目录或 `--repo` 写入 | 本进程的仓库，realpath |
| `runTimeoutMs` | — | — | 删除；由 `inputTimeoutSeconds`、`orchestrationTimeoutSeconds` 取代（[Core](Core.md) 第 8 节） |
| `authorizationTimeoutMs` | — | — | 删除：授权询问不超时（M2Design 第 5.3 节） |
| `sessionCloseTimeoutMs` | Core | 10000 | 第 6.4 节：等待 Workflow 回复 `CLOSE` 的上限 |
| 其余 | — | — | 与 M1 Interaction 第 9 节相同；`budget` 见 [Monitor](Monitor.md) |

## 10. 不变量与测试

| 不变量（M2Design 第 12 节） | 测试 |
|---|---|
| 5：每个受理的 `submitUnit` 恰好得到一个 UnitReport，或随 RunClosed 结束 | 状态机测试：在各状态下提交、关闭、切换 Session |
| 18：一次输入的工作只由 Kernel 依据开放输入开启与结束；结束时没有 ACTIVE 的 AgentRun 与在途尝试 | 单元测试：`requestHuman(prompt)` 在非静止时被拒；运行收敛时开启中的输入以 `RUN_CLOSED` 结束 |
| 4：AWAITING_INPUT 时没有 ACTIVE 的 AgentRun 与在途尝试 | 同上 |
| 事件顺序 | 集成测试：`SessionOpened` 先于 `RunStart`；`InputSettled` 先于 `RunClosed`；`SessionClosed` 或 `SessionFailed` 是 Session 序列的最后一个；没有打开的 Session 时 `listSessions`、`deleteSession` 经系统级序列完成 |
