# MultiAgentOS M1 Kernel.Monitor

## 1. 定位

Monitor 维护资源账本并判断额度阈值，只在被 Core 调用时运行。组件间交互见 [Interaction](Interaction.md)，
长期规划见 [Kernel 架构](../../Architecture/Module/Kernel.md) §9。

## 2. 职责

- 实现 `MonitorDuties`（Interaction 3.4）：`reserve`、`settle`、`budgetState`、`finalize`。
- 维护 token 额度、预留、已消费、释放和未知消耗，账本以 WorkflowRun 为单位，Planner 与 CodeViewer 共用。
- 结算以 `reservationId` 幂等，防止重复扣减或重复释放。
- 区分实际消耗与未知消耗；失败、超时或取消不能直接按零消耗处理。
- 按第 3.2 节判断额度状态，并为 final-call 保留额度。
- 收敛时完成最终结算并提供 `BudgetSummary`。
- 不接收任何组件的直接上报；用量随执行事实进入运行 actor，由 Core 在结果检查中调用 `settle`。
  被调用时发现的异常（结算冲突、实际用量超过估算）以返回值交给 Core，由 Core 写入审计。

Workflow 负责 Round 上限与业务收尾，不持有任何 token 数值，只经 UnitReport 的 `budgetState` 得知额度状态。

## 3. 额度机制

额度机制参照两类成熟做法：文件系统配额在硬限制处拒绝新的分配（EDQUOT），而不终止进程；
ext4 为 root 保留一部分空间，普通写入用不到这部分空间，root 仍可完成收尾。M1 用 `finalReserve`
为 final-call 保留额度，使收尾调用在额度紧张时仍然能够发起。

### 3.1 账本

| 符号 | 含义 |
|---|---|
| L | `budget.tokenLimit`，一次 WorkflowRun 的总额度 |
| F | `finalReserve`，只供 final-call 使用的保留额度（第 4 节派生） |
| U | 已结算的实际用量（输入 + 输出） |
| K | 未知消耗：请求可能已发出但无法得到用量时，按预留额全额计入 |
| R | 在途预留：已预留、尚未结算的额度；M1 串行执行，R 为 0 或一次调用的预留额 |
| est | 本次调用的估算上界 = `estimatePackTokens(ContextPack)` + 本次 `max_tokens` |
| finalEst | final-call 的估算上界 = `budget.finalInputBudget` + `budget.finalMaxOutputTokens` |

单位为 token，以 provider 返回的用量为准。只有 model-call 消耗 token。每个运行至多一次 final-call（Core 强制，见 [Core](Core.md) 5.1），
因此一份 F 足以覆盖整个运行的收尾。

### 3.2 额度状态

额度状态由结算后的 U + K 决定，只能前进：NORMAL → WRAP_UP → EXHAUSTED。

| 状态 | 条件（剩余 = L − U − K） | 含义 |
|---|---|---|
| NORMAL | 剩余 ≥ F + `wrapUpMargin` | 正常推进 |
| WRAP_UP | 剩余 < F + `wrapUpMargin`，或普通 model-call 预留被拒 | 应收尾 |
| EXHAUSTED | 剩余 < finalEst，或 final-call 预留被拒 | 不再允许任何 model-call |

`wrapUpMargin` 为一次普通 model-call 的估算上界，使 WRAP_UP 比普通调用被拒提前一次调用发出。

### 3.3 预留

```text
reserve(estimatedTokens = est, final)
  状态为 EXHAUSTED → { ok: false, BUDGET_EXHAUSTED }
  普通：U + K + R + est ≤ L − F → 记录预留，返回 reservationId
        否则 → 状态至少前进到 WRAP_UP，返回 { ok: false, BUDGET_WRAP_UP }
  final：U + K + R + est ≤ L    → 记录预留（可以使用 F），返回 reservationId
        否则 → 状态前进到 EXHAUSTED，返回 { ok: false, BUDGET_EXHAUSTED }
```

被拒的 model-call 没有发出，不消耗 token，也不计 Round。普通 model-call 永远不能使用 F，因此只要 est 确为上界，
结算后始终满足 U + K ≤ L − F，F 保持完整；启动校验保证 finalEst ≤ F，final-call 的预留必然成功。

### 3.4 结算

