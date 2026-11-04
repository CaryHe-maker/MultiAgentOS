# MultiAgentOS M2 Kernel.Monitor

> 状态：已评审（阶段 1）。

## 1. 定位

Monitor 维护资源账本并判断额度阈值，只在被 Core 调用时运行；唯一的例外是内存采样（第 4a 节），它自己定时运行，结果只以一条控制消息交给 Core。组件间交互见 [Interaction](Interaction.md)，
长期规划见 [Kernel 架构](../../Architecture/Module/Kernel.md) 第 9 节。额度的设计以 [M2Design](../M2Design.md) 第 7.3 节为准。

## 2. 相对 M1 的变化

| M1 | M2 | 阶段 |
|---|---|---|
| 每个运行一份账本，planner 与 code-viewer 共用 | 逐级委派：运行 → Turn → AgentRun；阶段 1 只有运行与 Turn 两级，AgentRun 直接使用 Turn 账本 | 1（AgentRun 级为 4） |
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

- 记账单位：结算额 = 未命中的输入 + 命中的输入 × 命中权重 + 输出；命中权重由预留时给出（模型定义的命中单价 ÷ 未命中单价）。预留额 = 校准后的输入估算 × 1.05 + 该次调用的输出上限（M2Design 第 7.3、9.3 节）。
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

### 3.4 压缩的额度（阶段 8）

M2Design 第 7.3 节"压缩的额度"：

- 自动与溢出触发的压缩，从被压缩对象所用的账本支出：main 为当前 Turn 账本；阶段 4 起模板节点与 SubAgent 为该 AgentRun 自己的账本；
- 修剪不调用模型，不预留；只有摘要请求预留，纯文本回退的每次请求各自预留与结算；
- 预留量 = 摘要请求的输入估算（与普通调用的预留同一方法，不用压缩检查点的实测加估算）+ `summaryMaxTokens`；预留后账本余额必须仍不低于收尾保留 `F`，否则拒绝，Core 不写摘要，
  按额度到达限制的统一路径处理（该 AgentRun 进入最后一轮；SubAgent 以 `finish_subagent` 结束）；
- 用户 `/compact` 与空闲时的预先压缩没有开启中的 Turn，从运行级账本支出；预留后运行级余额必须仍不低于 `minShare(main)`，否则 `/compact` 以 `BUDGET_INSUFFICIENT` 拒绝，预先压缩不做；
- 结算按实际用量（M1 的方式）；缓存命中的输入按模型定义的计价计入。

## 4. 资源上限

| 上限 | 计数 | 触顶时 |
|---|---|---|
| `maxToolUnits` | 该 AgentRun 被受理的工具 Unit 数（不含 `context-assemble`、`model-call` 与两个发布 Unit `message-publish`、`report-publish`：它们用于结束 Agent，触顶后仍须可用） | 拒绝该 AgentRun 后续的非收尾 Unit，原因码 `QUOTA_EXHAUSTED`，`quota = 'TOOL_UNITS'` |
| `maxWallClockMs` | 从登记开始计时；等待人类、等待授权的时间不计入（阶段 5 起暂停也不计入，阶段 4 起等待子任务也不计入）。判定与 Turn 超时的暂停相同：该 AgentRun 没有已派发或待派发的尝试（挂起在授权询问上的不算）且有待答复的询问时停止计时，Core 在每次处理消息的末尾重新判断，只为最早可能到点的墙钟设一个定时器；没有设置该上限的 Agent 不计时 | 同上，`quota = 'WALL_CLOCK'` |

Monitor 只计数与判断，计时器由 Core 持有并在到点时调用 Monitor。重复意图与连续出错是业务判断，归 Workflow（M2Design 第 3.4 节）。

## 4a. 内存采样（阶段 3）

设计以 M2Design 第 7.7 节为准。内存属于整个进程，不属于某个运行，所以不进入账本，也不由 Core 按运行计时。

