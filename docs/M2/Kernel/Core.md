# MultiAgentOS M2 Kernel.Core

> 状态：已实现；发布前再与代码核对一次。

## 1. 定位

Core 负责 Session 与运行的管理、授权、Lease、控制裁决、Turn、结果检查与事件交付，是内外部 syscall 的处理者与 Kernel 对外事件的唯一出口。
组件间交互见 [Interaction](Interaction.md)，长期规划见 [Kernel 架构](../../Architecture/Module/Kernel.md) 第 3、5、6 节。

## 2. 相对 M1 的变化

| M1 | M2 | 依据 |
|---|---|---|
| 运行管理：创建与回收运行 actor | Session 管理：创建与回收 Session actor，持有系统级状态（Session 引用、信任记录） | M2Design 第 2.6 节 |
| 没有 Turn | 依据开放输入开启与结束 Turn，维护 `TurnRecord` | M2Design 第 2.3 节 |
| 人类参与只有授权询问 | 转发人类请求与答复；用户输入的正文交给 Execution 存为产物 | M2Design 第 4.1、4.2 节 |
| 授权只有 `repo.read` | 增加 `project.instructions`（`AGENTS.md` 的信任） | M2Design 第 9.5 节 |
| 同一时刻至多一个 ACTIVE 的 AgentRun | 放开：顶层只有 main，SubAgent 与模板节点可并行 ACTIVE | M2Design 第 7.1 节 |
| Lease = Agent 定义的能力 ∩ 用户授权 ∩ 系统策略，绑定运行 | 能力上限与授权条目两步判定；Lease 是为一次执行签发的许可 | M2Design 第 5 节 |
| 每个运行至多一次 final-call | 每个 AgentRun 至多一次 | M2Design 第 7.3 节 |
| 运行超时由 Core 计时 | 删除；由 Turn 超时取代 | M2Design 第 7.4 节 |
| 上下文规模只由 Executor 裁剪 | Core 在受理 `context-assemble` 时与进入 AWAITING_INPUT 时检查规模，决定并组织压缩（先修剪、再摘要，第 6a 节） | M2Design 第 9.6 节 |
| 用户输入只有开放输入与授权回答 | 运行中插话 `steerRun`：RUNNING 时受理，正文交 Execution 存储后以 `HumanAnswered(kind: steer)` 交给 Workflow | M2Design 第 4.5 节 |
| — | `updateActivity`：待办进度原样放进 ActivityEvent | M2Design 第 3.5 节 |

## 3. 职责

- **Session 管理**：处理 `startSession`、`openSession`、`startRun`、`listSessions`、`deleteSession`、`shutdown`；维护 Session 引用与信任记录；
  按 `sessionId` 分发消息；建立与回收 Session actor（Interaction 第 5、6 节）。
- **Session 命令**：以 Session 级事件向 Workflow 下达 `SessionCommand`，以系统级事件下达 `SessionListQuery`、`SessionDelete`，按 `commandId`、`queryId` 等待并核对回复。
- **运行**：开启运行（生成 `workflowRunId`）、处理 Workflow 的 syscall、维护运行控制状态（RUNNING、AWAITING_INPUT、CONVERGING、CLOSED）与 runEpoch、组织收敛。
- **Turn**：开放输入得到答复时开启，请求开放输入或运行收敛时结束；结束时做静止检查；调用 Monitor 建立与结算 Turn 账本。
- **人类请求**：受理 `requestHuman(prompt)`，转发为 `HumanRequest`；受理 `answerHuman`，由 Execution 存储正文后以 `HumanAnswered` 交给 Workflow。
- **授权**：`repo.read`（M1 原样）与 `project.instructions`（第 5 节）；Lease 只在 Core 内存中。
- **AgentRun 登记**：校验定义与 digest（M1 原样），检查思考强度在 Agent 允许的范围内；登记的 AgentRun 自动归入开启中的 Turn。
- **结果检查与事件交付**：与 M1 相同，UnitReport 增加 `unitRunId` 与 `BudgetView`；每个 AgentRun 至多一次 final-call。
- **审计**：写入本 Session 目录中的 `audit.jsonl`。

## 4. 私有数据

| 数据 | 层次 | 内容 |
|---|---|---|
| Session 引用 | 系统级 | `sessionId → { repositoryRoot, status }`（Interface/Persistence 第 4.1 节） |
| 信任记录 | 系统级 | `(repositoryRoot, path, sha256)` 的集合（Interface/Persistence 第 4.2 节） |
| 系统级 Outbox 与待回复表 | 系统级 | 每个接收方一个 `seq` 计数与待发队列；待回复的列表查询（`queryId`）与删除（`commandId`） |
| Session 命令 | Session 级 | 待回复的 `commandId` 及其用途 |
| Session 级 Outbox | Session 级 | 每个接收方一个 `seq` 计数与待发队列 |
| 运行控制状态 | 运行级 | `runState`、`runEpoch`、`closeReason`、`failure`、`resultRef`、开始与收敛时间、pending 集合 |
| `TurnRecord` | 运行级 | `turnId`、序号、`OPEN` / `CLOSED`、开启时间、结束原因、用量（M2Design 第 2.3 节） |
| 待答复的人类请求 | 运行级 | `humanRequestId → { nodeId, kind }`；至多一个开放输入，其余是局部询问 |
| 请求记录 | 运行级 | 与 M1 相同（`requestId →` 请求摘要与响应），增加 `unitRunId`、`turnId` |
| AgentRun 登记 | 运行级 | 与 M1 相同，增加 `nodeId`、`effort`、`turnId`、`finalCallUsed` |
| 授权记录与 Lease | 运行级 | 与 M1 相同；增加 `project.instructions` 的询问记录 |
| 运行级 Outbox、计时器 | 运行级 | 与 M1 相同；删除运行总时长计时 |

## 5. 授权

### 5.1 `repo.read`

第一个需要它的 Unit 询问一次，同意后本运行内的 AgentRun 都可使用；拒绝绑定提出请求的 AgentRun，它之后同类的 Unit 直接以 `REJECTED(USER_DECLINED)` 交付、不再询问，下一个 AgentRun 可以重新询问（M2Design 第 5.3 节）。`command.exec` 例外：拒绝只绑定被拒的那一条命令（工作目录加命令行），同一 AgentRun 的其他命令照常判定、照常询问。
询问不超时，一直等到用户回答；只在运行收敛时取消（M2Design 第 5.3 节）——这是相对 M1 的变化，M1 的询问计时器与 `authorizationTimeoutMs` 删除。
拒绝作为被拒 Unit 的结果交给 Workflow，不改变运行控制状态与 Turn。

### 5.2 `project.instructions`

`readProjectFile('AGENTS.md')` 的处理（M2Design 第 9.5 节）：

