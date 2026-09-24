# MultiAgentOS M1 / 0.1 目标设计

> 文档类型：当前首版的规范性目标设计  
> 当前里程碑：M1  
> 产品版本：0.1 Repository Analysis MVP<br>
> 达成计划：`docs/M1Plan/M1AchievePlan.md`
> 长期架构：`docs/DesignReport/TargetArchitecture.md`  
> Workflow 完整目标设计：`docs/DesignReport/WorkflowModuleReport.md`  
> 技术选型：`docs/TechStack.md`

## 1 文档权威与版本定义

本文定义 M1/0.1 必须实现的系统边界、模块接口、执行路径和验收标准，是当前开发的范围权威。M1–M5 是开发里程碑；M5 完成并通过生产验收后发布 V1.0。`TargetArchitecture.md` 和 `WorkflowModuleReport.md` 保存长期设计；其中未被本文明确引用的业务能力不得进入 M1 完成定义，但长期架构定义的五个一级 Module、五项 Infrastructure、所有权边界和关键数据传递线路必须从 M1 起建立稳定边界。

M1 对当前关键线路“预留”的定义是：独立包或明确目录、当前需要的公开 Port、运行时可校验 Contract、Module Host 装配点、fake/disabled adapter，以及证明调用方向的架构测试。对尚未进入实现里程碑的 M2–M5 能力，M1 只冻结协议族名称、owner、opaque Ref、capability 和统一 Unsupported 结果；不得提前冻结未经真实用例验证的完整 Port 或 payload。这样后续里程碑可以增加实现，同时允许实验性 `v0` 契约基于证据演进。

本文中的版本关系为：

| 名称 | 含义 |
|---|---|
| M1 / 0.1 | 本地只读 Repository Analysis Agent |
| M2 / 0.2 | 安全的单 Coding Agent；再分阶段加入持久化、幂等、取消和崩溃恢复 |
| M3 | 静态多任务图、多 Executor Process 与 Git 结果集成 |
| M4 | Checkpoint、审批、强执行隔离和完整可观测性 |
| M5 / V1.0 | 多租户、远程执行、生产运维和平台化扩展；完成后首次发布 V1.0 |

公共契约在 M1 验收结束前使用 `v0/experimental`。只有经过固定任务集验证的字段和语义才能升级为稳定 `v1`。

## 2 M1 的目标

M1 要交付一个真正可以运行的只读 Repository Analysis Agent，而不是直接进入 coding 或先交付完整可靠性平台。用户提交一个仓库分析问题后，系统能够理解陌生项目、调用模型、执行受控的 tree/search/read 工具，并生成带 repository revision、路径、行范围和 provenance 的结构化分析报告。代码修改、命令、测试、diff 和 Git worktree 从 M2 开始实现。

典型调用：

```bash
multiagent run --repo ./example --prompt "定位折扣边界逻辑、调用方和相关测试，并解释潜在错误"
```

目标执行链（与总规划 `TargetArchitecture.md` 第 7.1、7.4 节一致；下图取代原有的三模块直连模型）：

```text
CLI (UserInteraction adapter)
  -> UserInteraction 创建 WorkSession / PromptRevision / UserIntent
  -> Kernel 对 UserIntent 做 M1 最小准入并路由 CreateWorkflow
  -> Workflow 创建运行并从 AgentToolPool 固定 DefinitionVersion
  -> Workflow 产生不可变 UnitIntent
  -> Kernel 准入与路由
       -> ContextEngine 构造 ContextPack
       -> Model/Tool/Workspace Executor 执行受控动作
  -> Kernel 校验 UnitResult 并形成运行事件/RuntimeProjection
  -> Workflow 消费结果，继续 AgentStep 或完成验收
  -> UserInteraction 读取 RuntimeProjection，展示来源化结论、步骤、用量和报告
```

M1 的核心证明是：同一个 Task 必须沿上述权威线路完整经过五个 Module 的既定插槽。Workflow、Kernel、ContextEngine 提供主要运行能力；UserInteraction 和 AgentToolPool 允许采用最小实现，但必须拥有各自数据并真实参与调用链。五个 Module 在一个进程内运行不改变其逻辑边界。

## 3 M1 必须实现的能力

### 3.1 产品能力

