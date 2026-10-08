# MultiAgentOS M1 Workflow

## 1. 目的与范围

本文规定 M1 Workflow 的业务机制：处理模型、模型返回的解释、Validation、失败处理、Round 与 final-call、
交接，以及 FINISH 之后的结束路径。Workflow 可以发起的 syscall 与 Kernel 返回的信息见 [Kernel（外部视角）](Kernel.md)，
字段见 [M1Interface](../M1Interface.md)，长期规划见 [Workflow 架构](../../Architecture/Module/Workflow.md)。

## 2. 职责

- 经 `WorkflowInboxPort` 逐条接收 RunStart、UnitReport 与 RunClosed；经 `WorkflowGatewayPort` 发起 4 种 syscall。
- 收到 RunStart 后固定 Agent 定义（经 `CatalogPort.pinAgent`），持有 AgentRun 实例。
- 读取 Agent 定义的 `limits`、`startUnitRefs`、`actions` 与各 Unit 的 `failurePolicy`，维护并判断 Round。
- 解释模型返回、执行 Validation、按 `failurePolicy` 处理失败、决定 final-call、处理交接。
- 核验来源，生成 AnalysisReport 或降级报告，经 `report-publish` 发布。
- 写入运行记录的业务部分（第 13 节），标记业务终态。
- 不持有任何 token 数值，只经 UnitReport 的 `budgetState` 得知额度状态。

## 3. 术语

| 术语 | 定义 |
|---|---|
| Round | 以一次 model-call 为中心的一轮：context-assemble → model-call → 该次返回要求的全部工具 Unit 处理完成。AgentRun 的第一轮之前先执行该 Agent 的启动 Unit（`startUnitRefs`） |
| final-call | `final = true` 的 model-call：只提供并强制调用 finish 控制工具，用于收尾 |
| wrapUpReason | 决定下一次 model-call 为 final-call 的原因（`WrapUpReason`） |
| AnalysisAction | Workflow 对一次模型返回的解释，见第 5 节；Workflow 内部类型，不跨模块 |

## 4. 处理模型

- Workflow 是一个单消费者：按 Inbox 顺序逐条处理事件，一条处理完才处理下一条。处理中可以等待自己发起的 syscall 的返回值；
  Kernel 投递事件只入队，不等待 Workflow 处理，因此不会形成等待环。
- 处理以 `(状态, 输入) → (新状态, 动作)` 的 reducer 实现，输入包括 Inbox 事件与 syscall 的返回值。
- 状态按运行保存：`goal`、两个固定定义集合、当前 AgentRun（`agentRunId`、`roundsUsed`、`regenerationCount`、`noProgressCount`、
  `wrapUpReason`、`steps`、`orientPackRef`、待收的 `requestId` 集合、最近一次 context-assemble 的 `elidedRequestIds`）、最近的 `budgetState`、
  已读取的 `FileReadOutput` 列表、业务终态。
- `agentRunId` 与 `requestId` 由 Workflow 生成（`agr_`、`req_` 加 ULID）；重发同一请求时沿用原 `requestId`。
- 一轮内的工具 Unit 一次全部提交，按 `requestId` 收齐全部 UnitReport 后才进入下一步；UnitReport 可能先于对应的 SyscallAck 到达。

## 5. 解释模型返回

model-call 的 UnitReport 为 OK 时，Workflow 把 `ModelCallOutput` 解释为 AnalysisAction：

```ts
type AnalysisAction =
  | { kind: 'TOOL_CALLS'; calls: ModelToolCall[] }
  | { kind: 'HANDOFF'; toolCallId: string; brief: HandoffBrief }
  | { kind: 'FINISH'; toolCallId: string; draft: AnalysisReportDraft }
  | { kind: 'INVALID'; reason: 'NO_ACTION' | 'OUTPUT_TRUNCATED' | 'CONTROL_MIXED'
                             | 'CONTROL_NOT_ALLOWED' | 'CONTROL_ARGUMENTS_INVALID' };
```

```text
toolCalls 为空 → INVALID（finishReason 为 LENGTH 时 OUTPUT_TRUNCATED，否则 NO_ACTION）
存在控制工具（purpose = CONTROL）的调用：
  调用总数大于 1 → INVALID(CONTROL_MIXED)
  finish 工具 → 参数按 workflow.AnalysisReportDraft 校验 → FINISH，或 INVALID(CONTROL_ARGUMENTS_INVALID)
  handoff 工具 → 只在 Agent 定义了 actions.handoff 且不是 final-call 时允许，否则 INVALID(CONTROL_NOT_ALLOWED)
                 参数按 workflow.HandoffBrief 校验 → HANDOFF，或 INVALID(CONTROL_ARGUMENTS_INVALID)
否则 → TOOL_CALLS（逐个调用的检查见第 6 节）
```

