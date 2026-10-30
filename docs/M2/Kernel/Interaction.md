# MultiAgentOS M2 Kernel 内部交互

> 状态：草稿（阶段 1）。

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
| 事件只有运行级序列 | 增加 Session 级序列 | Interface 第 4 节 |
| 没有 Turn | Core 依据开放输入开启与结束 Turn | M2Design 第 2.3 节 |
| 运行超时、额度耗尽都由 Kernel 收敛运行 | 额度不触发收敛；超时按中止处理（阶段 5），结束由 Workflow 报告 | M2Design 第 2.3、7.3 节 |
| `STOP_UNCONFIRMED` 使运行以 FAILED 收敛 | 系统停机 | M2Design 第 4.7 节（阶段 3） |
| 唯一的 FIFO 执行队列 | 阶段 1 仍为单个 FIFO；阶段 4 改为按 AgentRun 分队列 | M2Plan 第 6.5 节 |

通讯主体、Kernel 核心内部的模块化隔离与调用关系不变，见归档的 [M1 Interaction](../../History/M1/Kernel/Interaction.md) 第 3.1–3.3 节。

## 3. 术语

| 术语 | 定义 |
|---|---|
| Session 管理 | Core 中跨 Session 的部分：创建与回收 Session actor、按 `sessionId` 分发消息、处理 Session 请求与 `shutdown`，并持有系统级状态 |
| Session actor | 一个 Session 的 Inbox（Session Inbox）、串行处理循环，以及 Session 级与当前运行的状态分块；不是第七个组件 |
| 系统级状态 | Session 引用、项目指令的信任记录、产物正文的回收；只由 Session 管理写入 |
| Session 级状态 | 跨越同一 Session 中多个运行的状态：Core 的审计写入器与 Session 级 Outbox，Execution 的产物归属（阶段 2 起还有快照索引） |
| 运行级状态 | 一个运行的状态分块，内容与 M1 运行 actor 的分块相同，增加 Turn 记录 |
| runEpoch、在途执行、待发送、墓碑 | 与 M1 相同（M1 Interaction 第 2 节）；墓碑按运行保留，在 Session actor 中 |

## 4. Kernel 私有接口的变化

只列阶段 1 的变化；接口的其余部分与 M1 Interaction 第 3.4 节相同。

```ts
interface AttemptRegistration {        // CoreSyscalls.registerAttempt 的参数
  unitAttemptId: string;
  requestId: string;
  agentRunId: string;
  unitRunId: string;                   // 新增
  turnId: string;                      // 新增：尝试所属的 Turn，Turn 结束后的迟到提交据此拒绝
  runEpoch: number;
  executionKind: ExecutionKindV1;
  requiresLease: boolean;
}

interface ExecutionDuties {            // 增加的部分
  ownsArtifact(ref: ArtifactRef): boolean;               // 归属改为"属于本 Session"
  storeUserInput(input: { inputId: string; text: string }): Promise<ArtifactRef>;
  readProjectFile(path: string, scope: ExecutionScope): Promise<ProjectFileRead>;
  publishMessage(input: MessagePublishInput): Promise<ArtifactRef>;   // 内建 Unit message-publish
  inheritArtifacts(refs: ArtifactRef[]): Promise<void>;  // Fork（阶段 2）
}

interface MonitorDuties {              // 账本由一份改为运行 → Turn 两级（阶段 4 增加 AgentRun 级）
  openTurnLedger(turnId: string, limit: number): { ok: true } | { ok: false; reasonCode: 'BUDGET_WRAP_UP' };
  closeTurnLedger(turnId: string): TurnUsage;            // 剩余返还运行级账本
  reserve(request: { turnId: string; agentRunId: string; estimatedTokens: number; final: boolean }): ReserveResult;
  settle(reservationId: string, settlement: Settlement): SettlementResult;
  budgetView(agentRunId: string): BudgetView;            // 取代 budgetState()
  finalize(): BudgetSummary;
}
```

Monitor 在阶段 1 只有运行级与 Turn 两级账本，main 直接使用 Turn 账本（M2Design 第 7.3 节）；`BudgetView.agentRun` 在阶段 1 等于 `turn`。

## 5. Session 管理与 Session actor

### 5.1 Session 管理