1. 单用户、单项目、单进程、单 Agent、单活动 Task。
2. UserInteraction 以最小 CLI adapter 创建单个 WorkSession、不可变 PromptRevision 和 UserIntent，并只展示 Kernel 发布的 RuntimeProjection。
3. AgentToolPool 以只读内置目录提供一个 Agent、Model、Prompt 及允许工具的不可变 DefinitionVersion，运行开始后固定版本与 digest。
4. 接入一个模型 Provider，支持结构化 AnalysisAction。
5. Agent 可以请求文件树、搜索和读取文件；FILE_WRITE、COMMAND、TEST 与其他副作用在 M1 明确 Unsupported。
6. ContextEngine 能生成仓库文件图、执行文本/符号名称搜索、按 token 预算构造 ContextPack。
7. Kernel 能校验用户控制意图及所有 UnitIntent，路由 Context Unit，执行 Model/Tool Unit，并返回结构化结果和最小 RuntimeProjection。
8. Workflow 能控制 Agent 循环、最大步数、预算、终止条件、失败分类和来源完整性验收。
9. M1 对仓库严格只读；任何写入、命令或测试请求均被拒绝，并验证运行前后 repository revision 不变。
10. 最终输出结构化结论、来源、未确认项、步骤、模型调用次数、token/耗时和失败原因。
11. 使用至少 5 个固定小型仓库分析任务建立首版成功率基线。

### 3.2 M1 非目标

M1 不实现：

- Coding Agent、文件写入、命令执行、项目测试、Git diff 和隔离 worktree；
- 多 Task 并行、复杂 DAG 或动态 replan；
- 多 Agent 协作、双 Executor Process 集成和 ChangeSet 合并；
- DBOS、Inbox/Outbox、Lease、fencing 和崩溃后自动续跑；
- WorkflowCheckpoint、SessionCheckpoint 和 RestorePlan；
- 完整 Human Review、多人审批和 Policy Engine；
- Web UI、SSE、多租户、远程 Executor Process、消息集群；
- MCP、语义向量检索、SCIP、reranker；
- 生产级容器隔离、自动 Artifact GC、备份和灾难恢复。

进程崩溃后允许本次运行失败或由用户重新开始。M1 可以保存步骤日志，但不承诺从中间步骤自动恢复。

以上是“能力非目标”，不是“架构边界非目标”。例如 M1 不实现 Web UI、动态目录发布、可靠消息或 PostgreSQL，但仍必须分别通过 UserInteraction、AgentToolPool、Communication 和 Persistence Port；不得让 CLI 直调 Workflow、Workflow 直调 ContextEngine/Provider/文件系统，或用散落常量代替目录契约。

## 4 五个 Module 的职责与 M1 实现深度

五个 Module 是长期稳定的领域边界，不要求把一个简单用户目标人为拆成五个业务任务。同一个 Task 沿固定数据线路由五个 Module 协作完成；“最小实现”只减少功能，不改变所有权或调用方向。

| Module | 长期稳定所有权 | M1 必须落地 | M1 暂不实现 |
|---|---|---|---|
| UserInteraction | WorkSession、SessionTree、InteractionTurn、PromptRevision、用户意图与交互视图 | CLI adapter；单 WorkSession；不可变 PromptRevision；UserIntent；RuntimeProjection 展示 | Web/IDE、复杂 SessionTree、草稿同步、审核工作台 |
| Workflow | WorkflowRun、TaskGraph、Task/Agent 状态、业务推进、验收与恢复语义 | 单 Task 只读分析 loop、预算、终止、来源完整性验收与报告 | Coding、多 Task/DAG、动态 replan、Checkpoint/Restore/补偿 |
| Kernel | 用户控制与 Unit 准入、执行监管、UnitAttempt、审计与 RuntimeProjection | 最小本地身份/策略校验；Context/Model/FILE_READ 路由；workspace/路径准入；写入和命令拒绝；投影 | Coding Tool、Lease/fencing、完整 Policy/HITL、远程调度、生产 Sandbox |
| ContextEngine | RepositorySnapshot、检索、ContextPack、provenance | 文件树、rg、分块、token 裁剪和不可变 ContextPack | 向量/SCIP/reranker、长期记忆和独立索引服务 |
| AgentToolPool | Agent/Tool/Model/Prompt/Contract 的 DefinitionVersion 与兼容关系 | 内置 Analysis Agent、Model、Prompt、tree/search/read Tool；稳定 ID/version/digest；固定运行版本 | Coding Agent/Tool bundle、动态发布、供应链治理、复杂兼容求解、管理 UI |

M1 使用模块化单体：五个 Module 位于同一进程，通过 Port 和共享 Contract 通信，不拆成五个服务，不建立五套数据库，也不引入外部消息总线。模块包、所有权、装配和测试边界必须独立；禁止以“同进程”为由直接导入对方 Repository、Reducer 或内部类。

