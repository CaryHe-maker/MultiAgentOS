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
存在 → 计算 SHA；信任记录中有 (repositoryRoot, 'AGENTS.md', sha) → 返回 trusted: true
       没有 → 预设为 readonly 时直接返回 trusted: false
             否则发起 AuthorizationRequest(project.instructions)，挂起本请求
                 ALLOW  → 追加信任记录（source: USER_CONFIRMED），返回 trusted: true
                 DENY、超时、取消 → 返回 trusted: false
```

- 信任记录是系统级状态，跨运行、跨 Session 有效；它不授予任何执行能力，不是授权条目，也不是 Lease。
- 用户批准的 `AGENTS.md` 写入成功后，新内容的 SHA 自动记为信任（`source: APPROVED_WRITE`，阶段 2）。

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

## 7. 审计

条目公共字段与 M1 Core 第 7 节相同，增加 `sessionId`。M1 的条目类型全部保留（`RUN_TIMEOUT` 相关的除外），M2 新增：

| type | 时机 | 阶段 |
|---|---|---|
| `SESSION_OPENED`、`SESSION_CREATED`、`SESSION_CLOSED`、`SESSION_DELETED` | Session 生命周期 | 1 |
| `SESSION_COMMAND_FAILED` | Workflow 回复 `FAILED` | 1 |
| `TURN_OPENED`、`TURN_CLOSED` | Turn 的开启与结束，附用量 | 1 |
| `HUMAN_REQUESTED`、`HUMAN_ANSWERED` | 只记录 `humanRequestId`、`inputId` 与产物引用，不记录正文 | 1 |
| `INSTRUCTIONS_TRUSTED` | 追加信任记录 | 1 |

## 8. 配置

| 配置 | 读取者 | 缺省 |
|---|---|---|
| `KernelConfig.repositoryRoot` | Core | 组合根写入 |
| `KernelConfig.authorizationTimeoutMs` | Core | 300000 |
| `KernelConfig.provider`、`repositoryExclusions`、`convergenceMarginMs` | Core | 与 M1 相同 |
| `KernelConfig.preset` | Core | `standard`；`readonly` 由 CLI 参数设置（M2Design 第 5.2 节） |

## 9. 不变量与测试

| 不变量（M2Design 第 12 节） | 测试 |
|---|---|
| 2（阶段 1 部分）：Lease 只在 Core 内存中；授权只由人类签发 | 架构测试：Lease 类型不导出；单元测试：信任记录不产生任何执行权限 |
| 11：授权与检查出错时一律拒绝；超时不视为同意 | 单元测试：询问超时得到拒绝，且不在本运行内保留 |
| 13：HUMAN 节点的答复不产生授权 | 单元测试：`answerHuman` 不改变任何授权记录 |
| 18：Turn 由 Kernel 依据开放输入开启与结束 | 见 [Interaction](Interaction.md) 第 10 节 |
| 20：只有用户信任过的确切内容的 `AGENTS.md` 进入 system 段 | 单元测试：内容变化后 `trusted: false` 并重新询问；`readonly` 预设下不询问 |

## 10. 阶段

| 阶段 | 本文增加的内容 |
|---|---|
| 1 | 第 3–9 节 |
| 2 | 能力上限与授权条目、判定顺序、询问合并、`workspace.write`、`AGENTS.md` 的极危险写入、回退的发起与确认 |
| 3 | 命令的级别、资源键与询问选项、SandboxProfile、`approvalDigest`、`STOP_UNCONFIRMED` 停机 |
| 4 | 多个 ACTIVE 的 AgentRun、`agent.spawn`、写入占用、委派保留 |
| 5 | PAUSING、PAUSED、INTERRUPTING，计时冻结，Turn 超时，人类请求的取消 |
| 6 | `web.search`、`web.fetch` |
