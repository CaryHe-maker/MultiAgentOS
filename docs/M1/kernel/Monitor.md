# MultiAgentOS M1 Kernel.Monitor

## 1. 定位

Monitor 维护资源账本并判断额度阈值，只被 Core 调用。组件间交互见 [Interaction](Interaction.md)，
长期规划见 [Kernel 架构](../../Architecture/module/Kernel.md) §7。

## 2. 职责

- 维护 token 额度、预留、已消费、释放和未知消耗，账本以 WorkflowRun 为单位。
- 由 Core 调用完成预留与结算；所有结算以预留标识幂等，防止重复扣减或重复释放。
- 区分实际消耗与未知消耗；失败、超时或取消不能直接按零消耗处理。
- 软阈值只在结算时判断，以额度状态（NORMAL / WRAP_UP）返回 Core；硬阈值在预留和结算时都可以触发。
- 保有在达到硬阈值时主动提交 Exception 的权力；M1 中体现为被 Core 调用时返回“达到硬限制”。
- 观测数据可被动接收，只用于观测与诊断，不影响账本。
- 收敛时完成最终结算并提供用量摘要。

Workflow 负责轮次上限与业务收尾，Monitor 负责实际资源事实。M1 中 Workflow 不接收额度数值，
只接收额度状态。

## 3. 额度机制

### 3.1 基本规则

- 单位为 token（输入 + 输出），以 provider 返回的用量为准；账本按 WorkflowRun 计，Planner 与 CodeViewer 共用。
- 预留与结算都由 Core 调用 Monitor 完成，Execution 不直接调用 Monitor。
- 只有 model-call 消耗 token。

### 3.2 预留（调用前）

```text
Execution 出队 model-call → 内部 syscall 向 Core 申请预留
  Core 调用 Scheduler：选择调用目标，分配调用机会（每个 provider 并发为 1）
  Core 调用 Monitor.reserve(估算上界 = 输入 token 上界 + max_tokens)
     ├─ 已用 + 已预留 + 未知 + 估算上界 ≤ tokenLimit → 预留成功，Core 返回 Grant
     └─ 否则 → 达到硬限制（3.4）
```

### 3.3 结算（调用后，在结果检查中进行）

```text
Core 调用 Monitor.settle(reservationId, 结算类型)
  ├─ 有实际用量 → 按实际结算，释放差额
  ├─ 请求未发出 → 全额释放预留
  └─ 无法得到用量 → 按预留额全额计入未知消耗
Monitor 结算后判断：
  ├─ 已用 + 未知 > tokenLimit → 达到硬限制（3.4），本次结果不交付
  ├─ 剩余 ≤ finalReserve → budgetState = WRAP_UP（只标记一次）
  └─ 否则 → NORMAL
```

- 软限制只在结算时触发；硬限制在预留与结算时都可触发。
- 额度阈值指“本次申请将超出上限”或“结算后已超出上限”，不是“恰好等于上限”。
- 结算以 `reservationId` 幂等；重复结算且数值冲突时，Monitor 报告 Core。

### 3.4 硬限制

达到硬限制后由 Core 按 Exception 停止运行（`USAGE_LIMIT`），处理过程与运行超时相同，
见 [Interaction](Interaction.md) 第 6 节。

## 4. 配置项

| 配置 | 位置 | 读取者 | 建议初值 |
|---|---|---|---|
| `tokenLimit` | 系统配置 | Monitor | ≥ Σ(maxRounds) × (每轮输入上限 + maxOutputTokens)，数值待定 |
| `finalReserve` | 系统配置 | Monitor | ≥ finalInputBudget + final-call max_tokens |

启动时校验 `finalReserve ≥ finalInputBudget + final-call max_tokens`，不满足即视为配置错误。

## 5. M1 不实现

通用监控告警平台、CPU/GPU 周期采样、异常预测或自适应反馈调节；AgentRun 级额度留作后续演进。