### 4.1 五项 Infrastructure 的 M1 预留

| Infrastructure | M1 最小实现 | 必须保留的升级插槽 |
|---|---|---|
| Module Host | 单进程 composition root、配置加载、Module/Adapter 注册、启动/关闭顺序和基础 health | 后续 readiness、drain、独立进程或远程 adapter 不改变 Module 构造契约 |
| Shared Contracts | TypeBox/JSON Schema、统一 Envelope/ID/Ref/Error、兼容性与正反 contract tests | Command/Query/Event/Signal/Result 可增加版本，不把领域逻辑塞入公共包 |
| Persistence Platform | run-scoped 文件实现置于 Repository/Persistence Port 后；原子临时写入后 rename | 可替换 PostgreSQL、事务、migration、Journal、Outbox/Inbox；领域层不感知介质 |
| Communication Fabric | 进程内 Router；统一消息 Envelope；明确 Command/Query/Event/Result handler | 可替换可靠异步 transport、去重、重试和消费水位；不得形成第二业务状态机 |
| Artifact Store | 本地内容寻址或 run-scoped store，校验 hash/size/mediaType | 可替换 CAS/S3、ACL、retention 和 GC；领域消息始终只传 ArtifactRef |

五项 Infrastructure 在 M1 都必须有接口、默认 adapter、Module Host 装配位和 fake/contract test。后续实现可以很薄，但不得把 Persistence 写死进 Workflow、把 Router 写死进 CLI，或让 Artifact 大对象直接穿过模块消息。

### 4.2 M1 必须保持的关键线路不变量

1. 所有人类输入固定走 `CLI -> UserInteraction -> Kernel -> Workflow`；CLI 不得直接创建 WorkflowRun。
2. Workflow 对 Context、模型、工具、文件和命令的需求统一表示为 `UnitIntent -> Kernel`；不得直调 ContextEngine 或执行 adapter。
3. Kernel 根据 Unit 类型调用 ContextEngine 或 Model/Tool/Workspace Executor；模型与工具定义来自已固定的 AgentToolPool DefinitionVersion。
4. 执行结果先由 Kernel 校验并形成结构化 UnitResult/Event，再由 Workflow 消费；Executor 不回调 Workflow。
5. 用户可见运行状态固定走 `Workflow/Event + Kernel execution state -> Kernel RuntimeProjection -> UserInteraction`；UserInteraction 不读取其他 Module 内部状态。
6. 跨边界的大对象只传 ArtifactRef。同步同进程协作可以通过公开且运行时校验的 Port；Event、Signal、异步 Command、durable boundary 与跨进程调用必须使用统一 Envelope 和 Communication Port。调用方不得感知具体 transport。

## 5 最小领域模型

即使 M1 只运行一个 Task，也必须保留与总规划一致的交互、业务图、监督和执行身份层级：

```text
WorkSession ── PromptRevision
     └── SessionTreeNode ──> WorkflowRun
                                  ├── TaskGraph @ GraphRevision(0)
                                  │    └── TaskRun ── TaskAttempt ── AgentRun ── AgentStep
                                  └── Root MissionScope
                                       └── supervises TaskAttempt / AgentRun

AgentRun ── emits UnitIntent ──> Kernel ──> UnitAttempt ──> ArtifactRef / Event
```

M1 只创建一个 SessionTreeNode、`GraphRevision = 0` 和一个根 MissionScope，不实现分支、动态 revision 或监督树算法；但这些对象的 ID/Ref 必须从创建时存在。所有 ContextRequest、UnitIntent、UnitResult、Event、日志和 Artifact metadata 必须按适用范围携带 `workSessionId`、`promptRevisionId`、`workflowRunId`、`missionScopeId`、`graphRevision`、Task/Agent/Unit ID 与 correlation/causation，避免 M2–M5 为补身份链而重签主契约。

### 5.1 状态机

```text
WorkflowRun / AgentRun:
CREATED -> RUNNING -> SUCCEEDED
                   -> FAILED
                   -> CANCELLED

AgentStep:
CONTEXT -> MODEL -> ACTION -> OBSERVATION
                         \-> FINAL

UnitAttempt:
PENDING -> RUNNING -> SUCCEEDED
                   -> FAILED
                   -> TIMED_OUT
```

### 5.2 TaskGraph 兼容结构

M1 虽然只允许一个 Task，但输入使用可扩展的图结构：

```ts
interface TaskGraph {
  schemaVersion: "v0";
  tasks: TaskDefinition[];
  edges: TaskEdge[];
}
```

