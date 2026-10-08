# MultiAgentOS M1 Kernel.Monitor

## 1. 定位

Monitor 维护资源账本并判断额度阈值，只被 Core 调用。组件间交互见 [Interaction](Interaction.md)，
长期规划见 [Kernel 架构](../../Architecture/module/Kernel.md) §7。

## 2. 职责

- 维护 token 额度、预留、已消费、释放和未知消耗，账本以 WorkflowRun 为单位。
- 由 Core 调用完成预留与结算；所有结算以预留标识幂等，防止重复扣减或重复释放。
- 区分实际消耗与未知消耗；失败、超时或取消不能直接按零消耗处理。
- 按第 3 节判断额度状态，并为 final-call 保留额度。
- 观测数据可被动接收，只用于观测与诊断，不影响账本。
- 收敛时完成最终结算并提供用量摘要。

Workflow 负责轮次上限与业务收尾，Monitor 负责实际资源事实。M1 中 Workflow 不接收额度数值，
只接收额度状态。

## 3. 额度机制

额度机制参照两类成熟做法：文件系统配额在硬限制处拒绝新的分配（EDQUOT），而不终止进程；
ext4 为 root 保留一部分空间，普通写入用不到这部分空间，root 仍可完成收尾。M1 用 `finalReserve`
为 final-call 保留额度，使收尾调用在额度紧张时仍然能够发起。

### 3.1 账本

| 符号 | 含义 |
|---|---|
| L | `tokenLimit`，一次 WorkflowRun 的总额度 |
| F | `finalReserve`，只供 final-call 使用的保留额度 |
| U | 已结算的实际用量 |
| K | 未知消耗：请求可能已发出但无法得到用量时，按预留额全额计入 |
| R | 在途预留：已预留、尚未结算的额度；M1 串行执行，R 为 0 或一次调用的预留额 |
| est | 本次调用的估算上界 = 输入 token 上界 + `max_tokens` |
| finalEst | final-call 的估算上界 = `finalInputBudget` + final-call `max_tokens` |

- 单位为 token（输入 + 输出），以 provider 返回的用量为准；账本按 WorkflowRun 计，Planner 与 CodeViewer 共用。
- 预留与结算都由 Core 调用 Monitor 完成，Execution 不直接调用 Monitor。只有 model-call 消耗 token。
- 每个 WorkflowRun 至多发起一次 final-call：Planner 在 final-call 中不能 HANDOFF，
  因此 Planner 的 final-call 之后不会再有 CodeViewer。一份 F 足以覆盖整个运行的收尾。

### 3.2 额度状态

额度状态由结算后的 U + K 决定，只能前进：NORMAL → WRAP_UP → EXHAUSTED。

| 状态 | 条件（剩余 = L − U − K） | 含义 |
|---|---|---|
| NORMAL | 剩余 ≥ F + `wrapUpMargin` | 正常推进 |
| WRAP_UP | 剩余 < F + `wrapUpMargin`，或普通 model-call 预留被拒 | 应收尾：Workflow 执行完本轮剩余工具 Unit 后发起 final-call |
| EXHAUSTED | 剩余 < finalEst | 不再允许任何 model-call；Workflow 以已有材料生成降级报告 |

`wrapUpMargin` 为一次普通 model-call 的估算上界，使 WRAP_UP 比普通调用被拒提前一次调用发出。

### 3.3 预留（调用前）

```text
Execution 出队 model-call → 内部 syscall 向 Core 申请预留（附 est 与是否 final）
  Core 调用 Scheduler：选择调用目标，分配调用机会（每个 provider 并发为 1）
  Core 调用 Monitor.reserve(est, kind)
     普通 model-call：U + K + R + est ≤ L − F → 预留成功，Core 返回 Grant
                      否则 → 不预留，状态至少前进到 WRAP_UP → UnitReport REJECTED(BUDGET_WRAP_UP)
     final-call：     U + K + R + est ≤ L     → 预留成功（可以使用 F）
                      否则 → 不预留，状态前进到 EXHAUSTED → UnitReport REJECTED(BUDGET_EXHAUSTED)
  状态已为 EXHAUSTED 时，任何 model-call → UnitReport REJECTED(BUDGET_EXHAUSTED)
```

被拒的 model-call 没有发出，不消耗 token，也不计入 Round。
普通 model-call 永远不能使用 F，因此只要 est 确为上界，结算后始终满足 U + K ≤ L − F，
F 保持完整；启动校验保证 finalEst ≤ F，final-call 的预留必然成功。

### 3.4 结算（调用后，在结果检查中进行）

```text
Core 调用 Monitor.settle(reservationId, 结算类型)
  ├─ 有实际用量 → 按实际结算，释放差额
  ├─ 请求未发出 → 全额释放预留
  └─ 无法得到用量 → 按预留额全额计入未知消耗
Monitor 按 3.2 重新判断额度状态，随 Core 的判定返回
```

- 结算从不阻止本次结果交付：用量已经发生，结果可能正是最终答案。
- 实际用量超过 est（输入估算偏小或 provider 计数口径变化）时，按实际用量结算并记为结算异常，
  不视为安全违规。超出部分会占用 F；只有一次调用超出 est 的量大于 F，运行才会直接进入 EXHAUSTED。
- 结算以 `reservationId` 幂等；重复结算且数值冲突时，按较大值记账并报告 Core。

### 3.5 输入 token 上界

输入 token 上界使用统一的保守估算：UTF-8 字节数加每条消息的固定开销。BPE 类 tokenizer 的单个 token
至少覆盖一个字节，因此该估算不低于实际值。context-assemble 按同一估算裁剪上下文：
普通轮的输入不超过每轮输入上限，因此 NORMAL 状态下普通 model-call 的预留必然成功；
final-call 的上下文不超过 `finalInputBudget`，因此其 est 不超过 finalEst。
结算时若实际输入 token 超过估算，按 3.4 记为结算异常，用于校准估算方法。

## 4. 配置项

| 配置 | 位置 | 读取者 | 建议初值 |
|---|---|---|---|
| `tokenLimit` | 系统配置 | Monitor | ≥ Σ(maxRounds) × (每轮输入上限 + maxOutputTokens)，数值待定 |
| `finalReserve` | 系统配置 | Monitor | ≥ finalInputBudget + final-call max_tokens |
| `wrapUpMargin` | 系统配置 | Monitor | 每轮输入上限 + 普通 model-call max_tokens |

启动时校验 `finalReserve ≥ finalInputBudget + final-call max_tokens` 与
`tokenLimit ≥ finalReserve + wrapUpMargin`，不满足即视为配置错误。

## 5. M1 不实现

通用监控告警平台、CPU/GPU 周期采样、异常预测或自适应反馈调节；AgentRun 级额度留作后续演进。
