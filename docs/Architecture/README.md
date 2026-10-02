# MultiAgentOS 架构指南

## 1. 文档目的

本目录定义 MultiAgentOS 的长期系统边界、权威状态、协作协议、关键机制和运行闭环。
目标运行平台为 Ubuntu LTS。概念与约束应完整表达；具体接口、算法参数和部署配置由各 MVP 细化。
长期技术选择与适配边界见 TechStack，某项能力暂不交付不表示其架构约束被取消。
交付文档由 [总文档索引](../README.md) 导航。

规范词含义如下：

- **必须**：所开放能力必须遵守的约束，不表示每个 MVP 同时实现全部长期能力。
- **不得**：禁止出现的行为或依赖。
- **应**：默认执行；偏离时必须记录架构决策及替代保障。
- **可以**：不破坏不变量的可选实现。

## 2. 阅读顺序

1. [Overall](Overall.md)：目标、分层、所有权、领域对象和系统不变量。
2. [Protocol](Protocol.md)：跨模块消息、身份、版本、错误和兼容规则。
3. [Instance](Instance.md)：关键任务、控制、恢复和失败路径。
4. 阅读 [Kernel](module/Kernel.md) 与 [Execution](module/Execution.md)，再按需阅读其他 Module 和 Infrastructure。
5. [TechStack](TechStack.md)：技术选择、适配边界和验证要求。

## 3. Module

| 文档 | 权威范围 |
|---|---|
| [UserInteraction](module/UserInteraction.md) | WorkSession、SessionTree、PromptRevision、用户意图和交互视图 |
| [Workflow](module/Workflow.md) | TaskGraph、MissionScope、AgentRun、UnitIntent、验收、恢复和补偿语义 |
| [Kernel](module/Kernel.md) | Gateway、Core、Scheduler、Monitor、Supervisor；授权、租约、调度、资源、控制和监管 |
| [ContextEngine](module/ContextEngine.md) | ContextRecord、索引、检索、ContextPack，以及 CONTEXT Unit 执行能力 |
| [AgentToolPool](module/AgentToolPool.md) | 具体且不可变的 Agent、Unit、Tool、Executor 定义版本及其合法组合 |
| [Execution](module/Execution.md) | UnitAttempt、Tool 序列、Executor 实例、模型网关、Workspace 和 Git 物理操作 |

Execution 是独立执行模块，拥有实际尝试和步骤状态；授权与调度归 Kernel，业务验收归 Workflow。逻辑模块、代码包和 OS 进程不要求一一对应。

## 4. Infrastructure

| 文档 | 权威范围 |
|---|---|
| [ModuleHost](infrastructure/ModuleHost.md) | Supervisor 管辖的组合、配置、模块生命周期和健康状态 |
| [SharedContracts](infrastructure/SharedContracts.md) | Agent/Unit/Tool/Executor 通用协议、Schema、Registry、规范化编码和兼容校验 |
| [Persistence](infrastructure/Persistence.md) | 事务、Migration、Journal、Inbox/Outbox、备份和投影重建 |
| [Communication](infrastructure/Communication.md) | Kernel 管辖的通信、IPC、Command/Query/Event/Signal/Result 和流式通道 |
| [ArtifactStore](infrastructure/ArtifactStore.md) | 不可变大对象、完整性、保留关系和垃圾回收 |

Infrastructure 提供技术机制，不解释 WorkSession、Task、MissionScope、Policy 或 Context 的业务语义。ModuleHost 和 Communication 的管理归属不要求实现嵌入 Core，也不允许绕过状态 Owner。

## 5. 权威与变更规则

1. [Overall](Overall.md) 定义系统级所有权和不变量。
2. Module 文档定义模块内部模型、关键机制和公开协作面，与 Overall 的调用方向保持一致。
3. [Protocol](Protocol.md) 定义长期协议规则；SharedContracts 文档定义这些规则的工程实现。
4. 具体交付文档只能选择架构协议的受限子集，不得改变长期语义。
5. `packages/contracts/src` 是已实现 Schema 的可执行事实源；文档与代码不一致时必须记录差距，不得静默解释。
6. 会议记录仅保存讨论背景，不覆盖规范文档。

改变所有权、主调用方向、身份链、错误语义、持久化一致性或安全边界时，必须先修改 Overall 和 Protocol，再修改受影响的 Module、Infrastructure、交付计划与测试。

## 6. 文档衔接清单

跨模块契约需要明确版本和迁移关系。下列事项保留为显式协同问题，不以新术语静默覆盖已发布接口。

| ID | 涉及范围 | 需要衔接的内容 | 完成条件 |
|---|---|---|---|
| A-01 | AgentToolPool | Unit.toolRefs 集合与一 Unit 一 Tool 粒度、Tool 内 Executor 序列 | 明确定义结构、固定版本和旧契约迁移 |
| A-02 | Workflow | 既有主链由 Kernel 创建 Attempt；目标由 Execution 创建维护 | 明确经 Kernel 的获准请求与结果交接，Workflow 不获得 Attempt 写权 |
| A-03 | ContextEngine | ContextPort、执行目标与现有 Permit 契约 | 明确 Execution 协调与许可投影，不丢失身份、范围和版本检查 |
| A-04 | ContextEngine | PREFIX 信任分类与基于元数据的 snapshotId | 澄清仓库材料标注及内容一致性边界，不将元数据摘要视为内容快照 |
| A-05 | MVP 与实现 | 现有模块计数、Provider SDK 包位置和接口 | 在交付详细设计中同步 Schema、实现及生产者/消费者测试 |
| A-06 | Lease / Permit | 可复用长期资格与每 Attempt 执行凭证 | 明确撤销、fencing、版本和恢复，不能复用旧字段改变语义 |
| A-07 | Ubuntu LTS 部署 | 技术基线在目标平台的配置与能力 | 明确支持版本、IPC/隔离配置、失效行为和验收证据 |

各模块负责人共同确认涉及自身契约的变化。具体实现差距在对应交付进度文档记录，
本指南只维护架构衔接关系，不替代任务或变更日志。