M1 校验器要求 `tasks.length === 1` 且 `edges.length === 0`。M3 通过放宽能力校验支持多个 Task，而不是替换输入模型。

## 6 模块契约

### 6.1 Context Port

```ts
interface ContextPort {
  buildContext(request: ContextRequest): Promise<ContextPack>;
}

interface ContextRequest {
  workflowRunId: string;
  missionScopeId: string;
  graphRevision: number;
  taskRunId: string;
  agentRunId: string;
  workspaceRef: string;
  objective: string;
  query?: string;
  previousObservationRefs: ArtifactRef[];
  tokenBudget: number;
}
```

`ContextPort` 是 Kernel 的 Context Unit adapter，不是 Workflow 的直连依赖。`ContextPack` 必须是不可变输出，至少包含 `contextPackId`、`workspaceRef`、`repositoryRevision`、`items`、`tokenCount` 和 `provenance`。Workflow 只接收 Kernel 校验后的 Context UnitResult/ArtifactRef，不得调用该 Port，也不得读取 ContextEngine 内部缓存或索引。

### 6.2 Kernel Port

```ts
interface KernelPort {
  execute(intent: UnitIntent): Promise<UnitResult>;
}

interface UnitIntent {
  schemaVersion: "v0";
  unitIntentId: string;
  owner: UnitOwner;
  missionScopeId: string;
  graphRevision: number;
  executionKind: "CONTEXT" | "MODEL" | "FILE_READ" | "FILE_WRITE" | "COMMAND" | "TEST";
  definitionVersionRef?: string;
  input: unknown;
  outputContractRef: string;
  workspaceRef: string;
  timeoutMs: number;
  idempotencyKey: string;
}
```

Workflow 不得直接调用 ContextEngine、模型 SDK、文件系统或 shell。M1 的 Port 是进程内调用；M2/M3 可以在不改变调用者语义的前提下替换为 durable 或异步 adapter。

### 6.3 UserInteraction、控制准入与 Catalog Port

M1 至少定义并运行时校验判别联合的 `RunIntent/InspectIntent/ReportIntent/CancelIntent`、`AdmittedCommand`、`RuntimeProjection`、`DefinitionQuery` 和 `DefinitionVersionRef`。每种 Intent 只携带自身操作所需字段；不得让查询或取消伪造 RUN 的 objective、PromptRevision 或 workspace。调用方向固定为：

```text
UserInteraction --UserIntent--> KernelControlPort --AdmittedCommand--> Workflow
Workflow --DefinitionQuery--> AgentToolPool
Kernel --RuntimeProjection--> UserInteraction
```

AgentToolPool 的 M1 内置目录也必须通过 `CatalogPort.resolve(query)` 访问，返回不可变 version/digest 与输入输出 Contract；不得让 Workflow 或 Kernel 从配置常量拼装“隐式定义”。未实现的控制命令或目录查询返回结构化 `UNSUPPORTED_CAPABILITY`。

### 6.4 Envelope、Artifact 与错误

所有异步、durable 或跨进程请求和结果使用以下 Envelope；同步本地 Port 使用相同 payload schema，并携带包含 correlation、causation、tenant/project、运行引用和 deadline 的 `BoundaryContext`：

```ts
interface Envelope<T> {
  schemaName: string;
  schemaVersion: 0;
  messageType: "command" | "query" | "event" | "signal" | "result";
  messageId: string;
  producer: string;
  occurredAt: string;
  tenantId: string;
  projectId: string;
  correlationId: string;
  causationId?: string;
  workSessionId?: string;
  workflowRunId?: string;
  missionScopeId?: string;
  aggregateId?: string;
  aggregateVersion?: number;
  graphRevision?: number;
  traceparent?: string;
  payload: T;
}

interface ArtifactRef {
  artifactId: string;
  mediaType: string;
  sha256: string;
  size: number;
}
```

错误必须结构化为 `VALIDATION`、`CONFLICT`、`POLICY`、`TIMEOUT`、`RESOURCE`、`DEPENDENCY`、`EXECUTION`、`INTEGRITY`、`CONTRACT` 或 `INTERNAL`，并包含 `retryable`、`correlationId` 和可选 `diagnosticsRef/detailsRef`。模块边界不得只传递异常字符串。

Command payload 必须带 `idempotencyKey`，修改既有聚合时带 `expectedVersion`；Query result 必须带 `sourceVersion`。即使 M1 的文件 adapter 不提供完整并发与去重保证，也要接收、校验并记录这些字段，使 PostgreSQL、Inbox/Outbox 和异步 transport 接入时不需要重签调用方协议。