```text
本运行没有 repo.read 的授权 → 先按第 5.1 节询问；拒绝时返回 USER_DECLINED（模板文件同样要经过这一步）
Execution 读取文件（readProjectFile），不存在时返回 exists: false
存在 → 计算 SHA；信任记录中有 (repositoryRoot, path, sha) → 返回 trusted: true
       没有 → 预设为 readonly 时直接返回 trusted: false
             本运行内已对 (path, sha) 选择过不信任 → 直接返回 trusted: false
             否则发起 AuthorizationRequest(project.instructions)，挂起本请求
                 ALLOW  → 追加信任记录（source: USER_CONFIRMED），返回 trusted: true
                 DENY  → 在本运行的内存中记住 (path, sha)，返回 trusted: false
                 运行收敛时取消 → 本请求以 RUN_BLOCKED 结束
```

`path` 为 `'AGENTS.md'`，也可以是子目录的 `AGENTS.md`（M2Design 第 9.5 节）；规则相同，询问展示路径与全文。

- 信任记录是系统级状态，跨运行、跨 Session 有效；它不授予任何执行能力，不是授权条目，也不是 Lease。
- 用户批准的 `AGENTS.md` 写入（根目录或子目录）成功后，新内容的 SHA 自动记为信任（`source: APPROVED_WRITE`）。

## 5a. 两步授权

Lease 由能力上限与授权条目两步判定（M2Design 第 5 节）。判定是纯函数 `decideUnit`，Session actor 按结果行动，判定本身不做 I/O。

### 5a.1 能力上限

AgentRun 登记时计算一次，之后不变，只在 Core 内存中：

```text
capabilities = Agent 定义的 capabilities ∩ 启动预设允许的能力（readonly 只留安全级）
writeRoots   = registerAgentRun.writeRoots（main 为仓库根目录），每一项规范化后必须在仓库内
requestedCapabilities ⊄ capabilities，或 writeRoots 越出仓库 → 登记以 CAPABILITY_NOT_SUBSET 拒绝
```

父 AgentRun 的收窄见第 5d 节。

### 5a.2 能力表

能力的级别写在 Core 的能力表中，Unit 定义只声明能力：

| 能力 | 级别 | 资源键 | 询问 |
|---|---|---|---|
| `repo.read` | 安全 | 仓库根目录 | 第 5.1 节 |
| `workspace.write` | 不确定 | 发起者的可写根目录；条目覆盖其下全部路径 | 没有覆盖的条目时询问一次，`ALLOW` 与 `DENY` |
| `workspace.write`，目标为任一目录的 `AGENTS.md` | 极危险 | 本次写入 | 每个 UnitAttempt 单独询问，只有 `ONCE` 与 `DENY`；不查找已有条目，不合并；询问展示路径与确切内容 |

### 5a.3 判定顺序

对每个需要能力的 Unit 按固定顺序判定（M2Design 第 5.3 节）：

```text
② 能力不在该 AgentRun 的能力上限中                → REJECTED(CAPABILITY_NOT_GRANTED)
③ isWritable(profile, path)                      → WRITE_OUT_OF_SCOPE 或 PROTECTED_PATH
④ 查找覆盖该能力与资源键的条目（极危险级跳过）   → 允许：签发 Lease；拒绝：USER_DECLINED
   该 AgentRun 已拒绝过同一项能力                → USER_DECLINED，不询问（`command.exec`：只对同一条命令）
⑤ 没有条目 → 发起询问，挂起尝试；相同询问合并；回答形成条目后回到 ④
判定过程本身出错                                 → REJECTED(ADMISSION_CHECK_FAILED)
```

第 ① 步（`deniedCommands`、`deniedDomains`）随命令与网页能力一起判定。
`file-write`、`file-edit` 的资源键从 Unit 输入的 `path` 提取；`isWritable` 与 Executor 使用同一个函数（`contracts` 的 `isWritable`）。

### 5a.4 授权条目

条目为 `(能力, 资源键, 有效范围, ALLOW | DENY)`，属于 WorkflowRun，只在内存中，运行结束时失效。`ONCE` 的条目在该 UnitAttempt 结束时作废。
拒绝绑定提出请求的 AgentRun（第 5.1 节的规则推广到每项能力）。`AGENTS.md` 的写入成功后，Execution 报告新内容的 SHA，Core 追加信任记录（`source: APPROVED_WRITE`）。

### 5a.5 回退的发起与确认

Core 受理 `undoTurns`、`confirmUndo`、`diffTurns`（只在 AWAITING_INPUT，否则 `UNDO_NOT_AVAILABLE`），调用 Execution（[Execution](Execution.md) 第 6c 节）：

```text
undoTurns → Execution.planUndo
  没有可回退的 Turn → NOTHING_TO_UNDO
  没有外部修改      → Execution.applyUndo，发出 WorkspaceReverted
  有外部修改        → 记录 undoId，向 UserInteraction 发出 UndoConfirmationRequested
confirmUndo(FORCE)  → 拍兜底快照，Execution.applyUndo；复查失败时恢复并重新发出确认
confirmUndo(CANCEL)、下一条 answerHuman、切换或关闭 Session → 发出 UndoCancelled，不修改文件
```

确认不是授权询问，不产生授权条目，也不进入模型上下文。

## 5b. 命令的授权与沙盒

`run_command` 需要 `command.exec`（危险级），`network: true` 时另需 `command.network`（极危险级，只有 main 的能力白名单中有）。判定顺序不变（第 5a.3 节），命令加入以下规则：

```text
① 命令按语法树拆分（ExecutorSet command/parse/，经注入的 CommandAnalyzer）；任一子命令或原始文字命中 deniedCommands → REJECTED(COMMAND_DENIED)
② command.exec 不在能力上限中                                     → CAPABILITY_NOT_GRANTED（readonly 预设下工具本来就不出现）
   沙盒不可用且 sandbox.unavailable = 'deny'                         → REJECTED(SANDBOX_UNAVAILABLE)
④ 查找覆盖本命令的条目：每个子命令都被某条目覆盖才算覆盖
   ④b 只读命令行（分析给出 readOnly，不命中名单、不联网、沙盒可用，M2Design 第 5.2 节"只读名单"）：
       不单独询问，需要 repo.read：已有 Lease → ALLOW（readOnly），沙盒的可写根目录为空；
       没有 Lease → 询问 repo.read（问的是读取仓库）；本 AgentRun 拒绝过 repo.read → 按普通命令继续往下判
       不打开仓库文件的命令行（readsRepository = false，如 echo、pwd）连 Lease 也不要；放行写入审计 COMMAND_READ_ONLY
     条目的资源键：(规范化的子命令文字, 工作目录) 为 COMMAND 条目；前缀 + 工作目录范围为 PREFIX 条目
     命中 criticalCommands、network: true、沙盒不可用（ask-unisolated）→ 极危险级：不查条目，每次询问
⑤ 没有覆盖 → 询问，展示：确切的命令、工作目录、SandboxProfile 摘要（可写根目录、联网与否、是否未隔离）、approvalDigest
```

