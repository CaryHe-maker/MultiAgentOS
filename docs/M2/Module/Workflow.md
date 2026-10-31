# MultiAgentOS M2 Workflow

> 状态：草稿（阶段 1）。

## 1. 定位

Workflow 是业务推进与验收的权威：维护 TaskGraph、会话日志与 Session 列表，持有 AgentRun 实例，决定下一步提交什么、模型看到什么。
它经 `WorkflowGatewayPort` 发起 syscall，经 Inbox 接收事件；不直接调用 ExecutorSet，不管理 Lease。
设计以 [M2Design](../M2Design.md) 第 3、4、9、10 节为准；字段见 [Interface/WorkflowKernel](../Interface/WorkflowKernel.md)；
长期规划见 [Workflow 架构](../../Architecture/Module/Workflow.md)。

## 2. 相对 M1 的变化

| M1 | M2 | 依据 | 阶段 |
|---|---|---|---|
| 一条运行记录（`WorkflowRunRecord`），按 id 整体覆盖 | 以 Session 为单位的只追加会话日志；状态是日志的投影 | M2Design 第 10 节 | 1 |
| 固定两步：planner 交接给 code-viewer | TaskGraph：AGENT 与 HUMAN 节点、GraphRevision、就绪即推进；M1 的两步成为内置模板 `analyze` | M2Design 第 3 节 | 1 |
| 一次输入、一次报告 | `chat` 生长规则：每条用户消息一个 Turn，main 以 `reply` 回复 | M2Design 第 2.2、3.8 节 | 1 |
| 上下文只在一次运行内，组装时每次按固定顺序裁剪 | 由会话日志投影，跨 Turn、跨 WorkflowRun；只在末尾追加，不按调用裁剪；工具结果使用产生时固定的预览 | M2Design 第 9 节 | 1 |
| — | `read_output` 的编号翻译：按 `toolCallId` 在发起者的范围内找到完整输出的引用（不含被回退的 Turn） | M2Design 第 8.2 节 | 2 |
| — | 控制工具 `update_todos`：校验、`TODOS_UPDATED`、经 `updateActivity` 交出进度 | M2Design 第 3.5 节 | 2（worker 为 4） |
| `steer` 只在暂停后附加 | 运行中的 `steer`（`HumanAnswered(kind: steer)`），目标已结束时改投 | M2Design 第 4.5 节 | 5 |
| — | 应 Kernel 的查询交出压缩材料（模型轮带实测用量与 `headDigest`），把修剪与压缩结果记入日志，投影以修剪后的结果与摘要取代原来的内容 | M2Design 第 9.6 节 | 8 |
| 只读根目录的 `AGENTS.md` | `read_file` 触及的子目录 `AGENTS.md` 按投影加载，追加在末尾 | M2Design 第 9.5 节 | 2 |
| 不处理 Session | 执行 Kernel 下达的 Session 命令：新建、打开（修复日志）、关闭、删除；维护 Session 列表 | M2Design 第 2.3、10.3 节 | 1 |
| 每个运行至多一次 final-call | 每个 AgentRun 至多一次（`analyze` 仍按运行，见 Monitor 第 3.4 节） | M2Design 第 7.3 节 | 1 |
| `budgetState` 一个值 | `BudgetView`：AgentRun、Turn、运行三级；额度触顶时进入最后一轮，必有报告 | M2Design 第 7.3 节 | 1 |
| 无业务熔断 | 重复意图、连续出错由 Workflow 判断 | M2Design 第 3.4 节 | 1 |
| 运行超时由 Kernel 收敛 | Turn 超时按中止处理，结束由 Workflow 以 `closeRun(TIMEOUT)` 报告 | M2Design 第 2.3 节 | 5 |

模型返回的解释、Validation、`failurePolicy`、Round 与 final-call、来源核验与报告（`analyze`）的规则沿用 M1，
见归档的 [M1 Workflow](../../History/M1/Module/Workflow.md) 第 5–10 节；本文只写变化。

## 3. 职责（阶段 1）

- 执行 Session 命令，维护会话日志与 Session 列表，回答 Session 列表查询（第 5 节）。
- 编译模板为 GraphRevision，按 `chat` 规则生长，计算就绪集合并启动节点（第 6 节）。
- 为每个 AGENT 节点登记 AgentRun、推进 Round、解释模型返回、执行 Validation 与失败处理（第 7 节）。
- 组装上下文：决定模型看到什么，交给 `context-assemble` 执行（第 8 节）。
- 结束节点、发布回复与结果、请求下一条开放输入、报告运行结束（第 9 节）。
- 只持有 `BudgetView` 与触顶项，不持有 token 数值。