### 6.5 共享协议与对象协议预留表

M1 必须在 `packages/contracts` 建立版本化 Protocol Registry。下表的每个协议族都要有稳定 `schemaName` 前缀、ID/Ref 类型、Port/handler 位置、capability 声明和正反 schema fixture。M1 已使用的协议提供真实或 fake adapter；后续协议提供 Noop/Unsupported handler，返回 `UNSUPPORTED_CAPABILITY`，不得返回假成功，也不得先冻结尚未验证的完整 payload。

| 协议族 | M1 必须定义的公共协议/对象 | M1 行为 | 后续在原位扩展 |
|---|---|---|---|
| `platform.common.*` | `Envelope`、`ModuleError`、`CapabilityDescriptor`、各类 ID/VersionedRef、`ArtifactRef`、`WorkspaceRef`、`Page/Cursor` | 完整校验并贯穿全链路 | 新增可选字段或新 major schema，不改已有含义 |
| `interaction.*` | `WorkSessionRef`、`SessionTreeNodeRef`、`PromptRevisionRef`、`UserIntent`、`InteractionView` | 实现 create/run/inspect 所需最小子集 | Web/IDE、分支、草稿、审核响应在该命名空间增加版本 |
| `workflow.*` | `WorkflowRunRef`、`TaskGraph/GraphRevision`、`MissionScopeRef`、`TaskRun/AttemptRef`、`AgentRun/StepRef`、状态 Event | 实现单图、根 Scope、单 Task | 多 Task/Join/replan/compensation 放宽 capability，不替换对象身份 |
| `kernel.control.*` | `IdentityContext`、`AdmittedCommand`、`RuntimeProjection`、最小 `PolicyDecisionRef` | 本地单用户准入与投影 | OIDC/Policy/HITL/多租户扩展同一控制入口 |
| `kernel.unit.*` | `UnitIntent`、`UnitResult`、`UnitAttemptRef`、`ExecutionPermitRef`、`EffectRecordRef` | Permit/Effect 可为空引用，执行与结果校验真实完成 | Scheduler、Grant、Lease、fencing、retry 扩展现有 attempt 协议 |
| `context.*` | `ContextRequest`、`ContextPackRef`、`ContextItem`、`Provenance`、`IndexRevisionRef` | 路径/rg 检索真实实现；IndexRevision 可为 M1 固定值 | 语义检索、ACL、重建协议追加 adapter/版本 |
| `catalog.*` | `DefinitionQuery`、`DefinitionVersionRef`、`CapabilityRequirement`、`ContractRef` | 内置只读定义与 digest | 动态发布、兼容求解、供应链状态不改变引用方式 |
| `checkpoint.*` / `restore.*` | `WorkflowCheckpointRef`、`SessionCheckpointRef`、`RestoreOperationRef` | 仅注册协议族、owner、opaque Ref、capability 与统一 Unsupported 结果 | M4 根据真实保存/恢复用例首次定义 participant Port 与版本化 payload |
| `review.*` | `HumanReviewRequestRef`、`HumanReviewDecisionRef`、`ReviewResponseRef` | 仅注册协议族、owner、opaque Ref、capability 与统一 Unsupported 结果；高风险动作按当前 policy 拒绝 | M2 加入本地副作用确认；M4 定义持久单人/多人审核协议 |
| `integration.*` | `ChangeSetRef`、`IntegrationPlanRef`、`QualityGateResultRef` | 仅注册 typed Ref、capability 与统一 Unsupported 结果 | M2 引入单任务 diff/test evidence，M3 根据确定性集成用例定义完整 Port |
| `platform.lifecycle.*` | `ModuleManifest`、`ModuleCapabilitySet`、`HealthStatus`、`start/stop/health` | 五个 Module 与 adapter 均实现 | readiness、drain、远程 discovery 与独立部署 |
| `platform.persistence.*` | `RepositoryPort`、`TransactionContext`、`MigrationStatus`、`JournalPositionRef` | 文件 adapter；事务/Journal 能力明确报 unsupported | PostgreSQL、migration、Journal、Outbox/Inbox |
| `platform.communication.*` | `MessageRouterPort`、`DeliveryReceipt`、`ConsumerOffsetRef` | 进程内同步路由；可靠投递能力报 unsupported | 至少一次、去重、重试、DLQ、消费水位 |
| `platform.artifact.*` | `ArtifactStorePort`、`ArtifactRef`、`IntegrityResult`、`RetentionTokenRef` | 本地写/读/hash；retention 能力报 unsupported | CAS/S3、ACL、retention、GC 与恢复验证 |