```text
settle(reservationId, settlement)
  ACTUAL(usage) → U += usage.inputTokens + usage.outputTokens，释放预留
  NOT_SENT      → 全额释放预留
  UNKNOWN       → K += 预留额，释放预留
  重新判断第 3.2 节的状态并返回
```

- 结算不阻止本次结果交付：用量已经发生，结果可能正是最终答案。
- 实际用量超过 est 时按实际结算，并作为结算异常返回给 Core 写入审计（`SETTLEMENT_ANOMALY`），不视为安全违规。
  超出部分会占用 F；只有一次调用超出 est 的量大于 F，运行才会直接进入 EXHAUSTED。
- 同一 `reservationId` 再次结算时不重复记账；数值冲突时按较大值记账，并作为结算异常返回。
- `finalize()` 把仍未结算的预留按 UNKNOWN 结算，返回 `BudgetSummary`。

### 3.5 输入 token 上界

输入 token 上界使用 contracts 的 `estimatePackTokens`（定义见 M1Interface 6.3）：每个条目按其 `role`、`content`、`toolCallId`、
`toolCalls`、`toolSpecs` 的规范 JSON 计算 UTF-8 字节数，再加 16 的固定开销。工具的 JSON Schema 与历史中的工具调用参数都随请求发给 provider，
因此都计入估算。BPE 类 tokenizer 的单个 token 至少覆盖一个字节，因此该估算不低于实际值。context-assemble 按同一函数裁剪：
普通组装不超过 `perCallInputLimit`，final 组装不超过 `finalInputBudget`，且裁剪顺序保证必然能装入（M1Interface 6.3）。
因此 NORMAL 状态下普通 model-call 的预留必然成功，final-call 的 est 不超过 finalEst。
Execution 计算 est 时对 ContextPack 重新调用同一函数，不采信 Executor 报告的数字。

## 4. 配置（`KernelConfig.budget`）

| 配置 | 读取者 | 用途 | 建议初值 |
|---|---|---|---|
| `tokenLimit` | Monitor | L | 600000（需评测校准） |
| `perCallInputLimit` | Execution | 普通 context-assemble 的 `tokenBudget` | 64000 |
| `finalInputBudget` | Execution | final context-assemble 的 `tokenBudget` | 48000 |
| `maxOutputTokens` | Execution | 普通 model-call 的 `max_tokens` | 8192 |
| `finalMaxOutputTokens` | Execution | final-call 的 `max_tokens` | 8192 |
| `orientBudget` | Execution | repository-orient 的 `tokenBudget` | 4000 |
| `searchBudget` | Execution | repository-search 的 `tokenBudget` | 4000 |

派生值，不单独配置：

- `finalReserve` = `finalInputBudget` + `finalMaxOutputTokens`
- `wrapUpMargin` = `perCallInputLimit` + `maxOutputTokens`

启动时校验，不满足即为配置错误，系统不启动：

1. `tokenLimit ≥ finalReserve + wrapUpMargin`。
2. `maxOutputTokens` 与 `finalMaxOutputTokens` 不超过模型的 `limits.maxOutputTokens`；
   `perCallInputLimit + maxOutputTokens` 不超过模型的 `limits.contextWindowTokens`。
3. 对从入口 Agent 可达的每个 Agent，不可裁剪段的估算上界小于对应预算。不可裁剪段为 INSTRUCTIONS、TOOLS、OBJECTIVE、
   HANDOFF、STATUS；OBJECTIVE 与 HANDOFF 按 Schema 的最大长度乘以 4 字节计算（目标 4000 字符，交接说明合计 4500 字符），
   STATUS 按 512 字节计算。普通组装使用该 Agent 全部工具说明，须小于 `perCallInputLimit`；final 组装只使用 finish 控制工具说明，
   须小于 `finalInputBudget`。估算使用 `estimateItemTokens`，TOOLS 段按包含 JSON Schema 的完整 `toolSpecs` 计算。
4. 对包含 file-read 的 Agent，`executionLimits.FILE_READ.maxOutputBytes` 加该 Agent 普通组装不可裁剪段的估算上界小于
   `perCallInputLimit`，使一次完整的读取结果能够单独装入下一次普通组装。

## 5. M1 不实现

通用监控告警平台、CPU/GPU 周期采样、异常预测或自适应反馈调节；AgentRun 级额度留作后续演进。
