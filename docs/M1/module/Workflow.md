# MultiAgentOS M1 Workflow

## 1. 目的与范围

本文规定 M1 Workflow 与 Kernel 协作时的业务机制：Validation、Round 上限、final-call 收尾、
modelReturn 处理、HANDOFF 与 FINISH 后的结束路径。
Workflow 可以发起的 syscall 与 Kernel 返回的信息见 [Kernel（外部视角）](Kernel.md)，
长期规划见 [Workflow 架构](../../Architecture/module/Workflow.md)。

## 2. 职责

Workflow 接收 RunStart；持有 AgentRun 实例；读取 Agent 定义的 limits，维护并判断 Round；执行 Validation；
发起 final-call；处理 HANDOFF；核验来源并生成 AnalysisReport；提交 report-publish；发起 4 种 syscall；
写入运行记录的业务部分；标记业务终态。

## 3. 术语

| 术语 | 定义 |
|---|---|
| Round | 以一次 model-call 为中心的一轮：组织上下文（首轮为 orient + assembly，其后为 assembly）→ model-call → 该次返回所要求的全部工具 Unit 处理完成 |
| final-call | 标记 `final=true`、不提供工具的 model-call，用于收尾 |

## 4. Validation

Workflow 对 modelReturn 中的每个工具调用逐个检查，不通过时交还模型，不进入 Kernel：

- step1：属于 Agent 定义、参数合法、不超过 `maxToolCallsPerRound`；
- step2：软限制判断。

Validation 是 Workflow 的业务检查，不替代 Kernel 的准入、定义核验与权限检查（见 [Kernel](Kernel.md) 第 6 节）。

## 5. Round 机制

- 上限按 Agent 写在 Agent 定义中：`limits.maxRounds`、`limits.maxToolCallsPerRound`，受定义 digest 覆盖。
- Workflow 在创建 AgentRun 时读取上限，`roundsUsed` 从 0 开始；每发起一次 model-call（含重新生成与 final-call）加 1。
- `maxRounds − roundsUsed ≤ 1` 时，下一次 model-call 设为 final-call。HANDOFF 后 CodeViewer 从 0 计数。
- Kernel 不记录 Round，也不设 Round 限制。token 硬限制限定了 model-call 的总次数，作为兜底。
- 技术重试由 Execution 执行，对 Workflow 不可见，不计 Round（见 [Execution](../kernel/Execution.md)）。

## 6. final-call 统一规则

| 触发 | 判断者 | 报告中的收尾说明 | 本轮剩余工具 Unit |
|---|---|---|---|
| Round 达到上限 | Workflow | 已达到轮次上限 | 无 |
| budgetState = WRAP_UP | Monitor（结算时），经 UnitReport 通知 | 已接近额度上限 | 执行完后再发起 final-call |
| USER_DECLINED | Core | 未获得仓库访问授权 | 不再提交读仓库 Unit |

- `final=true`，不提供工具，要求依据已有材料输出最终报告；上下文不超过 `finalInputBudget`；计入 1 个 Round。
- 返回合法 FINISH：进入第 9 节；返回不合法：不再重新生成，以已有材料生成降级报告。
- 每个 AgentRun 最多一次；多个原因同时出现只发起一次。Planner 在 final-call 中不能 HANDOFF。
- 硬限制与超时不发起 final-call。

## 7. AgentRun 登记与 HANDOFF

```text
UserInteraction 创建运行 → Kernel 发出 RunStart → Workflow
Workflow 创建 AgentRun：读取 limits，校验 maxRounds ≥ 1
  → registerAgentRun → Kernel 登记为 ACTIVE → SyscallAck
HANDOFF：endAgentRun(Planner) → registerAgentRun(CodeViewer)
```

Kernel 内部的登记处理见 [Core](../kernel/Core.md)。

## 8. 处理 modelReturn

```text
modelReturn
  ├─ FINISH → 第 9 节
  ├─ HANDOFF → endAgentRun(Planner) → registerAgentRun(CodeViewer) → CodeViewer 首轮
  ├─ INVALID → 错误反馈给模型 → 下一轮（计入 Round）；若为 final-call → 降级报告 → 第 9 节
  └─ TOOL_CALLS → 逐个 Validation step1 → step2 软限制判断 → 依次 submitUnit → 收齐 UnitReport → 下一轮
```

## 9. FINISH 后的结束路径

```text
1. Workflow 生成报告
   1.1 按 AnalysisReport 格式校验 FINISH；不合法时：非 final-call 且有剩余 Round → INVALID；
       final-call → 降级报告
   1.2 核验来源：结论引用的路径与行号范围，必须对应本运行中读取成功的结果；对不上的结论移入"未确认项"
   1.3 组装 AnalysisReport：结论、来源、未确认项，提前收尾时附收尾说明；各 Agent 的 Round 数随报告保存，默认不展示
   1.4 把运行记录的业务部分（步骤、Round 数、收尾原因）写入 runs/<runId>/
2. Workflow → submitUnit(report-publish, 报告内容)
   → 准入、定义核验 → Execution 经 Supervisor 执行发布 Executor：校验格式、写入 ArtifactStore
   → UnitReport(OK, reportRef)；失败或被拒 → 第 4 步改为 closeRun(FAILED)
3. Workflow → endAgentRun（报告发布必须在 AgentRun 仍为 ACTIVE 时进行）
4. Workflow → closeRun{outcome: COMPLETED, reportRef}
5. Core：若已有控制终态（硬限制、超时、取消先发生）→ 返回已有 RunClosed；否则设置准入封锁(CLOSING) → 收敛
   → RunClosed(COMPLETED)
6. Workflow：无未知效果 → 标记 COMPLETED；有未知效果 → 标记 COMPLETED 并在运行记录中注明，不视为干净完成
7. Core → UserInteraction：运行已结束，附 reportRef → UserInteraction 读取并展示 AnalysisReport
8. 关闭系统（见 [ModuleHost](../infrastructure/ModuleHost.md)）
```

Core 不检查报告内容，只记录 `reportRef`；报告是否合格由 Workflow 负责。
收敛过程见 [kernel/Interaction](../kernel/Interaction.md)。

## 10. 配置项

| 配置 | 位置 | 读取者 | 建议初值 |
|---|---|---|---|
| `limits.maxRounds` | Agent 定义 | Workflow | CodeViewer 20；Planner 3（需评测校准） |
| `limits.maxToolCallsPerRound` | Agent 定义 | Workflow | CodeViewer 8；Planner 0 |
| 重新生成次数上限 | Workflow 配置 | Workflow | 3 |
| `finalInputBudget` | 系统配置 | Workflow | 待定 |