| AnalysisAction | 处理 |
|---|---|
| FINISH | 进入第 10 节 |
| HANDOFF | 进入第 9.2 节 |
| TOOL_CALLS | 记录 `MODEL_TURN`，执行第 6 节，提交通过的调用，收齐 UnitReport 后进入下一轮 |
| INVALID | 记录 `MODEL_TURN`；对每个 `toolCallId` 记录一条 `FEEDBACK(INVALID_ACTION)`（没有调用时记录一条不带 `toolCallId` 的）；`regenerationCount` 加 1；进入下一轮。若本次是 final-call，改为生成降级报告（第 10.2 节） |

非 INVALID 的动作把 `regenerationCount` 清零。`regenerationCount` 达到 `regenerationLimit` 时设置 `wrapUpReason = REGENERATION_LIMIT`。

## 6. Validation

对 TOOL_CALLS 中的每个调用按顺序检查，不通过的调用记录一条带 `toolCallId` 的 FEEDBACK，不提交给 Kernel：

| 步骤 | 检查 | FeedbackCode |
|---|---|---|
| step1 | 序号不超过 `maxToolCallsPerRound`（只计 UNIT 工具调用） | `TOO_MANY_TOOL_CALLS` |
| step1 | 工具是该 Agent 固定集合中 `purpose = UNIT` 的工具 | `UNKNOWN_TOOL` |
| step1 | `arguments` 不为 null，且符合该工具的 `parametersContract` | `INVALID_ARGUMENTS` |
| step2 | 最近的 `budgetState` 不为 EXHAUSTED | `NOT_EXECUTED` |
| step2 | 本 AgentRun 内没有成功执行过相同 Unit 加相同规范化参数的调用；先前结果的 `requestId` 出现在最近一次 context-assemble 的 `elidedRequestIds` 中时（正文已被裁剪），不算重复 | `DUPLICATE_CALL` |

通过的调用以 `unitRef = 该工具所属 Unit`、`input = arguments` 提交 `submitUnit`。
Validation 是 Workflow 的业务检查，不替代 Kernel 的准入、定义核验与权限检查。step1 与 Kernel 使用同一份 Schema，
因此 Kernel 的 `INVALID_INPUT` 只会因 Workflow 自身缺陷出现。

无进展检测：一轮 TOOL_CALLS 结束时，没有任何一个调用得到新的 OK 结果（INVALID 轮同样计入），`noProgressCount` 加 1，否则清零；
`noProgressCount` 达到 `noProgressRounds` 时设置 `wrapUpReason = NO_PROGRESS`。

## 7. 失败处理（failurePolicy）

### 7.1 SyscallRejected

| 原因码 | 处理 |
|---|---|
| `RUN_BLOCKED` | 停止推进，等待 RunClosed |
| 其他 | `closeRun(FAILED)`，`failure = { code: 该原因码, category, source: 'WORKFLOW', unitRequestId? }` |

`closeRun` 本身被拒（非 `RUN_BLOCKED`）时，Workflow 不再发起请求，等待 RunClosed；运行总时长上限保证 RunClosed 必然到来。

### 7.2 UnitReport 的 REJECTED 与 FAILED

查该 Unit 定义的 `failurePolicy`，未列出的原因码按 `FATAL`。唯一例外：失败的是 final-call 的 model-call 时不查 `failurePolicy`，
无论原因码一律按 `DEGRADED_REPORT` 处理（第 8 节）：

| 处理 | 含义 |
|---|---|
| `RETURN_TO_MODEL` | 工具 Unit：记录 `TOOL_RESULT`（含原因码）交给模型；model-call：记录 `FEEDBACK(MODEL_CALL_FAILED)`，进入下一轮 |
| `FINAL_CALL` | 设置 `wrapUpReason`（`USER_DECLINED` → `USER_DECLINED`，`BUDGET_WRAP_UP` → `BUDGET_WRAP_UP`），下一次 model-call 为 final-call；工具 Unit 同时记录 `TOOL_RESULT` |
| `DEGRADED_REPORT` | 不再发起 model-call 与新的工具 Unit，收齐本轮结果后生成降级报告（`wrapUp.reason` 见第 10.2 节） |
| `FATAL` | `closeRun(FAILED)`，`failure = { code: 该原因码, category, source: 'WORKFLOW', unitRequestId }` |

一轮内多个 UnitReport 的处理取最严重者：`FATAL` > `DEGRADED_REPORT` > `FINAL_CALL` > `RETURN_TO_MODEL`。
`category` 取 contracts 的 `REASON_CODE_CATEGORY`（M1Interface 3.4）。

## 8. Round 与 final-call