- **系统级状态**：Session 引用（`session-refs.jsonl`）与信任记录（`trusted-instructions.jsonl`）在启动时读入内存；写入只经 Session 管理。
- **建立 actor**：只有 `startSession`、`openSession`、`startRun` 能建立 Session actor。同一时刻至多一个打开的 Session：
  已有 Session 时，先在当前 actor 中完成关闭（第 6.4 节），再建立新的 actor。
- **分发**：按 `sessionId` 把 `GatewayForward` 与 `ExecutionFact` 投递给对应 actor；Session 已关闭时按墓碑处理（只写审计，请求返回 `SESSION_NOT_FOUND`）。
- **`listSessions`、`deleteSession`**：在 Session 管理中处理；需要与 Workflow 交互时，借用当前打开的 Session actor 的 Session 级 Outbox 发出事件，
  没有打开的 Session 时由 Session 管理自己的 Outbox 发出（同样按 Session 级序列编号，`sessionId` 为被操作的 Session）。
- **回收**：Session actor 关闭、Session 级 Outbox 投递完毕后移出，保留墓碑。

### 5.2 Session actor 的构成

| 部分 | 内容 |
|---|---|
| Session Inbox | 控制与工作两个通道，控制优先（与 M1 相同） |
| 处理循环 | `while (m = 取下一条) { await dispatch(m); await core.settleConvergence(); await execution.drainCapacityWaiters(); }`；三步合起来是一次处理 |
| Session 级分块 | Core：审计写入器、Session 级 Outbox、Session 命令与查询的待回复表；Execution：产物归属索引 |
| 运行级分块 | 当前运行（至多一个）的 Core、Execution、Monitor、Scheduler 分块；已结束的运行只保留墓碑 |

`execution.drainCapacityWaiters()` 在阶段 4 引入（M2Design 第 7.2 节），阶段 1 为空操作。

### 5.3 消息

M1 的消息全部保留（M1 Interaction 第 4.3 节），其中 `RUN_INIT` 由 Session actor 在开启运行时自己投递。M2 新增：

| kind | 通道 | 来源 | 处理者 | 阶段 |
|---|---|---|---|---|
| `SESSION_START`、`SESSION_OPEN`、`RUN_START` | 控制 | Session 管理（`startSession`、`openSession`、`startRun`） | Core | 1 |
| `SESSION_CLOSE` | 控制 | Session 管理（切换、新建、`shutdown`） | Core | 1 |
| `SESSION_COMMAND_REPORT`、`SESSION_LIST_REPORT` | 工作 | Workflow | Core | 1 |
| `REQUEST_HUMAN`、`READ_PROJECT_FILE` | 工作 | Workflow | Core | 1 |
| `HUMAN_ANSWER` | 控制 | UserInteraction | Core | 1 |
| `TURN_TIMEOUT` | 控制 | Core 定时器 | Core | 5 |
| `PAUSE_RUN`、`RESUME_RUN`、`INTERRUPT_RUN` | 控制 | UserInteraction | Core | 5 |

M1 的 `CANCEL_RUN` 在 M2 中只由 Session 管理投递（切换、新建、关闭时收敛当前运行），UserInteraction 不再直接取消运行。

### 5.4 处理规则

与 M1 Interaction 第 4.4 节相同：不可重入；跨主体 I/O 只登记为待发送；结果检查同步；定时器只入队；请求的响应在处理结束时返回。M2 补充：

1. **两个 Outbox，一个发送器**：运行级与 Session 级事件对同一接收方使用同一个有序发送器，按登记顺序发出（[Fabric](../Infrastructure/Fabric.md) 第 3 节）。
2. **本地 I/O 可以等待**：读写系统级状态与 Session 目录中的 Kernel 文件、ArtifactStore、目录定义，可以在处理函数中 `await`。
3. **持久化**：M2 不按消息持久化运行状态（与 M1 相同）；持久写入的只有审计、Session 引用、信任记录与产物归属。

## 6. 生命周期

### 6.1 新建 Session（`startSession`、`startRun`）

```text
Session 管理受理请求：生成 sessionId；若有打开的 Session，先按第 6.4 节关闭
  → 写入 Session 引用（ACTIVE，仓库根目录取本进程的仓库）
  → 建立 Session actor，投递 SESSION_START
Session actor：
  → Execution 把第一条输入存为产物（storeUserInput），登记归属
  → Session 级 Outbox 发出 SessionCommand(CREATE)（Fork 时为 FORK，阶段 2）
  → 等待 SESSION_COMMAND_REPORT：
       READY  → 开启运行（第 6.3 节），把第一条输入作为开放输入的答复交给 Workflow，开启第一个 Turn
       FAILED → Session 引用改为 DELETED；向 UserInteraction 发出 SessionFailed，关闭 actor
```