```text
Monitor 的定时器 ──每 memory.sampleIntervalMs──▶ 采样 ──▶ 判断级别
                                                         │ 只在级别升高时
                                                         ▼
                                     MemoryPressure(level, 采样值) ──控制消息──▶ Core
                                                                                  │ 统一入口
                                               WARNING ──▶ 统一收尾路径（QUOTA_EXHAUSTED, quota = 'MEMORY'）
                                               DANGER  ──▶ 全部运行进入 INTERRUPTING，收敛后安全退出
```

| 项 | 规则 |
|---|---|
| 采样内容 | 进程 RSS 与 `process.constrainedMemory()`（没有限制时为物理内存）之比、V8 堆用量与 `heap_size_limit` 之比、系统可用内存（Linux 的 `MemAvailable`，能反映沙盒中命令子进程的占用）；取其中最高的占用比 |
| 级别 | `NORMAL`、`WARNING`（缺省 75%）、`DANGER`（缺省 90%）；初值在 S3-IN-1 按实测校准，只在升高时发消息，恢复时不撤销已发生的收尾 |
| 职责边界 | 采样器只发 `MemoryPressure`，不持有 Core、Workflow 或运行的任何句柄，不能自己取消、关闭运行或停机；采样和发送本身不分配随运行增长的内存 |
| 定时器 | `unref`，不阻止进程退出；采样失败时记一次诊断日志，不当作压力 |

## 5. 接口

`MonitorDuties` 的阶段 1 形式见 [Interaction](Interaction.md) 第 4 节。`budgetView(agentRunId)` 返回该 AgentRun 所在各级账本的状态；
阶段 1 中 `agentRun` 一项等于 `turn`。

## 6. 配置（`KernelConfig.budget`）

| 配置 | 缺省（初值） | 说明 |
|---|---|---|
| `runTokenLimit` | 12000000 | 运行级上限 |
| `turnTokenLimit` | 4000000 | 每个 Turn 的上限 |

M1 的 `perCallInputLimit`、`maxOutputTokens`、`finalInputBudget`、`finalMaxOutputTokens` 从全局配置移入 Agent 定义；
`orientBudget`、`searchBudget` 仍是全局配置（M1 Monitor 第 4 节）。

**启动检查**（沿用 M1 Monitor 第 4 节的做法，作用于每个可登记的 Agent）：

1. 每个 Agent 的四个额度参数为正安全整数，求和不溢出；
2. 每个 Agent 的普通调用与收尾调用的估算不超过其模型的上下文窗口与输出上限；
3. `turnTokenLimit ≥ minShare(main)`；`runTokenLimit ≥ turnTokenLimit`；
4. 固定部分（system 段、`PINNED` 条目的上限、STATUS 与收尾提示）的估算严格小于该 Agent 的 `perCallInputLimit` 与 `finalInputBudget`（M1 的第 4、5 条，改为按 Agent 计算）。

## 7. 不变量与测试

| 不变量（M2Design 第 12 节） | 测试 |
|---|---|
| 6：每个已登记的 AgentRun 都能完成收尾 | 属性测试：任意预留与结算序列下，收尾预留必然成功 |
| 22（阶段 1 部分）：每个账本的在途预留至多一份；Turn 结束时剩余全部返还 | 单元测试：同一 Turn 不能有两份在途预留；`closeTurnLedger` 后运行级剩余 = 原剩余 − Turn 已用 − 未知 |
| 额度不触发收敛 | 状态机测试：账本 EXHAUSTED 时运行仍为 RUNNING，直到 Workflow `closeRun` |
| 内存压力没有特例路径 | 架构测试：采样器只依赖发消息的接口；单元测试：假采样值只产生 `MemoryPressure`，级别升高才发，同一级别不重复 |

## 8. 阶段

| 阶段 | 本文增加的内容 |
|---|---|
| 1 | 第 3–7 节（第 3.4 节除外） |
| 3 | 第 4a 节：内存采样 |
| 4 | AgentRun 级账本与逐级委派、委派保留、`minShare` 的派生检查、等待子任务时墙钟暂停 |
| 5 | 暂停时墙钟暂停 |
| 7 | 模板节点从 Turn 账本划出份额 |
| 8 | 第 3.4 节：压缩的额度（SubAgent 的部分在阶段 4 完成后） |