- **询问选项**：危险级为 `ONCE`（单次）、`COMMAND`（本运行内这条命令均允许）、`PREFIX`（本运行内这个命令前缀均允许）、`DENY`；极危险级只有 `ONCE`、`DENY`，以警示样式显示。
  **解析不可靠时**（`unreusable` 不为空：语法错误、命令名不是字面量、命令替换、进程替换、`eval`、`sh -c`、通往 shell 的管道、heredoc 作为 shell 的输入）、沙盒不可用、命中名单时，只提供 `ONCE` 与 `DENY`。
  `PREFIX` 选项只在每个子命令都能得出前缀时提供；一个条目不跨工作目录。
- **相同的询问合并**：同一运行内两个 UnitAttempt 需要相同的（规范化命令、工作目录）时挂在同一个询问上；极危险级不合并。
- **拒绝**：绑定提出请求的 AgentRun，与其他能力相同（M2Design 第 5.3 节）。
- **SandboxProfile**：签发 Lease 时由 Core 计算静态部分（第 2 节 Interface/KernelSupervisor），随 `ExecutionScope` 交给 Execution，由它补上扫描的列表。

**EXEC 互斥**：同一时刻至多一个 EXEC 在派发（`maxConcurrentExec = 1`），由 Execution 持有；等待授权与排队的尝试不占用。

**停机**：Execution 报告 `STOP_UNCONFIRMED` 时，Core 不收敛这一个运行，而是经 `reportSystemFault` 请求停机（M2Design 第 4.7 节）：封锁新的请求，对全部残余执行发出取消，写审计（Unit、进程、已知效果），界面显示"无法确认 <命令摘要> 已停止"，进程以非零退出码退出。

## 5c. 中断的统一入口与内存压力

M2Design 第 7.7 节。Core 为运行增加控制状态 `INTERRUPTING` 与一个入口 `interrupt(reason)`；内存压力、用户中止、Turn 超时、暂停超时都使用这同一个入口。

| 来源 | Core 的处理 |
|---|---|
| `MemoryPressure(source = SYSTEM)` | 只通知与记录（系统级 `memory-events` 记录，界面提示），不拒绝任何工作，不收尾，不中断 |
| `MemoryPressure(PROCESS, WARNING)` | 记入审计；拒绝登记新的 AgentRun 与开启新的 Turn（`MEMORY_PRESSURE`）；每个 ACTIVE 的 AgentRun 收到 `QUOTA_EXHAUSTED`（`quota = 'MEMORY'`），Workflow 进入 `wrapUpReason = MEMORY_LIMIT`，走统一收尾路径，结束后留下报告 |
| `MemoryPressure(PROCESS, DANGER)` | 运行进入 INTERRUPTING：Outbox 先向 Workflow 发出 `RunInterrupted(MEMORY_PRESSURE)`，随后取消待答复的询问、在途与排队的尝试，拒绝新的 AgentRun 与除 `message-publish` 之外的 Unit（`MEMORY_PRESSURE`）；运行保持打开，让 Workflow 发布一条不经模型的回复并 `closeRun(INTERRUPTED)`。Workflow 在 `interruptBackstopMs`（缺省 `cancelGraceMs + convergenceMarginMs + 10 秒`）内没有关闭时，Kernel 自己关闭。运行关闭后对话仍打开，界面说明原因，用户的下一条消息开启新的运行；一次性命令以退出码 75 退出。没有运行或没有打开的 Session 时只通知与记录，不退出 |

- 同一级别不重复处理；级别回落后再次升高会再次触发。已发生的收尾不撤销，但拒绝新工作以采样器当前的级别为准：回落后新的 AgentRun 与工具即可继续。
- 任一运行无法确认停止时按第 5b 节的停机处理。
- 内存采样在 Monitor（[Monitor](Monitor.md) 第 4a 节），Core 只处理控制消息，不持有采样器。

## 5d. SubAgent 的登记、委派与写入占用

设计以 M2Design 第 3.6、6.4、7.3 节为准。实现在 `session/run-work.ts` 与纯函数部分 `session/run-delegations.ts`。

**`reserveDelegation`**（Workflow → Core）：请求带父 AgentRun 与各任务的名称、Agent 引用、写入根目录和（可选的）份额。依次判定：运行可接受工作；没有内存压力；父 AgentRun 存在且未结束；父的能力上限含 `agent.spawn`（否则 `FORBIDDEN`）；任务名不重复；每个 Agent 存在、摘要一致、可被派生（有缺省份额，否则 `FORBIDDEN`）；写入根目录合法且落在父的可写范围内（否则 `CAPABILITY_NOT_SUBSET`）。份额取请求的值，限制在 `[minShare(Agent), 缺省份额的 2 倍]` 内，被限制的在回复里标出 `MIN` 或 `MAX`。然后向 Monitor 一次性划出全部份额，不足时整次不执行，回复 `BUDGET_INSUFFICIENT` 并带可委派余额。成功时回复 `delegationId`（前缀 `dlg`，Core 生成）与各任务的份额。

**`registerAgentRun` 带 `parentAgentRunId`、`delegationId`、`taskName`**（三项同有同无，否则 `INVALID_INPUT`）：父存在且未结束；任务在该委派中且没有被登记过、没有被放弃（否则 `DELEGATION_NOT_FOUND`）。SubAgent 的能力上限不得超过父的能力上限，不得含 `agent.spawn`，写入根目录须落在它的任务范围内（否则 `CAPABILITY_NOT_SUBSET`）。运行中的 AgentRun 写入占用两两不相交：与任何一个运行中的、不是它祖先的、没有把占用委派出去的 AgentRun 相交，登记被拒（`WRITE_SCOPE_CONFLICT`）。登记成功时任务的份额成为它的账本，Monitor 为它计时（墙钟）与计工具次数。

**写入占用的委派**：父在派生期间（有任务在运行，或有任务尚未登记也尚未放弃）不占用写入根目录，也不参与相交检查；它此间提交的 `FILE_WRITE`、`FILE_EDIT`、`COMMAND` 一律以 `WRITE_SCOPE_DELEGATED` 拒绝（验收 P6）。父的墙钟在等待子任务期间不计时。

**`releaseDelegation`**：Workflow 在这次调用被唤醒（`NODE_RESUMED`）时调用，没有登记的任务的份额还给父；委派随之结束（父的占用恢复）。不认识的委派以 `DELEGATION_NOT_FOUND` 拒绝；运行收敛时无效果地接受。

**`endAgentRun`**：SubAgent 的账本结束，未用的份额还给父，任务不再占用写入根目录。

