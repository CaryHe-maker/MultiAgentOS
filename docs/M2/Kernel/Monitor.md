# MultiAgentOS M2 Kernel.Monitor

> 状态：草稿（阶段 1）。

## 1. 定位

Monitor 维护资源账本并判断额度阈值，只在被 Core 调用时运行。组件间交互见 [Interaction](Interaction.md)，
长期规划见 [Kernel 架构](../../Architecture/Module/Kernel.md) 第 9 节。额度的设计以 [M2Design](../M2Design.md) 第 7.3 节为准。

## 2. 相对 M1 的变化

| M1 | M2 | 阶段 |
|---|---|---|
| 每个运行一份账本，planner 与 code-viewer 共用 | 逐级委派：运行 → Turn → AgentRun；阶段 1 只有运行与 Turn 两级，main 直接使用 Turn 账本 | 1（AgentRun 级为 4） |
| `finalReserve` 每个运行一份，至多一次 final-call | 每个 AgentRun 一份收尾保留、至多一次 final-call；收尾保留按该 Agent 的额度参数计算 | 1 |
| 额度参数是全局配置 | 写在每个 Agent 定义中（Interface/Definitions 第 2 节） | 1 |
| 额度只看 token | 增加工具 Unit 次数与墙钟两项资源上限（`QUOTA_EXHAUSTED`） | 1 |
| 额度耗尽时 Core 收敛运行 | 只拒绝预留并告知，收尾与结束由 Workflow 完成 | 1 |

预留、结算、额度状态的算法与 M1 相同（M1 Monitor 第 3 节），只是作用于每一个账本。

## 3. 账本

### 3.1 运行级账本

- `L_run = budget.runTokenLimit`；不直接发生模型调用，只为 Turn 划出份额、收回剩余。
- 状态按"本 Turn 现在结束时运行级账本的余额"判定：`R = 运行级剩余 + 本 Turn 账本的余额 − 本 Turn 的在途预留`（没有开启中的 Turn 时就是运行级剩余）。
  `R < minShare(main)` 时为 WRAP_UP，`R = 0` 时为 EXHAUSTED。
- 这样判定的原因：Turn 开启时从运行级扣除的是整份 `L_turn`，Turn 中途的运行级剩余会低估 Turn 结束后的余额。Workflow 在请求下一个开放输入之前，
  最后一个 UnitReport（Turn-chat 中是 `message-publish`）的 `BudgetView.run` 就是 Turn 结束后的准确状态，据此决定请求开放输入还是 `closeRun(BUDGET)`。

### 3.2 Turn 账本

- 开启：`L_turn = min(budget.turnTokenLimit, 运行级剩余)`；从运行级账本扣除。`L_turn < minShare(main)` 时照常开启，状态直接为 WRAP_UP（[Core](Core.md) 第 6 节）。
- 阶段 1 中 Turn 账本就是 main 的账本：`F = F(main)`，`wrapUpMargin = wrapUpMargin(main)`，预留与状态按 M1 Monitor 第 3.2、3.3 节计算。
- 结束：未结算的预留按 UNKNOWN 结算（M1 的 `finalize` 规则），剩余返还运行级账本；返回 `TurnUsage`。

### 3.3 派生值

由 Agent 定义的四个额度参数派生（M2Design 第 7.3 节）：

```text
F(agent)            = finalInputBudget + finalMaxOutputTokens
wrapUpMargin(agent) = perCallInputLimit + maxOutputTokens
minShare(agent)     = F(agent) + 2 × wrapUpMargin(agent)
```

### 3.4 `analyze` 的 M1 额度档案

运行使用内置模板 `analyze` 时（M2Plan 第 8.1 节）：运行级与 Turn 账本合一，`L = 300000`；planner 与 code-viewer 共用这一份账本；
`F` 与 `wrapUpMargin` 取 M1 的全局值（M1 Monitor 第 4 节）；整个运行至多一次 final-call（由 Core 按运行而不是按 AgentRun 计）。
档案由 `budget.profiles.analyze` 配置，按模板 ID 选用。

## 4. 资源上限

| 上限 | 计数 | 触顶时 |
|---|---|---|
| `maxToolUnits` | 该 AgentRun 被受理的工具 Unit 数（不含 `context-assemble`、`model-call`、`message-publish`） | 拒绝该 AgentRun 后续的非收尾 Unit，原因码 `QUOTA_EXHAUSTED`，`quota = 'TOOL_UNITS'` |
| `maxWallClockMs` | 从登记开始计时；等待人类、等待授权的时间不计入（阶段 5 起暂停也不计入，阶段 4 起等待子任务也不计入） | 同上，`quota = 'WALL_CLOCK'` |

Monitor 只计数与判断，计时器由 Core 持有并在到点时调用 Monitor。重复意图与连续出错是业务判断，归 Workflow（M2Design 第 3.4 节）。

## 5. 接口

`MonitorDuties` 的阶段 1 形式见 [Interaction](Interaction.md) 第 4 节。`budgetView(agentRunId)` 返回该 AgentRun 所在各级账本的状态；
阶段 1 中 `agentRun` 一项等于 `turn`。

## 6. 配置（`KernelConfig.budget`）

| 配置 | 缺省（初值） | 说明 |
|---|---|---|
| `runTokenLimit` | 5000000 | 运行级上限 |
| `turnTokenLimit` | 2000000 | 每个 Turn 的上限 |
| `profiles.analyze` | `{ tokenLimit: 300000, finalReserve 与 wrapUpMargin 取 M1 的值 }` | 第 3.4 节 |

M1 的 `perCallInputLimit`、`maxOutputTokens`、`finalInputBudget`、`finalMaxOutputTokens` 从全局配置移入 Agent 定义；
`orientBudget`、`searchBudget` 仍是全局配置（M1 Monitor 第 4 节）。

**启动检查**（沿用 M1 Monitor 第 4 节的做法，作用于每个可登记的 Agent）：

1. 每个 Agent 的四个额度参数为正安全整数，求和不溢出；
2. 每个 Agent 的普通调用与收尾调用的估算不超过其模型的上下文窗口与输出上限；
3. `turnTokenLimit ≥ minShare(main)`；`runTokenLimit ≥ turnTokenLimit`；
4. 不可裁剪段的估算严格小于该 Agent 的 `perCallInputLimit` 与 `finalInputBudget`（M1 的第 4、5 条，改为按 Agent 计算）。

## 7. 不变量与测试

| 不变量（M2Design 第 12 节） | 测试 |
|---|---|
| 6：每个已登记的 AgentRun 都能完成收尾 | 属性测试：任意预留与结算序列下，收尾预留必然成功 |
| 22（阶段 1 部分）：每个账本的在途预留至多一份；Turn 结束时剩余全部返还 | 单元测试：同一 Turn 不能有两份在途预留；`closeTurnLedger` 后运行级剩余 = 原剩余 − Turn 已用 − 未知 |
| 额度不触发收敛 | 状态机测试：账本 EXHAUSTED 时运行仍为 RUNNING，直到 Workflow `closeRun` |

## 8. 阶段

| 阶段 | 本文增加的内容 |
|---|---|
| 1 | 第 3–7 节 |
| 4 | AgentRun 级账本与逐级委派、委派保留、`minShare` 的派生检查、等待子任务时墙钟暂停 |
| 5 | 暂停时墙钟暂停 |
| 7 | 模板节点从 Turn 账本划出份额 |
