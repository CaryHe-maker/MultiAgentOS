# MultiAgentOS 文档索引

## 1. 文档分区

| 目录 | 作用 | 权威范围 |
|---|---|---|
| [Architecture](Architecture/README.md) | 完整系统架构 | 长期边界、所有权、算法、协议和运行闭环 |
| [M1](M1/README.md) | 当前交付 | M1 范围、接口、任务、进度和验收 |
| [Requirements](Requirements/Dependencies.md) | 依赖基线 | 仓库实际声明的环境和直接依赖 |
| [Meetings](Meetings/) | 讨论记录 | 原始背景，不作为规范性事实源 |
| [Style](Style.md) | 工程治理 | 代码、文档、Git、Commit 和 Pull Request 规范 |

## 2. 推荐阅读顺序

1. [整体架构](Architecture/Overall.md)
2. [协议架构](Architecture/Protocol.md)
3. [运行实例](Architecture/Instance.md)
4. [Module 与 Infrastructure 索引](Architecture/README.md)
5. [M1 计划](M1/M1Plan.md)
6. [M1 技术栈](M1/M1TechStack.md)
7. [M1 接口](M1/M1Interface.md)
8. [M1 进度](M1/M1Process.md)

## 3. Architecture

### 3.1 顶层

| 文档 | 内容 |
|---|---|
| [Architecture/README](Architecture/README.md) | 架构指南、阅读顺序和权威关系 |
| [Overall](Architecture/Overall.md) | 系统目标、原则、分层、领域对象和不变量 |
| [Protocol](Architecture/Protocol.md) | 消息、身份、版本、错误、审核、恢复和完成协议 |
| [Instance](Architecture/Instance.md) | 分析、执行、集成、审核、恢复、取消和故障路径 |
| [TechStack](Architecture/TechStack.md) | 技术选择、Adapter 边界和引入条件 |

### 3.2 Module 与 Execution

| 文档 | 内容 |
|---|---|
| [UserInteraction](Architecture/module/UserInteraction.md) | Session、Prompt、用户意图、视图和审核交互 |
| [Workflow](Architecture/module/Workflow.md) | TaskGraph、MissionScope、状态机、验收、恢复和补偿 |
| [Kernel](Architecture/module/Kernel.md) | 设计占位；内部设计待补充 |
| [ContextEngine](Architecture/module/ContextEngine.md) | 索引、检索、上下文预算、provenance 和恢复 |
| [AgentToolPool](Architecture/module/AgentToolPool.md) | DefinitionVersion、能力匹配和供应链状态 |
| [Execution](Architecture/module/Execution.md) | Executor、Workspace、Sandbox、模型、工具和 Git |

### 3.3 Infrastructure

| 文档 | 内容 |
|---|---|
| [ModuleHost](Architecture/infrastructure/ModuleHost.md) | 组合、配置、生命周期和健康状态 |
| [SharedContracts](Architecture/infrastructure/SharedContracts.md) | Schema、Registry、兼容与规范化编码 |
| [Persistence](Architecture/infrastructure/Persistence.md) | 事务、Journal、Inbox/Outbox、Migration 和备份 |
| [Communication](Architecture/infrastructure/Communication.md) | 消息路由、投递、重试、Signal 和背压 |
| [ArtifactStore](Architecture/infrastructure/ArtifactStore.md) | 内容寻址、完整性、保留和垃圾回收 |

## 4. 权威顺序

1. Architecture 定义系统长期所有权、调用方向和算法不变量。
2. M1Plan 定义当前交付范围；M1Interface 定义该范围内必须实现的具体协议。
3. `packages/contracts/src` 是已实现 Schema 的可执行事实源；实现差距记录在 M1Process。
4. M1Process 只记录状态和证据，不改变范围或架构。
5. Meetings 仅提供讨论背景。

所有规范性文档统一使用 `MultiAgentOS` 作为项目名称。架构、接口、依赖或工程规则变化时，应同时检查本索引与仓库根 `README.md`。