- 同一时刻至多一个没有父的 ACTIVE 的 AgentRun（并行的模板节点由使用者模板放开，M2ReleasePlan phase 2）。
- `agent.spawn` 在 `readonly` 预设下保留：派生出的 SubAgent 的能力受父的能力上限限制，写入类 SubAgent 在 `readonly` 下登记不了。
- 测试：`run-work.test.ts` 的 "SubAgents"、`run-delegations.test.ts`。

## 5e. 运行控制：暂停、继续、中止、运行中插话与 Turn 超时

设计以 M2Design 第 4.3–4.5、7.4、7.6 节为准。`RunPhase` 在 `RUNNING`、`AWAITING_INPUT`、`CONVERGING`、`CLOSED` 之外增加 `PAUSING`、`PAUSED`、`INTERRUPTING`。"正在中断"标志（`RunWork` 内的 `#interrupting`）并入 `RunPhase`：中断只有这一个状态来源，不再有第二个布尔量。

**消息与转移**（`session/run-control.ts` 的纯函数，Core 的其余部分只调用它）：

| 消息 | 来自 | 检查 | 动作 |
|---|---|---|---|
| `pauseRun` | UserInteraction | 运行为 RUNNING，且有开启中的 Turn（否则 `REQUEST_CONFLICT`） | 进入 PAUSING；Execution 按并发类别收敛在途尝试（[Execution](Execution.md) 第 4e 节）；在途为 0 时进入 PAUSED，Outbox 向 Workflow 发出 `RunPaused`，向 UserInteraction 发出 `RunStateChanged`；PAUSED 开始计 `maxPauseSeconds` |
| `resumeRun({ steer? })` | UserInteraction | 运行为 PAUSED（否则 `REQUEST_CONFLICT`） | `steer` 带内容时先经 `Execution.storeUserInput` 存正文；进入 RUNNING；Outbox 向 Workflow 发出 `RunResumed`（带 `steer` 的 `inputId`、`contentRef`、`targetAgentRunId?`）；保留在队列中的尝试依次派发 |
| `interruptRun` | UserInteraction | 运行为 RUNNING、PAUSING 或 PAUSED（其余 `REQUEST_CONFLICT`；已在 INTERRUPTING 时无效果地接受） | `interrupt(USER_ABORT)` |
| `steerRun({ target?, input })` | UserInteraction | 运行为 RUNNING 且有开启中的 Turn（PAUSING、PAUSED 时由 `resumeRun` 携带，其余状态 `REQUEST_CONFLICT`）；`target` 若给出，必须是本运行的 AgentRun | 存正文；Outbox 向 Workflow 发出 `HumanAnswered(kind: 'steer')`（带 `targetAgentRunId?`，不带 `turnId`，不开启 Turn） |
| 暂停超时、Turn 超时（Core 内部的计时） | — | — | `interrupt(PAUSE_TIMEOUT)`、`interrupt(TURN_TIMEOUT)` |

**`interrupt(reason)`**：`reason` 为 `MEMORY_PRESSURE`、`USER_ABORT`、`TURN_TIMEOUT`、`PAUSE_TIMEOUT`。处理顺序固定：

1. 运行进入 INTERRUPTING；Outbox 先向 Workflow 发出 `RunInterrupted(reason)`，随后向 UserInteraction 发出 `RunStateChanged(INTERRUPTING)`；
2. 取消待答复的授权询问（`AuthorizationResolved(CANCELLED)`）与人类请求：向 Workflow 发出 `HumanCancelled { nodeId, humanRequestId, reason }`，向 UserInteraction 发出 `HumanResolved(CANCELLED)`；
3. 取消在途与排队的尝试，全部以 `INTERRUPTED(ABORTED)` 交付（Execution 第 4e 节）；
4. 此后拒绝 `registerAgentRun` 与除 `message-publish` 之外的 `submitUnit`（`RUN_BLOCKED`），放行 `endAgentRun`、`requestHuman(prompt)`、`closeRun`；
5. Workflow 收敛节点后，按运行的形态结束：Turn-chat 请求下一个 `HUMAN(prompt)`，在途为 0 时 Kernel 以 `ABORTED` 结束本 Turn，运行进入 AWAITING_INPUT（运行保持打开）；Orchestration `closeRun(CANCELLED | TIMEOUT)`，运行进入 CONVERGING；`MEMORY_PRESSURE` 仍是 `closeRun(INTERRUPTED)`（第 5c 节）；
6. `interruptBackstopMs` 内 Workflow 没有结束时，Kernel 自己关闭运行（规则不变）。

`TurnClosed` 的原因增加 `ABORTED`；一个 Turn 以 `ABORTED` 或 `TIMEOUT` 结束后，属于它的 `submitUnit` 一律以 `NO_OPEN_TURN` 拒绝。

**计时**（`session/wall-clocks.ts` 已按"等待人类、等待授权不计时"的规则计 AgentRun 的墙钟，暂停复用同一判断）：
- **Turn 超时** `turnTimeoutSeconds`（Turn-chat 缺省 1800；Orchestration 运行整体是一个 Turn，缺省 3600）：从 Turn 开启计起；PAUSING 与 PAUSED 的时间不计；全部工作都在等用户的时间不计（没有已派发的尝试、没有排队或等待调用机会的尝试，且至少有一个待答复的人类请求或授权询问；挂起在授权询问上的尝试不算已派发）。到点 `interrupt(TURN_TIMEOUT)`。
- **暂停上限** `maxPauseSeconds`（缺省 1800）：从进入 PAUSED 计起，到点 `interrupt(PAUSE_TIMEOUT)`。
- Core 在每次处理消息的末尾重新判断，只为最早可能到点的计时设一个定时器，与 AgentRun 墙钟共用同一个定时器。
- 授权询问与人类请求本身不超时。

**交付条件**（第 7.6 节）：尝试的 `runEpoch` 等于当前值，且运行处于 RUNNING、PAUSING、PAUSED、INTERRUPTING 或 AWAITING_INPUT；`runEpoch` 只在进入 CONVERGING 时前进，暂停与中止都不改变它。

**准入表**（`run-control.ts`）：

| 状态 | `registerAgentRun`、`submitUnit` | 人类请求与授权答复 |
|---|---|---|
| RUNNING | 受理 | 受理 |
| PAUSING、PAUSED | 受理，但尝试保留在队列中不派发 | 授权询问与人类请求可以回答，答复在继续后生效；`requestHuman(ask/confirm/review)` 受理但在继续前不展示给用户 |
| INTERRUPTING | `RUN_BLOCKED`（`message-publish` 除外） | 取消，不再受理新的 |
| AWAITING_INPUT、CONVERGING、CLOSED | 与 RUNNING 相同 | 与 RUNNING 相同 |