- 上限写在 Agent 定义中：`limits.maxRounds`、`limits.maxToolCallsPerRound`，受定义 digest 覆盖。
- `roundsUsed` 从 0 开始；model-call 的 UnitReport 为 OK 或 FAILED 时加 1。被 `BUDGET_WRAP_UP`、`BUDGET_EXHAUSTED`、
  `FINAL_CALL_USED` 拒绝的 model-call 没有发出，不计 Round。交接后 CodeViewer 从 0 计数。
- 技术重试由 Execution 执行，对 Workflow 不可见，不计 Round。
- 下一次 model-call 为 final-call 的条件：`wrapUpReason` 已设置，或 `maxRounds − roundsUsed ≤ 1`（此时 `wrapUpReason = ROUND_LIMIT`）。
  多个原因同时出现时保留最先设置的一个。
- 任一 UnitReport 的 `budgetState` 为 WRAP_UP 时设置 `wrapUpReason = BUDGET_WRAP_UP`，本轮已提交的工具 Unit 照常执行完。
- 任一 UnitReport 的 `budgetState` 为 EXHAUSTED 时不再发起任何 model-call，也不再提交新的工具 Unit：
  若携带 EXHAUSTED 的是返回 FINISH 的 model-call，照常进入第 10.1 节；否则生成降级报告（`wrapUp.reason = BUDGET_EXHAUSTED`）。

final-call 的规则：

- context-assemble 与 model-call 的 `final` 都为 true；Kernel 按 `finalInputBudget` 组装，只提供 finish 控制工具；计入 1 个 Round。
- 返回合法 FINISH：进入第 10.1 节；其他任何结果（INVALID、失败）：不再重新生成，生成降级报告。
- 每个 WorkflowRun 至多一次 final-call；Kernel 对第二次返回 `FINAL_CALL_USED`。Planner 在 final-call 中不能交接，
  因此 Planner 的 final-call 之后不会再有 CodeViewer。
- 运行超时与 EXHAUSTED 不发起 final-call。

## 9. AgentRun、启动 Unit 与交接

### 9.1 运行开始

```text
RunStart(goal)
  → pinAgent(entryAgentRef)；集合中有 handoffTargetRef 时 pinAgent(目标的 id、version)
       固定失败，或目标 digest 与 handoffTargetRef 不同 → closeRun(FAILED, PIN_FAILED)
  → registerAgentRun(Planner)
  → 执行 Planner 的启动 Unit（Planner 为空）→ 第一轮
```

启动 Unit 按 `startUnitRefs` 的顺序逐个提交，前一个的 UnitReport 收到后才提交下一个。M1 的启动 Unit 只有 `repository-orient`，
输入为 `{ objective: goal }`；结果为 OK 时保存 `orientPackRef`，失败时按第 7.2 节处理（`USER_DECLINED` 使第一轮即为 final-call）。

每一轮：

```text
submitUnit(context-assemble, { objective: goal, final, handoff?, orientPackRef?, steps, status })
  → submitUnit(model-call, { contextPackRef, final }) → 第 5 节
```

`handoff` 只在 CodeViewer 的 AgentRun 中填写；`status` 为 `{ roundsUsed, maxRounds, final, budgetState, wrapUpReason? }`。

### 9.2 交接

```text
HANDOFF(brief)
  → endAgentRun(Planner)
  → registerAgentRun(CodeViewer，新的 agentRunId，agentRef = 已固定的目标)
  → 执行 CodeViewer 的启动 Unit（repository-orient）→ 第一轮（context-assemble 携带 brief）
```

- 交接内容由 `handoff-to-code-viewer` 工具的参数 Schema（`workflow.HandoffBrief`）定义，Workflow 只校验与传递。
- 交接是单向的：Planner 的 AgentRun 结束后不再恢复。
- 携带 HANDOFF 的 model-call 同时使 `budgetState` 变为 WRAP_UP 时，照常交接，`wrapUpReason = BUDGET_WRAP_UP` 带入 CodeViewer：
  CodeViewer 执行启动 Unit 后直接进入 final-call。其他 `wrapUpReason` 不跨 AgentRun 继承。

## 10. FINISH 与报告

### 10.1 正常报告

