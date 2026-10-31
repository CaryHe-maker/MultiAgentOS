# MultiAgentOS M2 Kernel.Core

> 状态：草稿（阶段 1）。

## 1. 定位

Core 负责 Session 与运行的管理、授权、Lease、控制裁决、Turn、结果检查与事件交付，是内外部 syscall 的处理者与 Kernel 对外事件的唯一出口。
组件间交互见 [Interaction](Interaction.md)，长期规划见 [Kernel 架构](../../Architecture/Module/Kernel.md) 第 3、5、6 节。

## 2. 相对 M1 的变化

| M1 | M2 | 依据 | 阶段 |
|---|---|---|---|
| 运行管理：创建与回收运行 actor | Session 管理：创建与回收 Session actor，持有系统级状态（Session 引用、信任记录） | M2Design 第 2.6 节 | 1 |
| 没有 Turn | 依据开放输入开启与结束 Turn，维护 `TurnRecord` | M2Design 第 2.3 节 | 1 |
| 人类参与只有授权询问 | 转发人类请求与答复（阶段 1 只有开放输入）；用户输入的正文交给 Execution 存为产物 | M2Design 第 4.1、4.2 节 | 1 |
| 授权只有 `repo.read` | 增加 `project.instructions`（`AGENTS.md` 的信任） | M2Design 第 9.5 节 | 1 |
| 同一时刻至多一个 ACTIVE 的 AgentRun | 阶段 1 仍至多一个（只有 main）；阶段 4 放开 | M2Plan 第 6.5 节 | 4 |
| Lease = Agent 定义的能力 ∩ 用户授权 ∩ 系统策略，绑定运行 | 能力上限与授权条目两步判定；Lease 是为一次执行签发的许可 | M2Design 第 5 节 | 2 |
| 每个运行至多一次 final-call | 每个 AgentRun 至多一次 | M2Design 第 7.3 节 | 1 |
| 运行超时由 Core 计时 | 删除；Turn 超时在阶段 5 加入 | M2Design 第 7.4 节 | 5 |
| 上下文规模只由 Executor 裁剪 | Core 在受理 `context-assemble` 时与进入 AWAITING_INPUT 时检查规模，决定并组织压缩（先修剪、再摘要，第 6a 节） | M2Design 第 9.6 节 | 8 |
| 用户输入只有开放输入与授权回答 | 运行中插话 `steerRun`：RUNNING 时受理，正文交 Execution 存储后以 `HumanAnswered(kind: steer)` 交给 Workflow | M2Design 第 4.5 节 | 5 |
| — | `updateActivity`：待办进度原样放进 ActivityEvent | M2Design 第 3.5 节 | 2 |

## 3. 职责（阶段 1）

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
| 待答复的人类请求 | 运行级 | `humanRequestId → { nodeId, kind }`；阶段 1 至多一个（开放输入） |
| 请求记录 | 运行级 | 与 M1 相同（`requestId →` 请求摘要与响应），增加 `unitRunId`、`turnId` |
| AgentRun 登记 | 运行级 | 与 M1 相同，增加 `nodeId`、`effort`、`turnId`、`finalCallUsed` |
| 授权记录与 Lease | 运行级 | 与 M1 相同；增加 `project.instructions` 的询问记录 |
| 运行级 Outbox、计时器 | 运行级 | 与 M1 相同；删除运行总时长计时 |

## 5. 授权（阶段 1）

### 5.1 `repo.read`

与 M1 Core 第 4 节相同：运行开启后第一次需要时询问一次，同意后本运行内的 AgentRun 都可使用；拒绝在本运行内保留。
询问超时只拒绝本次，不形成持久的拒绝（M2Design 第 5.3 节）——这是相对 M1 的变化。

### 5.2 `project.instructions`

`readProjectFile('AGENTS.md')` 的处理（M2Design 第 9.5 节）：

```text
本运行没有 repo.read 的授权 → 先按第 5.1 节询问；拒绝时返回 USER_DECLINED
Execution 读取文件（readProjectFile），不存在时返回 exists: false
存在 → 计算 SHA；信任记录中有 (repositoryRoot, path, sha) → 返回 trusted: true
       没有 → 预设为 readonly 时直接返回 trusted: false
             本运行内已对 (path, sha) 选择过不信任 → 直接返回 trusted: false
             否则发起 AuthorizationRequest(project.instructions)，挂起本请求
                 ALLOW  → 追加信任记录（source: USER_CONFIRMED），返回 trusted: true
                 DENY  → 在本运行的内存中记住 (path, sha)，返回 trusted: false
                 超时、取消 → 返回 trusted: false
```

`path` 为 `'AGENTS.md'`，阶段 2 起也可以是子目录的 `AGENTS.md`（M2Design 第 9.5 节）；规则相同，询问展示路径与全文。