- **局部询问**：`requestHuman(ask | confirm | review)` 只阻塞附属的调用方 AgentRun，运行仍是 RUNNING；它的请求不要求静止，不结束 Turn，也不引起 AWAITING_INPUT。每个局部询问带 `attachedAgentRunId`（发起 `ask_user` 的 AgentRun）。Kernel 只区分开放输入与局部询问两类（M2Design 第 4.2 节）。
- **答复校验**：Kernel 不解释答复；`answerHuman` 对局部询问只检查 `humanRequestId` 待答复。字段是否符合 `answerSchema` 由 UserInteraction 先行检查、Workflow 最终校验（[Workflow](../Module/Workflow.md) 第 7b 节）。
- **审计**：`RUN_PAUSED`、`RUN_RESUMED`、`RUN_INTERRUPTED`（原因）、局部询问的请求与取消都写审计；暂停时长记入 Turn 的用量摘要，不计入墙钟。
- **不变量**：4（PAUSED 时在途尝试数为 0）与 18（AWAITING_INPUT 时没有 ACTIVE 的 AgentRun 且在途为 0）原样成立；新增：INTERRUPTING 之后的 `submitUnit` 一律 `RUN_BLOCKED`；`runEpoch` 不因暂停与中止前进。
- 测试：`run-control.test.ts`（状态转移与准入表，纯函数）、`session-actor.test.ts`（暂停到 PAUSED 的时序、暂停超时、Turn 超时与"等用户时冻结"、中止后回到 AWAITING_INPUT 与 Turn 的 ABORTED）、`run-work.test.ts`（中止时询问被取消、局部询问不要求静止）。

## 5f. 网页能力：`web.search` 与 `web.fetch`

设计以 M2Design 第 5.3、8.1 节为准。能力表（第 5a.2 节）增加两行，判定顺序（第 5a.3 节）不变，第 ① 步在这里补上：

| 能力 | 级别 | 资源键 | 询问 |
|---|---|---|---|
| `web.search` | 不确定 | 无（整个能力） | 每个 WorkflowRun 第一次使用时询问一次；回答 `ALLOW`（本次运行）、`FOLDER`（这个文件夹以后都允许，见下）或 `DENY`；询问写明查询会发给哪个提供方 |
| `web.fetch` | 不确定 | 主机名（小写，国际化域名转为 ASCII）；条目覆盖这个主机，`ANY_HOST` 的条目（资源键 `*`）覆盖所有公开主机 | 每个新主机第一次访问时询问一次；回答 `ALLOW`（只这个主机，本次运行）、`ANY_HOST`（本次运行内所有公开网站）或 `DENY`；询问写明主机名与完整地址 |

**第 ① 步**（在能力上限检查之后、查找条目之前）：
- `web.fetch` 的地址里有字面量的 IP 或 `localhost`、`*.localhost`、`*.local`、`*.internal`、单标签名，落在 ExecutorSet 第 5d 节的禁止范围内：`REJECTED(ADDRESS_FORBIDDEN)`，**不询问**；协议不是 `http(s)`、带用户信息或无法解析的同样拒绝（判断用 contracts 里与 Executor 相同的 `checkUrlLiteral`）；
- 主机名命中 `kernel.web.deniedDomains`（按后缀匹配，如 `example.com` 也覆盖 `a.example.com`）：`REJECTED(DOMAIN_DENIED)`，不询问。

要点：
- 询问的合并与拒绝的绑定与其他能力相同（第 5a.4 节）：并行的 explorer 访问同一个新主机时合并为一个询问；用户拒绝后，Core 的拒绝条目绑定这个 AgentRun 与这个主机（条目的 `hostKey`），同一主机不再询问，其他主机照常询问；`ask_user` 里的同意不产生授权（第 5.5 节）。Workflow 另外按工具名记住被拒绝的工具（所有工具相同，Workflow 第 7 节），所以同一个 AgentRun 之后的 `web_fetch`（含其他主机）不经 Core，直接得到"用户拒绝了这个工具"的结果；下一个 AgentRun 可以重新询问。
- **"本次运行内所有公开网站"（`ANY_HOST`，只对 `web.fetch`）**：回答之后，条目 `resourceKey: '*'` 覆盖这个运行内所有公开主机，同时正在等待的其他主机的询问一并以 GRANTED 结束（`settleCovered`，只结束被条目覆盖的 `web.fetch` 询问）。它**不取消**第 ① 步：私网、回环、链路本地、云元数据地址仍然 `ADDRESS_FORBIDDEN`，`deniedDomains` 仍然 `DOMAIN_DENIED`，用户之前拒绝过的主机仍然 `USER_DECLINED`。它只管本次运行，不跨运行、不写盘。放宽之后，网址能带走多少数据由 Executor 一侧限制：网址最长 800 个字符，查询值里长度不少于 32、只含令牌字符、不是十六进制（提交哈希）、熵不小于 4.3 比特/字符的值（base64、密钥的样子）整个调用以 `SECRET_IN_REQUEST` 拒绝（`carriesData`，与密钥扫描同一条路径，不说明匹配了什么）；一个 AgentRun 能发多少次抓取仍由它的 `maxToolUnits` 限制。
- **"这个文件夹以后都允许"（`FOLDER`，只对 `web.search`）**：回答之后本次运行照常得到条目，并且 Session 管理把这个仓库根目录记进系统级的 `kernel-core/trusted-web-search.jsonl`（Interface/Persistence 第 4.6 节）；之后在这个文件夹里开始的运行一开始就带着这个条目，不再询问。它是授权"只管本次运行、恢复的会话不复用授权"的一个明确例外，范围只有 `web.search` 这一项能力：不含 `web.fetch`，不含命令。撤销：删除该文件里这个仓库的行（或整个文件）。
- **与命令联网隔离**：`command.network` 是另一项能力，极危险级，每次单独询问，只有 main 的能力白名单里有；`web.search`、`web.fetch` 的任何条目（包括 `ANY_HOST` 与 `FOLDER`）都不进入命令的判定，命令的判定也不读它们。`web-authorization.test.ts` 固定这一点：全部网页条目都在时，`network: true` 的命令仍是 `ASK`（critical）；Agent 的上限里没有 `command.network` 时仍是 `CAPABILITY_NOT_GRANTED`。
- 能力上限：main 与 explorer 的定义声明两项能力；worker 不声明（它改文件、跑命令，不联网）。一个 AgentRun 的上限里没有它们时是 `CAPABILITY_NOT_GRANTED`。两项能力把数据发出本机，不属于安全能力：`readonly` 预设下它们被去掉（`capabilitiesUnderPreset`）。资源键里的主机只按原样比较（`a.example` 的授权不覆盖 `b.a.example`），不像写入根那样按路径包含。
- 配置 `KernelConfig.web`：`deniedDomains: string[]`（缺省空）、`maxContentBytes`（缺省 2097152）、`search: { provider: string, baseUrl }`（缺省 `deepseek`）、`fetch: { remote: { provider: string, baseUrl } | null }`（缺省 `deepseek`；本地抓取总是先用，`remote` 只在它做不到时才用，`null` 表示不用）。`provider` 是 ExecutorSet 第 5d 节注册表里的名字，也是密钥的名字（`<NAME>_API_KEY`），密钥不在配置里；名字不存在在系统启动时报错。询问里写明的"搜索词发给谁"就是这个名字。
- 审计：授权的询问与回答、拒绝都写审计（已有机制）；`WEB_SEARCH`、`WEB_FETCH` 行由 Execution 写（`kernel-core/audit.jsonl`，内容见 ExecutorSet 第 5d 节）。询问事件 `AuthorizationRequest` 带 `capability: 'web.search'`（`queries`、`provider`）或 `'web.fetch'`（`url`、`host`），回答是 `ALLOW`、`DENY`，`web.fetch` 还可以是 `ANY_HOST`，`web.search` 还可以是 `FOLDER`；一个问题不提供别的问题的回答（`offers`）。
- 界面：询问的文字、活动区的 `web_search`、`web_fetch` 行与折叠行（UserInteraction 第 6 节增补）。
- 测试：`unit-decision.test.ts`（两项能力的资源键、第 ① 步的两种拒绝、拒绝绑定主机、readonly）、`web-authorization.test.ts`（`ANY_HOST`、`FOLDER`、与命令联网隔离）、`run-work.test.ts`（询问流程、范围为 `NONE`、`ANY_HOST` 结束同时在等的其他询问、`FOLDER` 被记下）、`web-exit`（W1–W3、A 组网页部分）。