## 4. 处理模型

- **单消费者**：按 Inbox 顺序逐条处理事件，一条处理完才处理下一条（M1 原样）。三个事件序列（运行级、Session 级、系统级）各自检查 `seq` 连续。
- **先写日志**：每条输入先追加日志，再更新内存中的投影，再发起 syscall（M2Design 第 10.3 节写入规则）。
  `submitUnit` 之前先追加 `UNIT_SUBMITTED`；`requestHuman` 之前先追加 `HUMAN_REQUESTED`。
- **状态是日志的投影**：节点状态、就绪集合、AgentRun 的计数器、模型上下文都由日志计算（不变量 7）；内存中的状态只是缓存，重开 Session 时由日志重建。
- **reducer**：与 M1 相同，以 `(投影, 输入) → (日志记录, syscall)` 实现；输入包括 Inbox 事件与 syscall 的返回值。
- **标识**：`agentRunId` 为 ULID，写入 `AGENT_RUN_REGISTERED`；节点、UnitRun、提交的 ID 由路径派生（Interface 第 3 节）。

## 5. Session

### 5.1 Session 命令

| 命令 | 处理 | 回复 |
|---|---|---|
| `CREATE` | 创建 Session 目录与日志；追加 `SESSION_STARTED`；在 Session 列表追加一行；取得 Session 锁 | `READY` |
| `OPEN` | 取得 Session 锁；`repairTail`，截断时追加 `LOG_TAIL_REPAIRED`；逐行读取并校验，`seq` 不连续时失败；比较 `definitionsDigest`；结算遗留记录（第 5.2 节）；重建投影；记下最后一个未答复的人类请求（如有），在随后的运行中重新发起 | `READY`，带 `lastTurnId` |
| `CLOSE` | 释放 Session 锁；清空内存投影 | `DONE` |
| `DELETE`（系统级事件 `SessionDelete`，Session 未打开） | 删除 Session 目录中 `workflow` 命名空间的文件；Session 列表追加 `status: DELETED` | `DONE` |
| `FORK` | 阶段 2 | — |

失败时回复 `FAILED` 与 `SessionCommandFailure`（Interface/WorkflowKernel 第 2.3 节）：锁被持有为 `SESSION_LOCKED`，`seq` 不连续或记录不合法为 `SESSION_LOG_CORRUPT`，
未知的 `formatVersion` 为 `SESSION_FORMAT_UNSUPPORTED`，写入失败为 `SESSION_STORAGE_FAILED`。

### 5.2 打开时结算遗留记录

M2Design 第 10.3 节第 4 步：对每个已提交、未完成的 Unit 追加 `UNIT_INTERRUPTED`（原因"上一个进程中断"；Workflow 不读取 Kernel 的审计，
"上一个进程故障停机"的区分在阶段 3 由 Kernel 随 `OPEN` 命令告知），
对没有 `TURN_ENDED` 的 Turn 追加 `TURN_ENDED(PROCESS_EXITED)`，对未结束的运行追加 `WORKFLOW_RUN_ENDED(PROCESS_EXITED)`，最后追加一条 `STALE_UNITS_SETTLED`。
遗留的 Unit 不重新提交；被打断的节点记为 INTERRUPTED。

### 5.3 Session 列表

每次 Session 的状态、标题、Turn 数、最后活动时间变化时，向 `session-index.jsonl` 追加一行（Interface/Persistence 第 3 节）：
新建时、收到第一条 `HumanAnswered` 时（`titleRef`）、收到 `TurnClosed` 时（Turn 数、最后活动时间）、删除时。
收到系统级事件 `SessionListQuery` 时，按 `repositoryRoot` 筛选、按最后活动时间倒序，以 `reportSessionList` 回复；不需要打开任何 Session。

## 6. TaskGraph

### 6.1 模板与生长

- **运行开始**：收到 `RunStart` 后，追加 `WORKFLOW_RUN_STARTED`；以 `readProjectFile('AGENTS.md')` 读取项目指令，追加 `PROJECT_FILE_LOADED`；
  编译模板（`CHAT` 为生长规则的初始图）为初始 GraphRevision，追加 `GRAPH_EXTENDED(source: TEMPLATE)`。