- 信任记录是系统级状态，跨运行、跨 Session 有效；它不授予任何执行能力，不是授权条目，也不是 Lease。
- 用户批准的 `AGENTS.md` 写入（根目录或子目录）成功后，新内容的 SHA 自动记为信任（`source: APPROVED_WRITE`，阶段 2）。

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

## 6a. 上下文压缩（阶段 8）

Core 是压缩过程（M2Design 第 9.6 节）的组织者：

| 步骤 | Core 的动作 |
|---|---|
| 检查点 | 受理普通调用的 `context-assemble` 时，请 Execution 估算组装后的输入（实测加估算，Execution 第 6a 节）；超过 `compaction.triggerRatio × perCallInputLimit`，或该 AgentRun 上一次 `model-call` 以 `CONTEXT_OVERFLOW` 返回，即开始压缩，挂起这次组装；对象为 main、模板节点或 SubAgent |
| 用户触发 | 受理 `compactContext`：运行为 Turn-chat 且处于 AWAITING_INPUT，对象为 main 的投影 |
| 空闲触发 | Turn-chat 的运行进入 AWAITING_INPUT 时，以 main 最近一次 `model-call` 的实测输入加输出估算；超过 `compaction.idleTriggerRatio × perCallInputLimit` 即开始压缩；一次 AWAITING_INPUT 至多一次 |
| 额度 | 写摘要之前请 Monitor 预留（Monitor 第 3.5 节）；额度检查的结果先记下：不足时只修剪，修剪后仍超出时挂起的组装以 `BUDGET_WRAP_UP` 返回；用户触发时发出 `CompactionFailed(BUDGET_INSUFFICIENT)`；空闲触发时直接结束 |
| 材料 | 审计 `COMPACTION_STARTED`；Outbox 发出 `CompactionSourceQuery`，按 `compactionId` 等待 `reportCompactionSource` |
| 修剪 | 按 M2Design 第 9.6 节第 4.5 步划出保留区并选出候选，请 Execution 修剪（Execution 第 6a 节）；有结果时 Outbox 发出 `ToolResultsPruned`，等待 `ackCompaction(stage: PRUNE, RECORDED)`；生效后重新估算，已低于目标（自动、溢出）或 `idleTriggerRatio`（空闲）时结束，挂起的组装以 `REJECTED(CONTEXT_COMPACTED)` 返回 |
| 范围 | 按 M2Design 第 9.6 节第 5 步选定；没有可压缩的范围时结束（自动触发时挂起的组装照常执行，有修剪时以 `REJECTED(CONTEXT_COMPACTED)` 返回；用户触发时发出 `CompactionFailed(NOTHING_TO_COMPACT)`，有修剪时发出只含修剪的 `ContextCompacted`） |
| 摘要 | 请 Execution 组装并执行摘要请求（Execution 第 6a 节）：先用前缀式；`COMPACTION_SUMMARY_INVALID` 时追加更严格的指令重试一次；前缀式超出窗口或 `CONTEXT_OVERFLOW` 时改用纯文本式，依次以 `summaryFallbackTargets` 为目标重试；每次请求各自预留与结算 |
| 写回 | Outbox 发出 `ContextCompacted`，等待 `ackCompaction(stage: SUMMARY, RECORDED)`；收到后审计 `COMPACTION_ENDED`，向 UserInteraction 发出 `ContextCompacted`（空闲触发同样发出），挂起的组装以 `REJECTED(CONTEXT_COMPACTED)` 返回 |
| 失败 | 任何一步失败：结算预留，审计 `COMPACTION_FAILED`；已生效的修剪保留；自动触发时挂起的组装照常执行（有修剪时以 `REJECTED(CONTEXT_COMPACTED)` 返回，仍超出时 `LIMIT_EXCEEDED`），用户触发时发出 `CompactionFailed`，空闲触发时只写审计 |

- 压缩进行期间，该对象不会有新的模型调用：触发它的组装被挂起，Workflow 在收到这次组装的结果之前不会提交下一次 `model-call`。
- 同一对象同一时刻至多一次压缩；同一轮中至多因自动触发压缩一次，之后重新提交的组装照常执行（M2Design 第 9.6 节"不循环"）；
  溢出触发按 `overflowTargets` 依次缩小目标，第三次后不再压缩。
- 压缩不改变运行控制状态与 Turn；它占用的时间计入 AgentRun 的墙钟。
- **空闲压缩与其他操作**：进行中收到 `HUMAN_ANSWER` 时照常开启 Turn，main 的第一次 `context-assemble` 挂起到压缩结束；进行中收到 `compactContext`、`undoTurns`、Fork、切换或关闭 Session 时，先取消空闲压缩（取消摘要尝试，按失败处理，不写回摘要），再处理该请求。
- **SubAgent**：对象为 `AGENT_RUN`，额度从它自己的账本支出；额度不足以写摘要时按统一收尾路径进入最后一轮，以 `finish_subagent` 结束（M2Design 第 7.3 节）。