## 5g. 交接带的产物：`retainArtifacts`

设计以 M2Design 第 3.7 节 0a 为准。Workflow 登记一次交接（`REFERENCES_REGISTERED`）之前调用 `retainArtifacts`，请 Kernel 把交接带的产物改为随 Session 保留。

- **为什么需要**：工具结果的预览随 Session 保留，完整输出只保留 `expiringRetentionDays`（缺省 7 天）。交接给别的 AgentRun 的完整输出要和登记表一样长久，否则登记还在、内容已经没有。
- **做什么**：对 `refs` 中每一项，若它是本 Session 的、没有过期、且不是 `SESSION`，就追加一行 `SESSION` 的登记（保留 `fullOutput` 标记，`retainedSince` 取现在）；已经是 `SESSION` 的不动。
- **全有或全无**：有一项不属于本 Session 或已过期时，什么都不改，以 `INVALID_ARTIFACT_REF` 拒绝（`issuer: CORE`），Workflow 因此不登记这次交接。
- **幂等**：同一个 `requestId` 重复请求得到同一个应答（与其他 syscall 相同，第 2 节）；再次保留已经保留的产物不写新行。
- **只处理引用**：Kernel 不看产物的内容，也不判断谁能读；谁能读由 Workflow 的登记表决定。

## 5h. 读取工作区之外的文件：`external.read`

设计以 M2Design 第 5.2、8.1 节为准。能力表（第 5a.2 节）增加一行，判定顺序（第 5a.3 节）不变。三个外部读取工具（`list_external_files`、`read_external_file`、`search_external_repository`）是三个 Unit（`external-list`、`external-read`、`external-search`），分别沿用 `REPOSITORY_LIST`、`FILE_READ`、`REPOSITORY_SEARCH` 的 Executor，声明 `external.read` 代替 `repo.read`（目录清单会检查：这三种 Unit 之外不能声明它，也不能同时声明两者）。

| 能力 | 级别 | 资源键 | 询问 |
|---|---|---|---|
| `external.read` | 危险 | 授权目录的真实路径（绝对）；条目覆盖这个目录和它下面的全部路径，按路径包含比较（`/x/proj` 不覆盖 `/x/project`） | 每个 WorkflowRun 内，每个外部仓库第一次读取时询问一次；回答 `ALLOW`（本次运行）或 `DENY`；询问写明授权的目录、被请求的路径和内容发给谁 |

**路径的处理**（`session/external-read.ts`，在判定之前做，判定本身仍是纯函数，只看到"授权目录"或"读不了"）：
1. 路径必须是绝对路径（`C:\x` 形式在 WSL 下转成 `/mnt/c/x`）；不含空字符，长度不超过 1024；相对路径、不存在的路径一律是"读不了"。
2. 取 `realpath`：符号链接按它指向的真实位置判断，链接本身的名字不起作用；目标必须是文件或目录。
3. 工作区内的路径是"读不了"（那是 `read_file` 的事，系统不为同一处内容开第二条授权路径）。
4. 拒绝名单（`isDeniedRoot`，对真实路径检查，范围包括它下面的一切）：系统根目录和只有一段的路径（`/`、`/opt`、`/tmp`……）；`/proc`、`/sys`、`/dev`、`/etc`、`/root`、`/boot`、`/run`、`/var`、`/bin`、`/sbin`、`/lib*`、`/snap`；`/home/<用户>` 与 `/Users/<用户>` 本身（别人的主目录）；当前用户的 `$HOME` 本身以及它下面以点号开头的一切（`~/.ssh`、`~/.config`、`~/.claude`……）；`/mnt/<盘符>` 本身、`/mnt` 下不是盘符的挂载（`/mnt/wsl`）、Windows 盘上的系统目录（`Windows`、`Program Files*`、`ProgramData`……）、`Users` 与 `Users/<用户>` 本身及用户目录里的点号目录和 `AppData`；系统数据目录（`dataDir`）及其下一切。"根目录"在这里指文件系统的根 `/`，也包括任何只有一段的路径：它们太大，不是一个项目。
5. 找授权目录：已经有条目覆盖这个路径时，取最深的那个条目的目录（所以一次回答覆盖仓库里之后的任何文件，不因文件所在的子目录变化而再问）；否则目录路径本身就是授权目录；文件路径取它所在的 git 仓库的根（向上找 `.git`，找到的目录不能落在拒绝名单里），找不到就取文件所在的目录。授权目录落在拒绝名单里、或在工作区里，也是"读不了"。
6. 授权目录之外，另有这些排除规则：默认排除规则、会话自己的规则，加上凭据的位置（`**/.ssh/**`、`**/.aws/**`、`**/.gnupg/**`、`**/.kube/**`、`**/.docker/**`、`.npmrc`、`.netrc`、`.pgpass`、`*.p12`、`*.pfx`、`*.jks`、`*.keystore`）；数据目录若在授权目录之下，也加成一条排除规则（规则写不出来就不授权）。

**"读不了"与"没有授权"是两回事**：所有"读不了"的情形（不存在、不是绝对路径、在工作区里、命中拒绝名单、授权目录非法）都返回同一个 `REJECTED(EXTERNAL_PATH_UNAVAILABLE)`，**不询问**，也不说明是哪一种，避免模型借错误信息探测机器的目录结构（系统本身也从不提供工作区之外的路径）。读到的文件被排除规则挡住时，Executor 返回 `OUT_OF_SCOPE`，同样不说明原因。