### 6.2 打开 Session（`openSession`）

```text
Session 管理检查引用存在、ACTIVE、仓库与本进程一致，否则 SESSION_NOT_FOUND
  → 若有打开的 Session，先按第 6.4 节关闭；建立 Session actor，投递 SESSION_OPEN
Session actor：
  → 读入本 Session 的产物归属索引
  → 发出 SessionCommand(OPEN)，等待回复
       READY  → （阶段 2：比较工作区并发出 WorkspaceDiverged）开启运行；
                有 pendingHumanRequestId 时重新转发该人类请求，否则请求下一个开放输入由 Workflow 发起
       FAILED → 发出 SessionFailed，关闭 actor（引用保持 ACTIVE）
  → 向 UserInteraction 发出 SessionOpened
```

### 6.3 运行

- **开启**：Core 生成 `workflowRunId`，建立运行级分块，投递 `RUN_INIT`；处理 `RUN_INIT` 时开始计时，Outbox 发出 `RunStart`。
- **Turn**：开放输入得到答复时开启、下一次请求开放输入或运行收敛时结束（M2Design 第 2.3 节）。阶段 1 中：
  - 开启：Core 分配 `turnId`，调用 `Monitor.openTurnLedger`，在 `HumanAnswered` 中带上 `turnId`；
  - 结束：`REQUEST_HUMAN(prompt)` 到达时检查没有 ACTIVE 的 AgentRun 与在途尝试，通过后调用 `Monitor.closeTurnLedger`，Outbox 发出 `TurnClosed`；
  - 阶段 2 增加开始与结束快照；阶段 5 增加 Turn 超时。阶段 5 之前，Turn 的时长由每次执行的截止时间（M1 的 `executionLimits`）间接约束。
- **结束**：收敛过程与 M1 Interaction 第 6 节的三步相同。差别：
  - 触发来源：`CLOSE_RUN`（COMPLETED、FAILED、BUDGET、CANCELLED、TIMEOUT）、Session 管理的 `CANCEL_RUN`（ENDED_BY_USER、SHUTDOWN）、
    `KERNEL_FAULT`、结果检查中的 VIOLATION；额度不触发收敛；
  - 开启中的 Turn 在第 ③ 步以 `RUN_CLOSED` 结束，`TurnClosed` 在 `RunClosed` 之前放入 Outbox；
  - `Lease` 与授权条目在第 ③ 步失效；Session 级状态不受影响。

### 6.4 关闭 Session

```text
SESSION_CLOSE（原因：SWITCHED、DELETED、SHUTDOWN）
  → 有运行且不在 CLOSED：按第 6.3 节收敛（closeReason：ENDED_BY_USER 或 SHUTDOWN），等待 CLOSED 与运行级 Outbox 投递完毕
  → 发出 SessionCommand(CLOSE)，等待回复（Workflow 释放 Session 锁）
  → 发出 SessionClosed；Session 级 Outbox 投递完毕后通知 Session 管理回收
```

删除 Session（`deleteSession`）只能针对未打开的 Session：Session 管理把引用改为 DELETED，经 `SessionCommand(DELETE)` 让 Workflow 删除日志，
再删除 Kernel 命名空间中该 Session 的文件；正文在下次启动时回收（[ArtifactStore](../Infrastructure/ArtifactStore.md) 第 4 节）。

### 6.5 运行状态与各请求的处理（阶段 1）

| 消息 | RUNNING | AWAITING_INPUT | CONVERGING | CLOSED |
|---|---|---|---|---|
| `REGISTER_AGENT_RUN`、`SUBMIT_UNIT` | 处理；没有开启中的 Turn 时 `NO_OPEN_TURN` | `NO_OPEN_TURN` | `RUN_BLOCKED` | `RUN_BLOCKED` |
| `END_AGENT_RUN` | 处理 | 处理 | SyscallAck，无效果 | SyscallAck，无效果 |
| `CLOSE_RUN` | 进入收敛 | 进入收敛 | SyscallAck，无效果 | SyscallAck，无效果 |
| `REQUEST_HUMAN(prompt)` | 静止时结束 Turn，进入 AWAITING_INPUT；否则 `AGENT_RUN_ACTIVE` | `REQUEST_CONFLICT`（已有待答复的开放输入） | `RUN_BLOCKED` | `RUN_BLOCKED` |
| `HUMAN_ANSWER` | `HUMAN_REQUEST_NOT_PENDING` | 开启 Turn，回到 RUNNING | `HUMAN_REQUEST_NOT_PENDING` | 同左 |
| `READ_PROJECT_FILE` | 处理 | 处理 | `RUN_BLOCKED` | `RUN_BLOCKED` |
| `AUTHORIZATION_ANSWER`、`READ_ARTIFACT`、`EXECUTION_FACT`、`KERNEL_FAULT` | 与 M1 的 RUNNING 列相同 | 同左 | 与 M1 的 CONVERGING 列相同 | 与 M1 的 CLOSED 列相同 |