- **初始输入**：`RunStart.initialInput = true` 时，根节点 `HUMAN(prompt)` 等待随后的 `HumanAnswered(origin: initial)`；
  为 `false` 时（打开 Session、额度结束后继续），根节点按 `requested` 处理：重新发起上一个进程中未答复的人类请求，没有时请求新的开放输入。
- **`chat`**：初始图为 `HUMAN(prompt) → main`。每当 main 节点结束（不论成败），追加 `GRAPH_EXTENDED(source: CHAT_GROWTH)`：
  新的 `HUMAN(prompt, requested)`（触发规则 `all_done`，依赖刚结束的 main）与依赖它的新 main 节点。
- **`analyze`**：模板 `plan → view`（Interface/Definitions 第 4 节）；根节点 `HUMAN(prompt, initial)` 由编译加入。
  `plan → view` 是条件边（`action = HANDOFF`，M2Design 第 3.8 节）：交接时 `view` 以交接内容为输入；`plan` 以 `finish` 结束时，`view` 记为 `SKIPPED(NOT_TAKEN)`，
  `plan` 的报告即运行结果。planner 节点的结构化结果为 `{ action: 'HANDOFF' | 'FINISH', ... }`。
- 阶段 1 的校验函数 `validateExtension` 只检查：节点名唯一、依赖存在、无环、只引用内置 Agent、条件边只出现在内置模板中；其余规则随阶段 4、7 加入。
- 条件边的求值（M2Design 第 3.3 节的 `edgeState`）在阶段 1 即实现，供 `analyze` 使用。

### 6.2 推进

就绪与跳过的计算使用提前任务 E-WF-1 的纯函数（M2Design 第 3.3 节）；处理每条事件的顺序固定为：追加日志 → 更新投影 → 需要时生长 →
记录跳过 → 启动就绪节点（AGENT 节点登记 AgentRun，HUMAN 节点发起人类请求）。

### 6.3 HUMAN 节点与 Turn（阶段 1 只有开放输入）

| 输入 | 处理 |
|---|---|
| 新建 Session、`startRun` 后的第一条 `HumanAnswered(origin: initial)` | 根节点 `HUMAN(prompt)` 的输入：追加 `HUMAN_ANSWERED`、`TURN_STARTED`；根节点结束为 SUCCEEDED |
| `HUMAN(prompt, requested)` 节点就绪 | 追加 `NODE_STARTED`、`HUMAN_REQUESTED`，调用 `requestHuman(prompt)` |
| `HumanAnswered(origin: requested)` | 追加 `HUMAN_ANSWERED`、`TURN_STARTED`；节点结束为 SUCCEEDED；带 `template` 时（`/run`，阶段 7）以该模板的实例作为本 Turn 的主体 |
| `TurnClosed` | 追加 `TURN_ENDED`；更新 Session 列表 |
| `HumanAnswered(kind: steer)`（阶段 5，运行中插话） | 创建附属于目标 AgentRun 的 `HUMAN(steer)` 节点，追加 `HUMAN_ANSWERED`；说明在目标下一次组装时出现在末尾。目标已结束时：SubAgent 改为附属于它的父 AgentRun 并注明原定目标；main 则保持原位，在下一个 Turn 的投影中出现 |

- Workflow 只在静止时请求开放输入：发出 `requestHuman(prompt)` 之前，本运行没有 ACTIVE 的 AgentRun，也没有待收的 UnitReport。
- `requestHuman` 被拒（`AGENT_RUN_ACTIVE`）说明 Workflow 自身有缺陷，按内部错误处理（第 10 节）。

## 7. AgentRun 内部的推进

沿用 M1 Workflow 第 5–8 节，变化如下：