**授权与范围**：
- 拒绝绑定这个 AgentRun 与这项能力（和 `workspace.write` 相同），同一个 AgentRun 之后的外部读取直接得到 `USER_DECLINED`；Workflow 另外按工具名记住被拒绝的工具，三个工具各自记。条目只在本次运行里，不跨运行、不写盘；没有"以后都允许"。
- 询问合并：同一个授权目录的并行询问合并为一个。
- 请求的范围：`REPOSITORY`，`repositoryRoot` 是授权目录，`exclusions` 如上，另带 `external: { below }`（`below` 是请求的路径相对授权目录的路径，空串表示整个目录）。Kernel 把 Unit 的输入改写成相对授权目录的路径（`read`、`list` 的 `path`；`search` 的 `path`，整个目录时省略）；Executor 只看到相对路径。Executor 另外自己检查调用没有越过 `below`（ExecutorSet 第 5e 节）。
- 命令与沙盒不变：命令仍只在工作区里运行，不能读外部目录，也不能借 `external.read` 写任何东西。
- 审计：每次放行写一行 `EXTERNAL_READ`（请求、AgentRun、种类、被请求的路径、授权目录）；询问与回答、拒绝走已有的审计。

**连续两次失败就暂停**：每个 WorkflowRun 里，Kernel 记录外部读取的失败：`EXTERNAL_PATH_UNAVAILABLE`、用户拒绝（`USER_DECLINED`）、Executor 拒绝或失败（含 `OUT_OF_SCOPE`、`NOT_FOUND`、`INVALID_RANGE`）；成功的一次读取把计数清零，被暂停或中止打断的不计。连续两次失败时：
1. 向 UserInteraction 发 `ExternalReadPaused { attempts }`（两次的路径与原因：`UNAVAILABLE`、`DECLINED`、`FAILED`），控制台用红字显示 Agent 想读哪里；
2. 暂停这个运行（第 5e 节的机制，和用户按 Ctrl+C 暂停一样）；
3. 计数立即清零，`resumeRun` 时再清零一次；所以继续之后重新计数，不会连着触发。
用户的选择：`/continue <正确的路径>`（说明作为插话交给 Agent）、Ctrl+C 中止、`/undo` 回退这一轮。Workflow 对这类失败**不计入**连续出错与"无进展"（Workflow 第 7 节），否则它会在暂停之前就让 Agent 收尾，用户继续时 Agent 只剩一次收尾调用。

- 测试：`external-read.test.ts`（拒绝名单、授权目录的各种形状、符号链接、数据目录、判定与询问）、`run-work.test.ts`（询问一次、范围与输入的改写、无法读取不询问、暂停与重新计数、用户拒绝的计数）、`external-read-exit`（X1–X3：三个工具、秘密文件、链接、系统路径、工作区、拒绝、暂停与继续）。

## 6. Turn 与人类请求

| 消息 | 检查 | 动作 |
|---|---|---|
| `REQUEST_HUMAN(prompt)` | 运行为 RUNNING；没有 ACTIVE 的 AgentRun；没有在途尝试 | 结束开启中的 Turn（如有；`closeTurnLedger`，`TurnClosed(COMPLETED)`）；记录待答复的请求；Outbox 向 UserInteraction 发出 `HumanRequest`；运行进入 AWAITING_INPUT |
| `HUMAN_ANSWER` | 运行为 AWAITING_INPUT；`humanRequestId` 待答复 | `Execution.storeUserInput`；分配 `turnId`，`openTurnLedger`；Outbox 向 Workflow 发出 `HumanAnswered`，向 UserInteraction 发出 `HumanResolved(ANSWERED)`；运行回到 RUNNING |
| 新建 Session 或 `startRun` 的第一条输入 | 运行刚开启（`RunStart(initialInput: true)`） | 同上，`origin = 'initial'`，没有 `humanRequestId` |

- `openTurnLedger` 总是开启 Turn。正常情况下运行级余额足够：上一个 Turn 中 `BudgetView.run` 已按"Turn 结束时的余额"告知 WRAP_UP，
  Workflow 会以 `closeRun(BUDGET)` 结束运行而不是请求下一个开放输入（[Monitor](Monitor.md) 第 3.1 节）。份额仍不足 `minShare(main)` 时
  （防御性情况），Turn 账本状态直接为 WRAP_UP，Workflow 让 main 只做收尾调用，额度不足以收尾时以降级回复结束，然后报告结束（M2Design 第 7.3 节）。
- `answerHuman` 以 `inputId` 去重：同一 `inputId` 重复提交返回第一次的响应。

## 6a. 上下文压缩

Core 是压缩过程（M2Design 第 9.6 节）的组织者：

| 步骤 | Core 的动作 |
|---|---|
| 检查点 | 受理普通调用的 `context-assemble` 时，请 Execution 估算组装后的输入（实测加估算，Execution 第 6a 节）；超过 `compaction.triggerRatio × perCallInputLimit`，或该 AgentRun 上一次 `model-call` 以 `CONTEXT_OVERFLOW` 返回，即开始压缩，挂起这次组装；对象为 main、模板节点或 SubAgent |
| 用户触发 | 受理 `compactContext`：运行为 Turn-chat 且处于 AWAITING_INPUT，对象为 main 的投影；main 的 Agent 由目录取得（M2Design 第 9.6 节"压缩所用的 Agent"），不需要这个进程里已有 main 的 AgentRun |
| 额度 | 写摘要之前请 Monitor 预留（Monitor 第 3.5 节）；额度检查的结果先记下：不足时只修剪，修剪后仍超出时挂起的组装以 `BUDGET_WRAP_UP` 返回；用户触发时发出 `CompactionFailed(BUDGET_INSUFFICIENT)` |
| 材料 | 审计 `COMPACTION_STARTED`；Outbox 发出 `CompactionSourceQuery`，按 `compactionId` 等待 `reportCompactionSource` |
| 修剪 | 按 M2Design 第 9.6 节第 4.5 步划出保留区并选出候选，请 Execution 修剪（Execution 第 6a 节）；有结果时 Outbox 发出 `ToolResultsPruned`，等待 `ackCompaction(stage: PRUNE, RECORDED)`；生效后重新估算，已低于目标（自动、溢出）时结束，挂起的组装以 `REJECTED(CONTEXT_COMPACTED)` 返回 |
| 范围 | 按 M2Design 第 9.6 节第 5 步选定，并按"条目的分级"从范围内的用户消息里选出原样保留的 `keptSeqs`（不超过 `keepHumanBytes`，从新到旧累计，单条超过一半的不留）；没有可压缩的范围时结束（自动触发时挂起的组装照常执行，有修剪时以 `REJECTED(CONTEXT_COMPACTED)` 返回；用户触发时发出 `CompactionFailed(NOTHING_TO_COMPACT)`，有修剪时发出只含修剪的 `ContextCompacted`） |
| 摘要 | 请 Execution 组装并执行摘要请求（Execution 第 6a 节）：先用前缀式；`COMPACTION_SUMMARY_INVALID` 时追加更严格的指令重试一次；前缀式超出窗口或 `CONTEXT_OVERFLOW` 时改用纯文本式，依次以 `summaryFallbackTargets` 为目标重试；每次请求各自预留与结算 |
| 写回 | Outbox 发出 `ContextCompacted`，等待 `ackCompaction(stage: SUMMARY, RECORDED)`；收到后审计 `COMPACTION_ENDED`，向 UserInteraction 发出 `ContextCompacted`，挂起的组装以 `REJECTED(CONTEXT_COMPACTED)` 返回 |
| 失败 | 任何一步失败：结算预留，审计 `COMPACTION_FAILED`；已生效的修剪保留；自动触发时挂起的组装照常执行（有修剪时以 `REJECTED(CONTEXT_COMPACTED)` 返回，仍超出时 `LIMIT_EXCEEDED`），用户触发时发出 `CompactionFailed`，空闲触发时只写审计 |

