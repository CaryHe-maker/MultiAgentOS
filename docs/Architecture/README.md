# MultiAgentOS 架构指南

## 1. 文档目的

本目录定义 MultiAgentOS 的长期系统边界、权威状态、协作协议、核心算法和运行闭环。内容不表达版本路线或实现完成度；交付文档由 [总文档索引](../README.md) 导航。

规范词含义如下：

- **必须**：实现和测试不可省略。
- **不得**：禁止出现的行为或依赖。
- **应**：默认执行；偏离时必须记录架构决策及替代保障。
- **可以**：不破坏不变量的可选实现。

## 2. 阅读顺序

1. [Overall](Overall.md)：目标、分层、所有权、领域对象和系统不变量。
2. [Protocol](Protocol.md)：跨模块消息、身份、版本、错误和兼容规则。
3. [Instance](Instance.md)：关键任务、控制、恢复和失败路径。
4. 按需阅读 Module、Execution 和 Infrastructure 文档。
5. [TechStack](TechStack.md)：技术选择、适配边界和验证要求。

## 3. Module

| 文档 | 权威范围 |
|---|---|
| [UserInteraction](module/UserInteraction.md) | WorkSession、SessionTree、PromptRevision、用户意图和交互视图 |
| [Workflow](module/Workflow.md) | TaskGraph、MissionScope、AgentRun、UnitIntent、验收、恢复和补偿语义 |
| [Kernel](module/Kernel.md) | 身份、策略、UnitAttempt、成员校验、Executor 选择、租约、审核裁决和运行投影 |
| [ContextEngine](module/ContextEngine.md) | ContextRecord、索引、检索、ContextPack，以及 CONTEXT Unit 执行能力 |
| [AgentToolPool](module/AgentToolPool.md) | 具体且不可变的 Agent、Unit、Tool、Executor 定义版本及其合法组合 |
| [Execution](module/Execution.md) | 运行时 Executor、Workspace、Sandbox、模型/Unit 内 Tool 调用和 Git 物理操作 |

Execution 是 Kernel 管辖的执行面，不是第六个领域 Module，不拥有业务状态或授权结论。

## 4. Infrastructure

| 文档 | 权威范围 |
|---|---|
| [ModuleHost](infrastructure/ModuleHost.md) | 组合、配置、生命周期和健康状态 |
| [SharedContracts](infrastructure/SharedContracts.md) | Agent/Unit/Tool/Executor 通用协议、Schema、Registry、规范化编码和兼容校验 |
| [Persistence](infrastructure/Persistence.md) | 事务、Migration、Journal、Inbox/Outbox、备份和投影重建 |
| [Communication](infrastructure/Communication.md) | Command、Query、Event、Signal 与 Result 的投递 |
| [ArtifactStore](infrastructure/ArtifactStore.md) | 不可变大对象、完整性、保留关系和垃圾回收 |

Infrastructure 只提供领域中立能力，不解释 WorkSession、Task、MissionScope、Policy 或 Context 的业务语义。

## 5. 权威与变更规则

1. [Overall](Overall.md) 定义系统级所有权和不变量。
2. Module 文档定义模块内部模型、算法和公开协作面，不得改变 Overall 的调用方向。
3. [Protocol](Protocol.md) 定义长期协议规则；SharedContracts 文档定义这些规则的工程实现。
4. 具体交付文档只能选择架构协议的受限子集，不得改变长期语义。
5. `packages/contracts/src` 是已实现 Schema 的可执行事实源；文档与代码不一致时必须记录差距，不得静默解释。
6. 会议记录仅保存讨论背景，不覆盖规范文档。

改变所有权、主调用方向、身份链、错误语义、持久化一致性或安全边界时，必须先修改 Overall 和 Protocol，再修改受影响的 Module、Infrastructure、交付计划与测试。