1. **登记**：AGENT 节点就绪时 `registerAgentRun`（带 `nodeId`、`effort`、`display.label`）；`effort` 取 Agent 定义的 `defaultEffort`。
2. **启动 Unit**：main 的 `repository-orient` 只在每个 WorkflowRun 的第一个 Turn 提交；之后的 Turn 沿用该次概览的引用，并在上下文中标出它对应的快照（M2Design 第 3.9 节）。
3. **控制工具**：main 的结束工具为 `reply`（参数 `{ text }`）；`finish` 与 `handoff-to-code-viewer` 只在 `analyze` 中出现；`update_todos` 见第 9 条（阶段 2）。
4. **额度**（M2Design 第 7.3 节）：任一 UnitReport 的 `budget.agentRun` 或 `budget.turn` 为 WRAP_UP 时，设置 `wrapUpReason = BUDGET_WRAP_UP`，下一次模型调用就是 final-call；
   为 EXHAUSTED 时不再发起模型调用，按 M1 的规则结束该 AgentRun（main 为降级回复，见第 9.1 节）。
   `QUOTA_EXHAUSTED`（工具次数、墙钟）同样进入收尾，`wrapUpReason` 为对应的触顶项。
5. **业务熔断**（M2Design 第 3.4 节）：重复意图在第 3 次时于工具结果中附加警告、第 5 次时不再提交并进入收尾（`REPEATED_INTENT`）；
   连续 5 个工具 Unit 以 REJECTED 或 FAILED 结束时进入收尾（`CONSECUTIVE_ERRORS`）。命令的非零退出码不算出错。
6. **final-call**：每个 AgentRun 至多一次；收尾调用的模型参数（`tool_choice`、思考设置、失败后的重试）由 `context-assemble` 与 `model-call` 按 M2Design 第 9.4 节处理，Workflow 只设置 `final`。
7. M1 的 `DUPLICATE_CALL` 检查保留；它与重复意图不同：前者拒绝同一 AgentRun 内已成功执行过的相同调用，后者计数最近 20 个 UnitIntent。
   M1 中"先前结果已被裁剪时不算重复"的例外改为：先前结果已被压缩的摘要取代（阶段 8），或在本次收尾调用的保险中被去掉时，不算重复。
8. **`read_output` 的编号翻译**（阶段 2，M2Design 第 8.2 节）：提交前按参数中的 `toolCallId`，在发起调用的 AgentRun 的范围内查找那次工具调用的 `UNIT_COMPLETED`：
   - 范围按日志计算，不按当前投影：main 为本 Session 主线上 main 的全部工具调用（跨 WorkflowRun，包括已被压缩取代的、Fork 时继承的）；
     模板中的 AGENT 节点与 SubAgent 为该 AgentRun 自己步骤中的工具调用；
   - 被 `/undo` 回退的 Turn（`WORKSPACE_REVERTED` 中列出的）中的工具调用不在范围内，按"没有这个编号的调用"反馈（M2Design 第 8.2 节）；
   - 有多次调用的 `toolCallId` 相同时取最近的一次；
   - 找到且带 `fullRef` 时，把 `fullRef` 作为 `workflowFields` 填入 Unit 输入后提交；没有 `fullRef`、但 `TOOL_RESULTS_PRUNED` 修剪过它时（阶段 8），填入该记录中的可读回引用（原来的预览）；
     找不到，或那次结果既没有被截断也没有被修剪时，不提交，按 M1 的方式记录 `FEEDBACK(INVALID_ARGUMENTS)`，
     说明"没有这个编号的调用"或"该调用的输出没有被截断，预览就是全部内容"；不说明引用。
   - 结果按普通工具结果处理：预览进入投影，计入重复调用与重复意图的检查；`REJECTED(ARTIFACT_EXPIRED)` 与其他工具拒绝一样作为工具结果交给模型。
9. **`update_todos`**（阶段 2，worker 为阶段 4；M2Design 第 3.5 节）：
   - 校验参数（≤30 项、每项 ≤200 字符、`in_progress` 至多一项），不合法时记录 `FEEDBACK(INVALID_ARGUMENTS)`；
   - 合法时追加 `TODOS_UPDATED { agentRunId, source: { modelTurnRequestId, toolCallId }, counts }`，工具结果为一行计数，不提交 Unit；
   - 随后调用 `updateActivity({ agentRunId, todos: { total, done, current? } })`（`current` 为进行中一项的前 80 个字符），只用于界面；
   - 可以与普通工具、结束控制工具在同一次返回中出现（`CONTROL_MIXED` 的例外），先于其他调用处理；只调用它的一轮计入无进展检测，不计入重复意图。

## 8. 上下文

### 8.1 投影