- 压缩进行期间，该对象不会有新的模型调用：触发它的组装被挂起，Workflow 在收到这次组装的结果之前不会提交下一次 `model-call`。
- 同一对象同一时刻至多一次压缩；同一轮中至多因自动触发压缩一次，之后重新提交的组装照常执行（M2Design 第 9.6 节"不循环"）；
  溢出触发按 `overflowTargets` 依次缩小目标（第 n 次溢出之后以第 n 个为目标），三次之后不再压缩。
- 压缩不改变运行控制状态与 Turn；它占用的时间计入 AgentRun 的墙钟。
- **压缩进行中的其他操作**：`/compact` 进行中收到 `HUMAN_ANSWER` 时照常开启 Turn，main 的第一次 `context-assemble` 挂起到压缩结束；进行中收到 `compactContext`、`undoTurns`、Fork、切换或关闭 Session 时，先取消这次压缩（取消摘要尝试，按失败处理，不写回摘要），再处理该请求。
- **SubAgent**：对象为 `AGENT_RUN`，额度从它自己的账本支出；额度不足以写摘要时按统一收尾路径进入最后一轮，以 `finish_subagent` 结束（M2Design 第 7.3 节）。

## 7. 审计

条目公共字段与 M1 Core 第 7 节相同，增加 `sessionId`。M1 的条目类型全部保留（`RUN_TIMEOUT` 相关的除外），M2 新增：

| type | 时机 |
|---|---|
| `SESSION_OPENED`、`SESSION_CREATED`、`SESSION_CLOSED`、`SESSION_DELETED` | Session 生命周期 |
| `SESSION_COMMAND_FAILED` | Workflow 回复 `FAILED` |
| `TURN_OPENED`、`TURN_CLOSED` | Turn 的开启与结束，附用量 |
| `HUMAN_REQUESTED`、`HUMAN_ANSWERED` | 只记录 `humanRequestId`、`inputId` 与产物引用，不记录正文 |
| `INSTRUCTIONS_TRUSTED` | 追加信任记录 |
| `AUTHORIZATION_REQUESTED`、`AUTHORIZATION_DECIDED` | 询问与回答，附能力与资源键；`AGENTS.md` 的写入附内容的 SHA |
| `WORKSPACE_REVERTED`、`UNDO_CANCELLED` | 回退的结果，附 Turn、是否强制、外部修改的文件、兜底快照 |
| `COMPACTION_STARTED`、`COMPACTION_ENDED`、`COMPACTION_FAILED` | 压缩的开始、生效与失败，附触发、对象、修剪的条目数、范围、摘要请求的方式、用量与失败原因 |

## 8. 配置

| 配置 | 读取者 | 缺省 |
|---|---|---|
| `KernelConfig.repositoryRoot` | Core | 组合根写入 |
| `KernelConfig.provider`、`repositoryExclusions`、`convergenceMarginMs` | Core | 与 M1 相同 |
| `KernelConfig.preset` | Core | `standard`；`readonly` 由 CLI 参数设置（M2Design 第 5.2 节） |
| `KernelConfig.turnTimeoutSeconds`、`orchestrationTimeoutSeconds`、`maxPauseSeconds` | Core | 1800、3600（Orchestration 运行整体是一个 Turn）、1800（第 5e 节） |
| `KernelConfig.pauseDrainMs` | Execution | 5000：暂停时 READ 的排空时间（Execution 第 4e 节） |
| `KernelConfig.compaction` | Core | `triggerRatio` 0.9、`keepRatio` 0.15、`pruneMinBytes` 8192、`pruneHeadBytes` 4096、`pruneTailBytes` 1024、`summaryMaxTokens` 16384、`overflowTargets` [0.85, 0.7, 0.5]、`summaryFallbackTargets` [0.85, 0.7, 0.5, 0.35]、`summaryReasoningEffort` `none`（摘要请求不思考；摘要请求的思考强度，启动时按所用模型的 `effortMapping` 校验，不合法时拒绝启动） |

## 9. 不变量与测试

| 不变量（M2Design 第 12 节） | 测试 |
|---|---|
| 2：Lease 只在 Core 内存中；授权只由人类签发 | 架构测试：Lease 类型不导出；单元测试：信任记录不产生任何执行权限 |
| 11：授权与检查出错时一律拒绝；询问一直等到用户回答 | 单元测试：询问没有计时器，待答复期间 Unit 保持挂起；收敛时询问以 `CANCELLED` 结束；拒绝后同一 AgentRun 不再询问，下一个 AgentRun 可以询问 |
| 13：HUMAN 节点的答复不产生授权 | 单元测试：`answerHuman` 不改变任何授权记录 |
| 18：Turn 由 Kernel 依据开放输入开启与结束 | 见 [Interaction](Interaction.md) 第 10 节 |
| 判定顺序 | 属性测试：能力上限只能收窄；上限之外与写入范围之外从不询问；极危险级从不复用条目；判定出错时拒绝 |
| 20：只有用户信任过的确切内容的 `AGENTS.md` 标明为项目指令 | 单元测试：内容变化后 `trusted: false` 并重新询问；`readonly` 预设下不询问 |
| 28：修剪与摘要只在确认后生效，不动用 F | 状态机测试：没有 `ackCompaction` 时挂起的组装照常执行；额度不足时只修剪、不写摘要；压缩期间该对象没有模型调用；`/compact` 进行中收到 `undoTurns` 时先取消且不写回；SubAgent 额度不足时进入收尾 |