协议预留遵循四条规则：

1. **预留的是稳定语义槽位，不是随意字段**：不使用 `metadata: any`、`extensions: object` 或大量无语义 optional 字段假装兼容。
2. **Ref 先于完整对象**：M1 未拥有或未实现的对象只跨模块传 opaque、带类型和版本的 Ref；调用方不得据此读取 owner 内部状态。
3. **空实现必须可观察**：Noop 只允许用于 lifecycle 等无业务副作用接口；业务 Command 必须返回结构化 Unsupported，记录 capability、schemaName 和 correlationId。
4. **兼容由测试证明**：Protocol Registry 必须检查 schemaName 唯一、major/minor 规则、producer/consumer fixture、未知 major 拒绝、可选字段前后兼容及 Unsupported handler 行为。

## 7 M1 Agent 循环

```text
1. UserInteraction 创建 WorkSession 与不可变 PromptRevision，向 Kernel 提交 UserIntent。
2. Kernel 完成 M1 最小准入并向 Workflow 路由 Admitted CreateWorkflow；Workflow 创建 WorkflowRun、TaskRun、TaskAttempt 和 AgentRun。
3. Workflow 从 AgentToolPool 固定本次运行的 DefinitionVersionRef。
4. Workflow 生成 CONTEXT UnitIntent；Kernel 准入后调用 ContextEngine，并返回带 ContextPackRef 的 UnitResult。
5. Workflow 生成 MODEL UnitIntent，由 Kernel 按固定定义调用模型。
6. Kernel 校验模型结构化输出并返回 AgentAction UnitResult。
7. Workflow 根据 AnalysisAction：
   - 再生成 CONTEXT UnitIntent 请求补充检索；或
   - 请求 Kernel 读取文件；或
   - 接受带来源的 FINAL 分析提案；
   - 对写入、命令、测试或其他副作用请求返回结构化 Unsupported。
8. Kernel 校验每个执行结果并形成 UnitResult/Event；Workflow 将 Observation 追加到 AgentRun，进入下一 AgentStep。
9. 达到成功、失败、取消、步数或预算上限后终止。
10. Workflow 验证关键结论均有 repository revision、path/line 与 provenance，生成最终 AnalysisReport；Kernel 汇总 RuntimeProjection，UserInteraction 向用户展示。
```

模型不能直接执行工具。模型输出只是提案，必须经过 Workflow 解释和 Kernel 准入。

## 8 执行与安全边界

M1 不运行项目 subprocess；Executor 只提供受限 FILE_READ。后续里程碑引入 subprocess 或容器时不得复用 M1 只读准入假定。M1 至少必须实现：

- workspace 固定为已授权仓库的只读 revision，运行前后验证 revision 与文件内容未改变；
- 拒绝绝对路径、`..`、symlink/junction 逃逸；
- FILE_WRITE、COMMAND、TEST、网络与所有外部副作用默认拒绝；
- 单次读取超时和输出大小上限；
- 默认禁止外部网络和用户目录访问；
- 最大 AgentStep、模型调用数和 token 预算；
- 不修改、commit、push、merge、部署或发送外部消息；
- 所有模型调用和工具执行生成审计步骤记录。

## 9 工程框架

建议 M1 包结构：

```text
apps/control-plane/         可执行 composition entry、配置与 adapter 选择
apps/cli/                   UserInteraction 的 CLI adapter，不直接调用 Workflow
apps/executor/              Kernel 管辖的只读执行 adapter；M2 才引入受控 subprocess
packages/contracts/         Envelope、Task、Context、Unit、Artifact、Error schema
packages/user-interaction/  WorkSession、PromptRevision、UserIntent、CLI view model
packages/workflow/          Run/Task/Agent 状态机、Agent loop、验收和报告
packages/kernel/            控制/Unit 准入、路由、RuntimeProjection、workspace 与 subprocess
packages/context-engine/    repository snapshot、rg、chunk、token budget
packages/agent-tool-pool/   AgentToolPool；内置 DefinitionVersion 与 CatalogPort
packages/module-host/       Module 注册表、生命周期、启动顺序、health/drain Port
packages/persistence/       Repository/Persistence Port 与 M1 文件 adapter
packages/communication/     Communication Port 与进程内 Router
packages/artifacts/         本地内容寻址或 run-scoped Artifact
packages/testing/           fakes、contract tests、fixture repositories
```