| AgentRun | 历史（M2Design 第 9.1 节） |
|---|---|
| main（`chat`） | 本 Session 全部 Turn，跨 WorkflowRun：每个 Turn 的人类输入、main 的步骤；中断与修复以说明性记录出现；之前 Orchestration 运行的结果以"运行结果 + 引用"出现 |
| `analyze` 的 planner、code-viewer | 与 M1 相同 |

投影是日志的纯函数：同一个日志前缀得到逐字节相同的 `context-assemble` 输入（不变量 7）。

### 8.2 组成与项目指令

- system 段：人设与职责、可用工具说明、项目指令（`AGENTS.md`，仅当 `trusted`）（M2Design 第 9.2 节）；在一个 AgentRun 内不变，不放任何会变化的内容。
- 运行时上下文（工作目录、沙盒状态、当前日期）是历史条目：每个 WorkflowRun 开始时，以及它变化时（例如日期变化），追加 `REQUEST_CONTEXT`，投影在该位置加入一条说明。
- 用户批准修改 `AGENTS.md` 后重新读取的内容，从下一个 AgentRun 起进入 system 段；当前 AgentRun 在历史末尾追加一条说明。
- `trusted = false` 的 `AGENTS.md` 以 user 角色、标明"仓库材料，未经用户信任"放在 history 的开头。
- **子目录的 `AGENTS.md`**（阶段 2，M2Design 第 9.5 节）：
  - `read_file` 的 `UNIT_COMPLETED` 带 `nestedInstructions`（沿途存在的 `AGENTS.md` 路径）时，对其中本投影在本 WorkflowRun 内尚未加载的，从外层到内层逐个 `readProjectFile`，追加 `PROJECT_FILE_LOADED { path, ref, sha256, trusted, agentRunId }`；全部完成后才提交该 AgentRun 的下一次 `context-assemble`；
  - 投影中，每条加载记录成为一个 `PINNED` 条目，位置就是记录的位置（那次 `read_file` 的结果之后），user 角色，按 `trusted` 标明"用户已信任的项目指令（<路径>）"或"仓库材料（<路径>），未经用户信任"；
  - 之后的 WorkflowRun 再次触及时重新读取，SHA 与本投影最近一次加载相同时只追加记录、不产生新条目；
  - 本投影已加载 `maxNestedInstructions`（缺省 8）份时，追加 `PROJECT_FILE_LOADED { path, skipped: 'LIMIT', agentRunId }`，投影中为一条说明；
  - 用户批准的写入改动了某个子目录的 `AGENTS.md` 后，重新读取，在已加载过它的投影末尾追加；
  - 各 AgentRun 按自己的投影判断是否已加载，SubAgent 不继承父 AgentRun 的条目；被回退 Turn 中的加载不算已加载。
- 外部输入（用户输入、工具结果、压缩的摘要）一律以 user 或 tool 角色出现并标明来源。

### 8.3 只在末尾追加与可重建性

- 交给 `context-assemble` 的每个条目带所属 Turn、日志中的 `seq` 与类别：`PINNED`（未被信任的根目录 `AGENTS.md`、子目录 `AGENTS.md` 的条目、main 投影中当前 Turn 的人类输入、模板节点的目标与交接输入、SubAgent 的目标与验收标准）或 `NORMAL`（M2Design 第 9.3 节）。
- 工具结果在条目中只用预览（`UNIT_COMPLETED.outputRef`），永不使用 `fullRef`；`fullRef` 只出现在 `read_output` 的 Unit 输入中（第 7 节第 8 条）。
- 已投影出的条目不再改写：两次压缩之间，同一对象的投影只在末尾增长（不变量 27）。思考内容是否可回传，在追加 `MODEL_TURN` 时写入 `replayable`。
- 每次组装追加 `CONTEXT_ASSEMBLED`，记录 `projectionDigest` 与 ContextPack 的 `headDigest`；只有收尾调用的保险去掉了条目时才带 `elidedEntries`。
- 模型、思考设置、工具列表、运行时上下文变化时追加 `REQUEST_CONTEXT`。
- 普通调用以 `LIMIT_EXCEEDED` 被拒（阶段 8 之前上下文超出窗口）：该 AgentRun 进入最后一轮，`wrapUpReason = CONTEXT_LIMIT`；main 的回复中提示用户用 `/new` 开始新的对话。

### 8.4 压缩（阶段 8）

压缩由 Kernel 决定与执行（M2Design 第 9.6 节），Workflow 只按固定规则配合，不做判断：