状态转移只有：RUNNING ⇄ AWAITING_INPUT；任一非终态 → CONVERGING → CLOSED。阶段 5 增加 PAUSING、PAUSED、INTERRUPTING。

## 7. 一次 `submitUnit` 的内部路径

与 M1 Interaction 第 5 节相同，补充：

- **受理**（第 5.1 节）：在第 2 步之后检查尝试所属的 Turn 处于开启状态，否则 `NO_OPEN_TURN`；第 5 步的 `UNSUPPORTED_CAPABILITY` 改为依据 Unit 定义的能力判断（阶段 2）。
- **权限**（第 5.2 节）：阶段 1 只有 `repo.read`，规则同 M1；阶段 2 起按 [Core](Core.md) 的两步判定。
- **执行**（第 5.3 节）：增加内建 Unit `MESSAGE_PUBLISH`，与 `REPORT_PUBLISH` 一样由 Execution 直接完成；产物引用的归属检查改为"属于本 Session"。
- **结果检查**（第 5.4 节）：UnitReport 带 `unitRunId` 与 `BudgetView`。

## 8. 关闭与故障关闭

- **关闭系统**：`shutdown` → Session 管理标记正在关闭（此后 Session 请求返回 `RUN_LIMIT`）→ 按第 6.4 节以 SHUTDOWN 关闭当前 Session →
  `SupervisorPort.shutdown`（[ModuleHost](../Infrastructure/ModuleHost.md) 第 4 节）。
- **故障关闭**：`abortAllRuns` 与 M1 Interaction 第 7.1 节相同，作用于当前打开的 Session 中的运行；不向 Workflow 发出 `SessionCommand(CLOSE)`，
  Session 锁由下次打开时按过期规则处理。
- 非停机异常与 panic 的规则与 M1 Interaction 第 8 节相同；`STOP_UNCONFIRMED` 改为停机（阶段 3，M2Design 第 4.7 节）。

## 9. 配置（`KernelConfig` 的变化）

| 配置 | 读取者 | 缺省 | 说明 |
|---|---|---|---|
| `repositoryRoot` | Core | 组合根依据工作目录或 `--repo` 写入 | 本进程的仓库，realpath |
| `runTimeoutMs` | — | — | 删除；阶段 5 由 `turnTimeoutSeconds` 取代 |
| `authorizationTimeoutMs` | Core | 300000 | 不变 |
| 其余 | — | — | 与 M1 Interaction 第 9 节相同；`budget` 见 [Monitor](Monitor.md) |

## 10. 不变量与测试

| 不变量（M2Design 第 12 节） | 测试 |
|---|---|
| 5：每个受理的 `submitUnit` 恰好得到一个 UnitReport，或随 RunClosed 结束 | 状态机测试：在各状态下提交、关闭、切换 Session |
| 18：Turn 只由 Kernel 依据开放输入开启与结束；结束时没有 ACTIVE 的 AgentRun 与在途尝试 | 单元测试：`REQUEST_HUMAN(prompt)` 在非静止时被拒；运行收敛时开启中的 Turn 以 `RUN_CLOSED` 结束 |
| 4（阶段 1 部分）：AWAITING_INPUT 时没有 ACTIVE 的 AgentRun 与在途尝试 | 同上 |
| 事件顺序 | 集成测试：`SessionOpened` 先于 `RunStart`；`TurnClosed` 先于 `RunClosed`；`SessionClosed` 是 Session 序列的最后一个 |

## 11. 阶段

本文全部内容属于阶段 1，标注了阶段的部分除外：阶段 2（快照、Fork、工作区差异、两步授权）、阶段 3（停机）、阶段 4（按 AgentRun 分队列、委派、等待调用机会）、
阶段 5（暂停、中止、Turn 超时）。