依赖方向固定为：五个领域 Module 只依赖 `contracts` 和自己声明/消费的 Port；`packages/module-host` 提供 Module 注册与生命周期机制，`apps/control-plane` 是唯一最终 composition root，只负责选择具体 Module/Adapter 并调用 Module Host；`apps/cli` 只依赖 UserInteraction 的公开入口；`apps/executor` 只实现 Shared Contracts 中的执行协议，不依赖 Kernel 内部实现。Workflow 不得导入 Kernel、ContextEngine 或 AgentToolPool 的内部类；UserInteraction 不得导入 Workflow 内部类。M1 可将 `packages/module-host`、`packages/persistence` 和 `packages/communication` 保持为小包，但这些包名、Port 与依赖方向属于验收项。

M1 的精确 Node.js、pnpm、TypeScript、测试工具及各 workspace 第三方依赖由 `docs/Requirements/M1DependencyBaseline.md` 统一规定。直接外部依赖必须固定精确版本，内部 package 使用 `workspace:*`；长期技术栈中的 PostgreSQL、DBOS、Kysely、Fastify、MCP、容器和可观测性依赖不得在对应里程碑前进入当前 manifests。

M1 可以先将运行记录保存在 `.multiagent/runs/<run-id>/`，包括 `run.json`、`steps.jsonl`、`artifacts/` 和 `report.json`。M1 不生成 patch；M2 再将 Repository Port 替换为 PostgreSQL 实现并引入代码变更 Artifact。

## 10 如何保证兼容后续升级

兼容目标不是保证未来零修改，而是让新增能力通过替换 adapter、放宽能力限制或增加版本完成，避免推翻 M1 主循环。

### 10.1 兼容规则

1. **模块化单体**：先保留代码和所有权边界，不提前服务化。
2. **Contract-first**：跨模块只使用 `packages/contracts` 中的运行时校验对象。
3. **稳定身份层级**：从 M1 起保留 run/task/attempt/agent/step/unit ID。
4. **不可变输出**：ContextPack、UnitIntent、UnitResult 和 Artifact 发布后不原地修改。
5. **Port/Adapter**：模型、工具、存储、检索和执行器都通过 Port 替换。
6. **能力协商**：M1 用 capability validator 拒绝多任务，而不是删除图字段。
7. **版本化 schema**：破坏性变化创建新 schemaVersion 和显式迁移，不静默改变含义。
8. **结构化错误**：未来 retry、审批和恢复依据错误类别，而不是解析日志文本。
9. **Contract tests**：每个 Port 同时提供 fake 和共享测试套件，所有 adapter 必须通过。
10. **真实任务验证后冻结**：M1 完成前允许修正抽象，避免把未经验证的设计永久化。
11. **完整插槽、渐进实现**：五个 Module 与五项 Infrastructure 都先形成可编译边界；未实现功能通过 capability/unsupported 结果表达，不通过删包或跨层直调表达。
12. **关键线路不漂移**：后续只在 UserInteraction、Kernel、Workflow、执行面和投影之间增加持久化、异步、审批或恢复步骤，不改变入口、准入、结果回流和展示的方向。

### 10.2 后续能力如何接入

| 后续能力 | 基于 M1 的扩展方式 |
|---|---|
| PostgreSQL | 替换 RunRepository/Artifact metadata adapter |
| DBOS | 包装 Workflow loop；外部动作仍保持 UnitIntent 边界 |
| 多 Task | 放宽 TaskGraph validator，增加 readiness 和 Join |
| 多 Agent | 一个或多个 TaskAttempt 创建多个 AgentRun |
| retry/cancel | 创建新的 Attempt，并扩展现有状态机 |
| 消息队列 | 将本地 Port adapter 换成异步 transport，复用 Envelope |
| 容器/远程执行 | 替换 Kernel Executor adapter |
| 语义检索 | 替换 ContextEngine retrieval pipeline，保持 ContextPack |
| 审批 | 在 Kernel 执行 UnitIntent 前插入 Review Gate |
| Checkpoint | 保存既有状态与 Artifact 引用，不发明第二套运行对象 |
| Web/IDE 入口 | 增加 UserInteraction adapter，不绕过 UserIntent 与 KernelControlPort |
| 动态 Agent/Tool 目录 | 替换 AgentToolPool 内置 catalog adapter，保持 DefinitionVersionRef |
| 可靠通信 | 替换进程内 Router，保持 Envelope 与 handler Contract |

## 11 M1 验收

### 11.1 固定任务类型