| 输入 | Workflow 的处理 |
|---|---|
| `CompactionSourceQuery { compactionId, target }` | 按 `target` 计算当前投影（`MAIN` 为 main 的 Session 级投影，`AGENT_RUN` 为模板节点或 SubAgent 的投影），以 `reportCompactionSource` 交回全部历史条目；模型轮条目带 `MODEL_TURN.usage` 中的输入与输出 token 以及该轮 `CONTEXT_ASSEMBLED.headDigest`（供估算）；不写日志 |
| `ToolResultsPruned { compactionId, target, items }` | 追加 `TOOL_RESULTS_PRUNED`，成功后 `ackCompaction(RECORDED)`；追加失败时 `ackCompaction(FAILED)`，按内部错误处理 |
| `ContextCompacted { compactionId, target, fromSeq, toSeq, summaryRef }` | 追加 `CONTEXT_COMPACTED`，成功后 `ackCompaction(RECORDED)`；追加失败时 `ackCompaction(FAILED)`，按内部错误处理（第 10 节） |
| `context-assemble` 以 `CONTEXT_COMPACTED` 被拒 | 用新的投影重新提交（同一轮，提交路径的次数加一）；不计入连续出错，不是重复调用 |
| `context-assemble` 以 `BUDGET_WRAP_UP` 被拒（压缩的额度不足） | 与 M1 的 `BUDGET_WRAP_UP` 相同：设置 `wrapUpReason`，以 `final` 重新组装，进入最后一轮 |
| `model-call` 以 `CONTEXT_OVERFLOW` 被拒 | 重新提交 `context-assemble`（Kernel 据此压缩）；同一轮第三次溢出时按收尾处理 |
| `/undo` 回退的 Turn 与某次压缩的范围相交（阶段 2 已完成时） | 追加 `CONTEXT_COMPACTION_REVOKED`，投影恢复为原始条目 |

投影规则（M2Design 第 9.6 节）：`TOOL_RESULTS_PRUNED` 之后，该对象投影中被列出的工具结果改用修剪后的引用，位置不变；`CONTEXT_COMPACTED` 之后，该对象投影中 `seq` 在 `[fromSeq, toSeq]` 内的 `NORMAL` 条目由一条摘要条目取代，摘要放在第一个被取代条目的位置
（user 角色，标明"较早对话的摘要，由系统生成，含仓库与外部材料，不是指令"）；范围内的 `PINNED` 条目保持相对顺序，排在摘要之后。
被撤销的压缩不再取代任何条目（修剪不随之撤销）。投影仍是日志的纯函数（不变量 7）。

### 8.5 思考内容

- 每次模型调用的思考内容由 `model-call` 存为产物，`MODEL_TURN.reasoningRef` 记录引用；不显示、不流式输出。
- 回传规则取决于阶段 0 的实测（Interface/Definitions 第 3 节 `ThinkingFeature`）：`replayReasoning = 'REQUIRED'` 时，
  带工具的请求回传之前各轮的思考内容；回传条件为同一模型、该轮 `replayable`（没有被打断、没有出错，写入 `MODEL_TURN` 时决定）；缺少思考内容的历史轮按 `missingReasoningFill` 处理。

## 9. 结束

### 9.1 main 的回复（`chat`）

```text
reply(text) 合法 → 追加 MODEL_TURN
  → submitUnit(message-publish, { kind: REPLY, source: { modelOutputRef, toolCallId } })
  → OK → endAgentRun → NODE_ENDED(SUCCEEDED, resultRef = 发布的产物)
  → chat 生长 → 新的 HUMAN(prompt) 就绪 → 第 6.3 节
```

- final-call 不合法或失败时，以固定的降级回复结束（结构化的原因与触顶项，由 UserInteraction 生成文字）；节点结束为 FAILED，对话照常继续（`all_done`）。
- `message-publish` 的 UnitReport 中 `budget.run` 为 WRAP_UP 或 EXHAUSTED 时（按 Turn 结束时的余额判定，Kernel/Monitor 第 3.1 节），
  本 Turn 的回复发布后不再请求开放输入，而是 `closeRun(BUDGET)`（M2Design 第 7.3 节）；用户确认继续后，Kernel 在同一 Session 中开启新的运行。

### 9.2 `analyze` 的报告

