# MultiAgentOS AgentToolPool

## 1. 定义

AgentToolPool 是 Agent、Unit、Tool 和 Executor 静态定义版本及其兼容关系的唯一权威，并维护这些定义引用的 Model、Prompt 与 Contract。它回答“有哪些不可变能力定义及其合法组合”，不回答“本次运行是否获得授权或由哪个运行时实例执行”。

## 2. 领域对象

| 对象 | 说明 |
|---|---|
| Definition | 稳定逻辑身份和类型 |
| AgentDefinitionVersion | Agent 的角色、行为约束、输入输出 Contract、允许 Unit 集合与组合约束 |
| UnitDefinitionVersion | 一个可准入动作的 Contract、所需 capability、允许 Tool 集合、效果和资源约束 |
| ToolDefinitionVersion | 工具操作的参数/结果 Schema、风险、副作用、幂等与供应链声明 |
| ExecutorDefinitionVersion | Executor 类别的 capability、支持 Contract、运行环境和资源边界 |
| CapabilityRequirement | 调用方所需能力、数据等级和执行条件 |
| CompatibilityResult | 输入输出 Contract、运行环境和能力的匹配结果 |
| DefinitionStatus | `ACTIVE`、`DEPRECATED`、`QUARANTINED` 或 `REVOKED` |

每个 DefinitionVersion 至少描述稳定 ID、版本、内容 digest、输入/输出 ContractRef、capabilities、riskClass、运行环境、资源提示、供应链来源和兼容范围。版本发布后不可改写；语义变化必须发布新版本。

## 3. 定义类型

目录中的 `kind` 固定为 `AGENT | UNIT | TOOL | EXECUTOR | MODEL | PROMPT | CONTRACT`。

- Agent：角色、行为约束、输入输出 Contract、Prompt/Model 引用、允许的 `UnitDefinitionVersionRef` 封闭集合，以及 Unit 的顺序、次数、前置条件和终止约束。Agent 不直接声明可调用 Tool。
- Unit：单一可审计动作的输入输出 Contract、`requiredCapabilities`、允许的 `ToolDefinitionVersionRef` 封闭集合、效果类型、幂等规则、资源上限和可选补偿定义。Unit 不绑定运行时 executorId。
- Tool：参数 Schema、结果 Schema、风险、幂等性、副作用、dry-run、补偿能力及供应链来源。Tool 只能由引用它的 Unit 调用。
- Executor：静态执行器类别、可提供 capability、支持的 Unit/Tool Contract、运行环境、数据等级、隔离和资源约束。endpoint、进程、会话、Lease、健康度和负载属于运行时状态，不进入定义。
- Model：Provider 能力、上下文限制、结构化输出、动作提案和数据处理约束。
- Prompt：不可变内容、变量 Contract、适用 Agent/Task 类型和安全策略。
- Contract：跨定义共享的输入、输出和证据 Schema。

所有引用必须包含稳定 ID、版本和 digest。Agent、Unit、Tool 与 Executor 的通用字段及运行时对象协议由 [SharedContracts](../infrastructure/SharedContracts.md) 定义；AgentToolPool 只保存通过该协议校验的具体版本。

## 4. 解析算法

```text
DefinitionQuery
  -> 按 kind / stable ID / version range 取候选
  -> 校验 DefinitionStatus
  -> 展开并校验 Agent -> Unit -> Tool 引用闭包
  -> 校验 CapabilityRequirement
  -> 校验输入输出 Contract 兼容性
  -> 以 Unit.requiredCapabilities 匹配 ExecutorDefinitionVersion
  -> 校验执行环境与数据等级约束
  -> 按确定性规则选择
  -> 返回不可变 DefinitionVersion 集合及解释
```

相同目录快照和查询必须返回相同结果。无法满足要求时返回结构化不兼容原因，不得自动降低安全等级或替换为语义不同的定义。

## 5. 运行固定

Workflow 在创建 AgentRun 时解析 AgentDefinitionVersion，并固定它及其允许的 UnitDefinitionVersion、ToolDefinitionVersion、Prompt、Model 与 Contract 引用闭包。运行过程中不得因目录更新静默切换版本。改变 Agent 或 Unit 组合必须创建新的 AgentRun 或 GraphRevision，并重新验证兼容性。

Workflow 创建 UnitIntent 时只能引用该 AgentRun 已固定且由 AgentDefinitionVersion 允许的 UnitDefinitionVersion。Kernel 只读解析固定定义，验证 Agent→Unit 和 Unit→Tool 成员关系，并依据 Unit.requiredCapabilities 从合格的 ExecutorDefinitionVersion 中选择运行时 Executor。Kernel 仍须重新判断身份、Policy、预算、Secret、数据范围、运行时健康度和资源；目录声明不是授权或调度结论。

## 6. 风险与供应链

DefinitionVersion 应按类型声明：

- 默认风险等级与是否要求人工审核；
- 参数变化导致审核失效的规则；
- 最少审查人数和职责分离要求；
- 是否支持 dry-run、回滚、补偿和幂等调用；
- 包、镜像、MCP/OpenAPI 描述或 Prompt 的来源与 digest；
- 可访问的数据类别、网络目标和 Secret 类型。

定义内容发布后不可改写。发现风险时改变 DefinitionStatus；`REVOKED` 定义即使被 checkpoint 引用也不得继续执行。

## 7. 恢复语义

恢复时按 digest 解析历史 DefinitionVersion，并返回：精确可用、兼容替代、隔离、撤销或缺失。兼容替代不得自动改变运行语义；Workflow 根据结果重新规划或进入人工处理。Checkpoint 的保留关系保证定义内容可验证，不保证其仍被允许执行。

## 8. 禁止行为

AgentToolPool 不得保存 MissionScope、AgentRun、UnitIntent、UnitAttempt、运行时 Executor、真实 Secret、动态预算、Grant、Lease、PolicyDecision 或执行结果；不得直接调用模型和工具；不得通过任意 metadata 绕过版本化 Contract。ToolDefinitionVersion 不得被暴露为绕过 Unit 的直接执行入口。

## 9. 测试要求

测试必须覆盖不可变发布、digest 稳定性、版本范围、Agent→Unit 与 Unit→Tool 引用闭包、非法成员引用、能力匹配、Executor 兼容性、Contract 不兼容、确定性选择、撤销阻断、恢复解析、供应链证据、未知定义及无权限扩大。