```text
1. 核验来源：对 draft 的每条结论，
     sources 为空                       → 未确认项（NO_SOURCE）
     每个来源都被本运行中某次成功的 file-read 覆盖（路径相同，且行范围包含在读取范围内）
                                        → 已核验结论，来源记为 VerifiedSource（readRequestId、readContentSha256）
     存在未被覆盖的来源                 → 未确认项（SOURCE_NOT_READ）
   draft.unconfirmed 的每一项           → 未确认项（MODEL_UNCONFIRMED）
2. 组装 AnalysisReport：summary、conclusions、unconfirmed、readSources（全部成功读取的范围）、
   wrapUp（设置了 wrapUpReason 时）、degraded = false、agentRounds、snapshotId（orient 成功时）
3. 写入运行记录的业务部分（第 13 节）
4. submitUnit(report-publish, { report })：报告发布必须在当前 AgentRun 仍为 ACTIVE 时进行
     OK → 得到 reportRef；失败 → 按 failurePolicy（FATAL）closeRun(FAILED)
5. endAgentRun(当前 AgentRun)
6. closeRun({ outcome: COMPLETED, reportRef })
7. 等待 RunClosed，按第 11 节记录业务终态
```

### 10.2 降级报告

没有合法 FINISH 时（EXHAUSTED、final-call 不合法或失败），以已有材料生成降级报告：`summary` 为按 `wrapUp.reason` 给出的固定说明，
`conclusions` 与 `unconfirmed` 为空，`readSources` 为全部成功读取的范围，`degraded = true`，`wrapUp` 必填。之后从第 10.1 节第 3 步继续。

| 触发 | `wrapUp.reason` |
|---|---|
| 某个 UnitReport 的 `budgetState` 为 EXHAUSTED，或 model-call 被 `BUDGET_EXHAUSTED` 拒绝 | `BUDGET_EXHAUSTED` |
| final-call 返回不合法或失败 | 触发该 final-call 的 `wrapUpReason` |

Core 不检查报告内容，只核对 `reportRef` 属于本运行；报告是否合格由 Workflow 负责。

## 11. 结束保证

Workflow 不得停在既不推进、也不等待 RunClosed 的状态。任何一次处理只能落入以下三种情况之一：

| 情况 | 例子 | 动作 |
|---|---|---|
| 继续推进 | 收齐 UnitReport 后进入下一轮 | 提交后续 syscall |
| 等待结束 | SyscallRejected(`RUN_BLOCKED`)；已调用 `closeRun`；`closeRun` 本身被拒 | 等待 RunClosed：收敛必然以 RunClosed 结束，运行总时长上限保证收敛必然开始 |
| 无法继续 | 第 7 节的 FATAL、其他 SyscallRejected、定义固定失败 | 调用 `closeRun(FAILED)` |

收到 RunClosed 后停止推进，按下表记录业务终态，并把 `unknownEffects` 写入运行记录（存在未知效果时不视为干净完成）：

| closeReason | 业务终态 |
|---|---|
| COMPLETED | COMPLETED |
| FAILED | FAILED |
| RUN_TIMEOUT | STOPPED(RUN_TIMEOUT) |
| CANCELLED | CANCELLED |
| VIOLATION | STOPPED(VIOLATION) |

`closeRun` 以 `requestId` 幂等；运行已在收敛或已结束时 Kernel 只返回 SyscallAck，因此不会与超时、取消冲突，Workflow 仍只收到一个 RunClosed。

## 12. 配置（`WorkflowConfig`）

| 配置 | 位置 | 建议初值 |
|---|---|---|
| `entryAgentRef` | Workflow 配置 | `{ id: planner, version: v0.1.0 }` |
| `regenerationLimit` | Workflow 配置 | 3 |
| `noProgressRounds` | Workflow 配置 | 2 |
| `limits.maxRounds` | Agent 定义 | CodeViewer 20；Planner 3（需评测校准） |
| `limits.maxToolCallsPerRound` | Agent 定义 | CodeViewer 8；Planner 0 |

Workflow 不读取任何 token 数值配置；上下文预算由 Kernel 按 `final` 选择（[Monitor](../Kernel/Monitor.md) 第 4 节）。

## 13. 运行记录的业务部分

Workflow 经 `PersistencePort.repository('workflow', workflowRunId)` 保存一条 `WorkflowRunRecord`（`id = workflowRunId`），
在第 10.1 节第 3 步与收到 RunClosed 后各写一次：

| 字段 | 内容 |
|---|---|
| `goal` | 用户目标 |
| `businessState` | RUNNING、COMPLETED、FAILED、CANCELLED、STOPPED(RUN_TIMEOUT)、STOPPED(VIOLATION) |
| `agentRuns[]` | `agentRunId`、`agentRef`、`roundsUsed`、`maxRounds`、`wrapUpReason`、结束方式（HANDOFF、FINISH、DEGRADED、FAILED、CLOSED） |
| `stepCount` | 全部 StepRecord 的数量 |
| `reportRef`、`failure`、`closeReason`、`unknownEffects` | 来自 Workflow 自身或 RunClosed |
| `updatedAt` | 写入时间 |

`WorkflowRunRecord` 是 Workflow 的内部记录，不跨模块传递。