## 7. 审计

条目公共字段与 M1 Core 第 7 节相同，增加 `sessionId`。M1 的条目类型全部保留（`RUN_TIMEOUT` 相关的除外），M2 新增：

| type | 时机 | 阶段 |
|---|---|---|
| `SESSION_OPENED`、`SESSION_CREATED`、`SESSION_CLOSED`、`SESSION_DELETED` | Session 生命周期 | 1 |
| `SESSION_COMMAND_FAILED` | Workflow 回复 `FAILED` | 1 |
| `TURN_OPENED`、`TURN_CLOSED` | Turn 的开启与结束，附用量 | 1 |
| `HUMAN_REQUESTED`、`HUMAN_ANSWERED` | 只记录 `humanRequestId`、`inputId` 与产物引用，不记录正文 | 1 |
| `INSTRUCTIONS_TRUSTED` | 追加信任记录 | 1 |
| `COMPACTION_STARTED`、`COMPACTION_ENDED`、`COMPACTION_FAILED` | 压缩的开始、生效与失败，附触发、对象、修剪的条目数、范围、摘要请求的方式、用量与失败原因 | 8 |

## 8. 配置

| 配置 | 读取者 | 缺省 |
|---|---|---|
| `KernelConfig.repositoryRoot` | Core | 组合根写入 |
| `KernelConfig.authorizationTimeoutMs` | Core | 300000 |
| `KernelConfig.provider`、`repositoryExclusions`、`convergenceMarginMs` | Core | 与 M1 相同 |
| `KernelConfig.preset` | Core | `standard`；`readonly` 由 CLI 参数设置（M2Design 第 5.2 节） |
| `KernelConfig.compaction` | Core | `triggerRatio` 0.85、`idleTriggerRatio` 0.7、`keepTokens` 20000、`pruneMinBytes` 8192、`pruneHeadBytes` 4096、`pruneTailBytes` 1024、`summaryMaxTokens` 8192、`overflowTargets` [0.85, 0.7, 0.5]、`summaryFallbackTargets` [0.85, 0.7, 0.5, 0.35]、`summaryReasoningEffort` `none`（摘要请求的思考强度，启动时按所用模型的 `effortMapping` 校验，不合法时拒绝启动）（阶段 8） |

## 9. 不变量与测试

| 不变量（M2Design 第 12 节） | 测试 |
|---|---|
| 2（阶段 1 部分）：Lease 只在 Core 内存中；授权只由人类签发 | 架构测试：Lease 类型不导出；单元测试：信任记录不产生任何执行权限 |
| 11：授权与检查出错时一律拒绝；超时不视为同意 | 单元测试：询问超时得到拒绝，且不在本运行内保留 |
| 13：HUMAN 节点的答复不产生授权 | 单元测试：`answerHuman` 不改变任何授权记录 |
| 18：Turn 由 Kernel 依据开放输入开启与结束 | 见 [Interaction](Interaction.md) 第 10 节 |
| 20：只有用户信任过的确切内容的 `AGENTS.md` 进入 system 段 | 单元测试：内容变化后 `trusted: false` 并重新询问；`readonly` 预设下不询问 |
| 28：修剪与摘要只在确认后生效，不动用 F（阶段 8） | 状态机测试：没有 `ackCompaction` 时挂起的组装照常执行；额度不足时只修剪、不写摘要；压缩期间该对象没有模型调用；空闲压缩进行中收到 `undoTurns` 时先取消且不写回；SubAgent 额度不足时进入收尾（阶段 4 完成后） |

## 10. 阶段

| 阶段 | 本文增加的内容 |
|---|---|
| 1 | 第 3–9 节 |
| 2 | 能力上限与授权条目、判定顺序、询问合并、`workspace.write`、任一目录中 `AGENTS.md` 的极危险写入、子目录 `AGENTS.md` 的信任询问、回退的发起与确认 |
| 3 | 命令的级别、资源键与询问选项、SandboxProfile、`approvalDigest`、`STOP_UNCONFIRMED` 停机 |
| 4 | 多个 ACTIVE 的 AgentRun、`agent.spawn`、写入占用、委派保留 |
| 2 | `updateActivity` 的转发 |
| 5 | PAUSING、PAUSED、INTERRUPTING，计时冻结，Turn 超时，人类请求的取消，运行中插话 `steerRun` |
| 6 | `web.search`、`web.fetch` |
| 8 | 第 6a 节：压缩过程（检查点、空闲触发、修剪、摘要请求的回退）；压缩的审计与配置 |