至少包含以下只读分析任务，不能在问题中直接给出答案文件名来绕过 ContextEngine：

1. 根据业务描述，在未知文件中定位实现、调用方和相关测试。
2. 跨两个以上文件解释接口调用约定和数据流。
3. 为一个拟议小功能识别需要修改的实现、测试和配置位置，但不执行修改。
4. 面对无关搜索结果，重新查询并找到正确实现与来源证据。
5. 首次证据不足时读取 Observation、再次检索并形成可复验结论。

### 11.2 完成定义

M1 完成必须同时满足：

1. 五个固定任务都必须到达可解释的成功或结构化失败终态；至少一个真实模型在全部固定任务上运行并记录成功率、来源完整性、步骤、token、成本和延迟基线。
2. 每个任务完整经过 `UserInteraction -> Kernel -> Workflow`，并由 Workflow 通过 Kernel 的 Unit 路径使用 ContextEngine 与执行器；DefinitionVersion 来自 AgentToolPool。
3. Workflow 可限制步数、token 和时间，并能确定成功或失败。
4. ContextPack 具有来源、repository revision 和 token 统计。
5. 所有模型与只读工具调用通过 Kernel Unit 执行；任何副作用请求确定性拒绝。
6. 仓库不被修改，最终结果以 AnalysisReport 与来源证据交付。
7. 五个 Module 均有独立包/目录、公开 Port、fake 或最小 adapter 与 contract test；Workflow、Kernel、ContextEngine 另有至少一个集成测试。
8. 报告包含结论、来源、未确认项、步骤、工具调用、模型用量、耗时和失败分类。
9. Module Host、Shared Contracts、Persistence、Communication 与 Artifact Store 均有默认 adapter、装配位和替换测试；领域模块不感知具体存储或 transport。
10. 架构测试能阻止 CLI 直调 Workflow、Workflow 直调 ContextEngine/Provider/文件系统，以及 UserInteraction 读取领域内部状态。
11. 写入、命令、测试、网络和 workspace 逃逸成功次数为零；任何成功报告中的无来源关键结论为零。

## 12 后续里程碑

### M2：安全的单 Coding Agent、持久化与基础可靠性

- M2-A：在一次性隔离 Git worktree 中加入 FILE_WRITE、COMMAND、TEST、diff、资源/网络限制与副作用前本地用户确认。
- M2-B：PostgreSQL Repository、migration、领域事务与 Journal/Outbox/Inbox。
- M2-C：DBOS 包装 Agent/Workflow loop，加入幂等命令、有限 retry、cancel、进程重启恢复与未知副作用 reconciliation。
- M2-D：最小 API、投影重建、备份恢复和故障注入；各子阶段必须以前一阶段验收通过为入口。
- 最小 Inbox/Outbox 或经 ADR 证明的 DBOS 原生替代方案。
- Artifact CAS、运行审计和故障注入。
- 明确 DBOS retry、Kernel retry 和 Workflow retry 的唯一责任。

### M3：多任务与并行执行

- 静态 TaskGraph、多 Task、依赖和 `ALL` Join。
- 多 Executor Process/AgentRun 调度和并发上限。
- Lease、heartbeat、fencing 和迟到结果处理。
- 每个 Executor Process 使用独立 worktree。
- ChangeSet、确定性 IntegrationPlan、干净集成 workspace 和 QualityGate。
- 单 Agent 与多 Agent 的质量、成本、延迟和冲突基线。

### M4：长期恢复、安全与人类控制

- WorkflowCheckpoint 与用户可见 SessionCheckpoint。
- RestorePlan、跨模块恢复参与者和长期 Artifact retention。
- 把 M2 的本地副作用确认升级为可持久等待、可失效和可审计的单人 APPROVAL，再按需求扩展 INFORMATION/DECISION/ACCEPTANCE。
- 把 M2 的最小隔离升级为 rootless container 或远程 Sandbox，并加入正式网络策略和 Secret 管理。
- OpenTelemetry、正式安全测试、备份恢复和性能基线。

### M5：平台化与生产能力

- 多租户、OIDC/RLS、配额、公平性和成本治理。
- 远程 Executor Process、多 Control Plane 和独立消息基础设施。
- S3-compatible Artifact Store、完整 GC、PITR 和灾难恢复。
- Web UI、SSE、组织级审核、供应链和发布治理。
- 根据实测数据评估 Restate/Temporal、NATS、gVisor 或 microVM。

每个里程碑必须以前一里程碑的固定任务集和回归测试为基础。不得为实现后续平台能力破坏 M1 的单 Agent 基本闭环。