与 M1 Workflow 第 10 节相同：来源核验、AnalysisReport 或降级报告、`report-publish`。结束时 `closeRun(COMPLETED, resultRef = reportRef)`；
因额度结束时为 `closeRun(BUDGET, resultRef = 降级报告)`。

### 9.3 结束保证

与 M1 Workflow 第 11 节相同：任何一次处理只能落入"继续推进""等待结束""无法继续"三种情况之一。收到 `RunClosed` 后追加 `WORKFLOW_RUN_ENDED`，
业务终态取 `closeReason`。

## 10. 内部错误

与 M1 Workflow 第 11.1 节相同：先 `closeRun(FAILED, WORKFLOW_INTERNAL)`；做不到时经 `reportSystemFault` 升级。
日志追加失败属于内部错误：不更新投影，不发起后续 syscall。

## 11. 配置（`WorkflowConfig`）

| 配置 | 缺省 | 说明 |
|---|---|---|
| `regenerationLimit`、`noProgressRounds` | 3、2 | 与 M1 相同 |
| `repeatedIntent` | `{ window: 20, warnAt: 3, stopAt: 5 }` | 第 7 节第 5 条 |
| `consecutiveErrorLimit` | 5 | 同上 |
| `entryAgentRef` | — | 删除；入口由模板决定 |

## 12. 不变量与测试

| 不变量（M2Design 第 12 节） | 测试 |
|---|---|
| 7：节点状态、就绪集合、模型上下文都是日志的纯函数 | 属性测试：对任意日志前缀重放，就绪集合与 `context-assemble` 输入与运行时一致（包括压缩与撤销压缩的记录）；投影不引用任何 `fullRef` |
| 27：两次压缩之间只在末尾追加 | 属性测试：同一对象相邻两次组装的输入，前一次是后一次的前缀；运行时上下文变化只产生新的末尾条目 |
| 30：模型只以 `toolCallId` 引用完整输出（阶段 2） | 单元测试：编号翻译覆盖 main 跨 WorkflowRun、已被压缩取代、Fork 继承、被 `/undo` 回退的 Turn（找不到）、SubAgent 读父 AgentRun 的编号（找不到）、编号重复取最近、未截断的调用、未截断而被修剪的调用（阶段 8）；`FEEDBACK` 与投影中不出现 `fullRef` |
| `update_todos`（阶段 2） | 单元测试：参数校验；与普通工具同一次返回时先处理且不触发 `CONTROL_MIXED`；`TODOS_UPDATED` 不含正文；只调用它的轮计入无进展检测 |
| 8：日志只追加 | 单元测试：任何处理只产生追加；修复以追加记录表达 |
| 13：每次用户输入都对应一个 HUMAN 节点 | 单元测试：初始提示、后续消息都形成 HUMAN 节点 |
| 15：日志中只有引用，没有正文 | 单元测试：扫描日志记录，不出现用户输入、回复与工具参数的正文 |
| 6：每个 AgentRun 都能完成收尾 | 场景测试：额度触顶、工具次数触顶、连续出错都进入 final-call，final-call 失败时得到降级回复 |
| 阶段 1 的回归 | `analyze` 在 M1 额度档案下运行 F1–F5（M2Plan 第 8.1 节） |

## 13. 阶段

| 阶段 | 本文增加的内容 |
|---|---|
| 1 | 第 3–12 节（第 7 节第 8、9 条与第 8.4 节除外） |
| 2 | Fork、`baseSha` 与 `expectAbsent`、`WORKSPACE_*` 记录与投影替换、`read_output` 的编号翻译（第 7 节第 8 条）、main 的 `update_todos`（第 7 节第 9 条）、子目录 `AGENTS.md` 的加载（第 8.2 节） |
| 4 | `run_subagents`、汇合、结果契约与改动对账、完成检查、SubAgent 的投影、worker 的 `update_todos` |
| 5 | `steer`（暂停后附加与运行中插话）、`ask_user`、暂停后重新提交、中止后的收敛、Turn 超时后的 `closeRun(TIMEOUT)` |
| 7 | 使用者模板（含其中的条件边）、有界循环、`all_done` 的一般使用、确定性运行报告、`/run` |
| 8 | 第 8.4 节：压缩的配合（包括修剪与 SubAgent 的投影）与投影替换；`CONTEXT_ASSEMBLED.headDigest` |
