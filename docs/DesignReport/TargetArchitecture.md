# MultiAgentOS 目标架构报告

> 文档类型：长期目标架构与演进约束  
> 文档状态：目标设计，不直接构成当前版本完成定义  
> 适用范围：V1.1、Beta 与 Production 演进  
> 技术栈约束：`docs/TechStack.md`  
> 当前实现规范：`docs/DesignReport/TargetM1.md`  
> 首月计划：`docs/DesignReport/M1AchievePlan.md`  
> 配套详细设计：`docs/DesignReport/WorkflowModuleReport.md`

> 权威说明：本文保存系统长期目标、完整领域边界和演进约束。本文未被当前文档明确引用的能力不得作为发布阻断项。

## 0 迁移说明与阶段解释

本文由原总体设计完整迁移而来，以避免在缩减 V1 时丢失已经形成的长期设计。正文中仍出现的“V1 范围”“V1 验收”“Phase 1–5”等表述代表原始全量方案的历史分期，不再定义当前 V1，也不得直接生成当前迭代任务。

当前阶段映射固定如下：

| 本文内容 | 当前解释 |
|---|---|
| 单 Agent loop、受控 Model/Tool Unit、路径检索、隔离 worktree | 只有被 `TargetM1.md` 明确收录的子集属于当前 M1/V1 |
| PostgreSQL、DBOS、静态多任务图、多 Worker、Lease/fencing | M2/M3 候选，由前一里程碑结果决定是否纳入 |
| 跨 Module SessionCheckpoint、RestoreParticipant、完整数据库 role 隔离、单人 APPROVAL | M4 及后续候选 |
| 动态 replan、四类 HITL、多人员审核、语义检索、远程 Worker、多租户 | V1.1/Beta/Production 目标 |
| 本文第 19、20 章原实施计划和验收标准 | 历史设计参考，已由 `TargetM1.md` 与 `M1AchievePlan.md` 取代 |

对当前开发作出范围判断时，必须先阅读 `TargetM1.md`；对首月排期作出判断时，必须阅读 `M1AchievePlan.md`。

## 1 文档目的与规范约定

本文定义 Paralleling AgentOS 的系统边界、领域划分、权威状态、跨模块契约、可靠执行机制、安全模型、数据与部署架构、验证方法和实施顺序。后续实现、接口评审、数据建模、测试设计和架构变更必须以本文为总体蓝本；
各组件将分别拥有模组设计文档，如WorkflowModuleReport.md，但均应基于本文档设计，不得冲突。
如组件设计文档设计过程 出现冲突且需修改项目设计，也应先修改本文档，再让组件设计文档与本文档一致。

本文使用以下规范词：

- **必须**：实现和测试不可省略的约束。
- **不得**：实现中禁止出现的行为或依赖。
- **应**：默认必须执行；只有形成架构决策记录并说明替代保障时方可偏离。
- **可**：不影响兼容性的可选能力。

架构图和示例只用于解释规范，字段表、状态机、不变量与验收标准具有约束力。所有时间使用 UTC 存储并采用 RFC 3339 表达；所有 ID 使用不可推测、全局唯一的字符串标识；所有跨边界数据在入口与出口均执行运行时校验。

## 2 系统目标与范围

### 2.1 系统目标

AgentOS 面向持续数分钟至数天的软件工程和通用知识工作，将用户目标转化为可验证的 TaskGraph，在多个 Agent、确定性执行器和隔离工作区之间并行推进。系统必须做到：

1. 将不确定的模型行为约束在可控制、可恢复、可审计的执行闭环中。
2. 使每个模型、工具、文件、网络或数据库操作均可追溯到目标、监督范围、身份、权限、资源租约、图版本和因果链。
3. 使用明确的任务依赖、输入输出契约与验收条件组织并行工作，避免产生无主结果。
4. 在进程崩溃、消息重复、网络分区、Worker 失联和迟到结果出现时保持领域状态一致。
5. 支持用户以 WorkSession 为入口检查运行、暂停、恢复、取消、审批、重新规划、从长期保存点派生运行和生成报告。
6. 以结构化结果、不可变 Artifact、代码差异、测试证据、用量成本、权限决策和未解决问题作为最终交付的一部分。

### 2.2 V1 范围

V1 只交付一个可测、可恢复的本地 coding-agent 纵向闭环：

- 单用户、单项目、单 Control Plane 进程；以 CLI 为主要入口，HTTP API 只提供 CLI 需要的最小命令和查询集。
- 创建 WorkflowRun，接收经 schema 校验的静态 TaskGraph 定义；V1 只支持 required Task 和 `ALL` Join，不使用模型自动规划或动态改图。
- 先完成单确定性 Worker 纵向闭环，再支持最多两个无显式路径冲突的脚本化 Worker 在独立 workspace 中并行执行。Worker 使用固定 fixture 或受控命令产生可预期的文件变更，用于验证编排而非 Agent 智能。
- Worker 只交付结构化结果、patch/commit Artifact 和测试证据；Workflow 内的 Integration Coordinator 在干净集成 workspace 中按确定顺序应用变更、检测冲突并运行质量门。
- 命令、文件写入和 workspace 操作均通过 Kernel Unit 准入；V1 实现本地路径白名单、资源/运行时间上限和高风险命令的单人 `APPROVAL`。
- PostgreSQL 是领域事实源，DBOS 只恢复持久控制流；实现 transactional outbox、Inbox 去重和最小 Lease/fencing，验证进程崩溃后不会重复提交结果。
- 支持有限次数的 retry、cancel、崩溃后 resume，以及用户显式创建的简化 SessionCheckpoint；从 SessionCheckpoint 恢复默认创建新 WorkflowRun 和新 DBOS execution。
- Context 仅支持基于路径、`ripgrep` 和明确 ArtifactRef 的按需装配；不在 V1 建设 embedding、reranker、SCIP 或独立索引服务。
- 生成最终 diff/patch、测试报告、失败原因和耗时报告，并用固定 fixture 验证单 Worker、双 Worker、冲突、崩溃恢复和重复消息场景。

V1.1 在不改变上述 Task、Unit、ChangeSet、IntegrationPlan 和 RestorePlan 契约的前提下，接入单模型 Provider、Bootstrap Planner 和真实 coding Agent，再建立单 Agent 与双 Agent 的质量/token/成本/延迟基线。

### 2.3 非目标

V1 不建设 Web UI、多租户、OIDC/RLS、多人审核、职责分离、`ANY`/`QUORUM`/自定义 Join、动态扩图、运行中局部 replan、自动 SessionCheckpoint 轮换、物理 Artifact GC、完整补偿引擎、通用 Kubernetes 调度器、独立消息集群、向量数据库、跨组织 A2A 或自研 durable workflow engine。这些能力保留为 Beta/Production 演进目标。V1 仍不把模型推理视为可信事实，不允许 Agent 自行扩大权限，不宣称任意外部副作用具备 exactly-once 语义。

## 3 设计原则与关键不变量

### 3.1 设计原则

1. **单一权威**：每类领域状态只有一个写入所有者，各模组权限分离且明确。
2. **意图与执行分离**：Workflow 描述要做什么，Kernel 决定能否、何时、何地及以何种资源执行。
3. **事实驱动推进**：上层状态只消费已提交的下层 Event，不接受 Executor 直接跨层回调。
4. **持久编排与业务图分层**：DBOS 恢复控制流；AgentOS TaskGraph 表达业务依赖，两者不得形成双重任务状态机。
5. **不可变引用优先**：图版本、定义版本、Unit、WorkflowCheckpoint、SessionCheckpoint 和 Artifact 均以不可变版本或内容引用参与执行；DBOS Checkpoint 由 runtime 管理。
6. **至少一次传递下的幂等**：重复消息、重放和迟到结果是正常输入，必须通过 Inbox、版本和 fencing 处理。
7. **最小权限与执行时重验**：目录声明不是授权；所有副作用在发生前重新校验 Grant、Lease、revision、预算和 deadline。
8. **派生数据可重建**：状态投影、索引、缓存和遥测均能从事实源恢复，且不得反向覆盖事实源。

### 3.2 系统级不变量

- Workflow 是 WorkflowRun、TaskGraph、MissionScope、TaskRun、TaskAttempt、三级CheckPoint 和 AgentRun 业务状态的唯一写入者。状态保存与回滚的执行者。
- Kernel 是身份绑定、PolicyDecision、HumanReviewRequest/Decision、CapabilityGrant、资源配额、Lease、fencing、ExecutionPermit、UnitAttempt 准入与运行监管的唯一权威。
- ContextEngine 是 ContextRecord、IndexRevision、RetrievalResult 和 ContextPack 的唯一写入者。
- AgentToolPool 是版本化 Agent、Tool、Model、Prompt 与 Contract 定义的唯一写入者，但不得保存活跃运行、真实凭据或授权结论。
- UserInteraction 是 WorkSession、SessionTree、InteractionTurn、PromptRevision、用户草稿与交互偏好的唯一写入者；唯一与用户直接交互模组；它不得拥有执行状态或恢复快照。
- DBOS 是 Workflow 控制流的恢复所有者；模型、工具、文件、网络、Context 和外部数据库副作用不得在可重放 step 内直接执行。
- 未持有当前 revision、有效 Grant、有效 Lease 和最新 fencing token 的 Attempt 不得产生副作用或提交当前结果。
- 领域投影、Event Journal 和 Outbox 必须在同一数据库事务提交。
- 跨模块不得直接写入对方 schema；跨模块协作只能使用 Command、Query、Event、Signal 和 ArtifactRef。
- 最终完成前必须满足必需 Task 与 Join、关闭有效 Lease、处理必需 Signal、提交所需 Artifact、回收 Grant，并记录或补偿副作用。

## 4 逻辑架构

### 4.1 架构分层

```text
Web UI / CLI / IDE Adapter
             |
| UserInteraction | 交互、WorkSession 与用户意图 |
             |
| Kernel          | 控制准入、运行监视与命令路由 |
             |
+-----------------+------------------+----------------+
| Workflow        | ContextEngine    | AgentToolPool  |
| 业务图、监督与恢复| 上下文与检索      | 静态定义目录    |
+-----------------+------------------+----------------+
             |
Module Host · Shared Contracts · Persistence Platform
Communication Fabric · Artifact Store
             |
PostgreSQL · DBOS · Local CAS/S3 · LiteLLM · MCP
Git worktree · rootless Docker/Podman · OpenTelemetry
```

五个一级 Module 在领域权威上并列，但调用路径具有明确约束：所有人类用户操作先进入 UserInteraction，所有改变运行状态的意图再由 Kernel 完成身份、权限、版本与策略准入，最终由拥有目标状态的 Module 执行；任何外部副作用仍由 Kernel 统一准入。五项 Infrastructure 只提供领域中立能力，不解释 WorkSession、Task、MissionScope、Policy 或检索业务语义。

### 4.2 一级模块职责总览

| 模块 | 负责 | 权威对象 | 明确不负责 |
|---|---|---|---|
| UserInteraction | Web/CLI/IDE 交互、WorkSession 生命周期、SessionTree 与 PromptRevision、用户意图规范化、运行状态可视化、人类审核工作台、交互草稿与用户偏好 | WorkSession、SessionTree 节点关系、InteractionTurn、PromptRevision、InteractionViewState、用户提交的 ReviewResponse | WorkflowCheckpoint/SessionCheckpoint 状态、Agent/资源直接修改、审批权威结论、执行调度、业务恢复 |
| Workflow | 目标分解、TaskGraph、MissionScope、TaskAttempt、AgentRun、代码变更集成与结果验收、恢复计划、重新规划和补偿编排 | WorkflowRun、GraphRevision、TaskRun、TaskAttempt、MissionScope、AgentRun、AgentResult、IntegrationAttempt、RestoreOperation、WorkflowCheckpoint、SessionCheckpoint | 身份认证、授权、资源分配、物理执行、检索实现、交互界面 |
| ContextEngine | ContextPack 装配、记忆、代码和文档检索、索引、来源与版本过滤、token 预算、上下文生成 | ContextRecord、IndexRevision、RetrievalResult、ContextPack | Task 状态、权限签发、通用工具目录 |
| Kernel | 身份、策略、人类审核准入与裁决、Secret、用户控制命令准入与路由、全局运行投影、资源、Scheduler、Lease、执行器、Sandbox、模型与工具连接、运行监管 | PolicyDecision、HumanReviewRequest、HumanReviewDecision、Grant、Lease、UnitAttempt、ExecutionPermit、AuditRecord、RuntimeProjection | WorkSession 内容、任务业务依赖、WorkflowCheckpoint/SessionCheckpoint 内容、Agent 规划、目录定义 |
| AgentToolPool | Agent、Tool、Model、Prompt、Contract 的静态定义、版本与兼容关系 | Definition、DefinitionVersion、CapabilityRequirement | 实际执行、运行实例、凭据、动态配额、授权结论 |

### 4.3 一级模块职责与权限边界

五个一级 Module 按领域对象而非技术调用层划分权威。每个 Module 只能修改自身拥有的状态；跨模块协作必须通过公开契约完成。职责矩阵用于快速确定所有权，以下分节进一步规定各 Module 的写入权限、调用边界和禁止行为。

#### 4.3.1 UserInteraction

UserInteraction 是所有人类用户与 AgentOS 交互的唯一产品边界。Web UI、CLI 与未来 IDE Adapter 都是该模块的适配器，而不是绕过模块边界直接调用 Workflow 或数据库的独立控制面。它负责把用户行为转换为版本化、可审计的 `UserIntent`，并把 Kernel 汇总和脱敏后的 RuntimeProjection、SessionCheckpoint 摘要及 Query 结果组合为用户视图；运行监视数据不得绕过 Kernel 获取。

UserInteraction 必须支持以下能力：

1. 创建、命名、归档和选择 WorkSession；查看 SessionTree、WorkflowRun 分支、PromptRevision 与 SessionCheckpoint。
2. 提交初始 Prompt、补充上下文、审批答复和新的 PromptRevision；原始版本不得被覆盖。
3. 查看任务图、MissionScope 树、运行状态、阻塞原因、成本、审批、Artifact、错误和恢复可用性。
4. 请求 pause、resume、cancel、replan、retry、rerun、fork、从 SessionCheckpoint 恢复、创建/固定/删除 SessionCheckpoint。
5. 在本地或服务端持久化不影响执行的草稿、筛选、布局和显示偏好。
6. 提供统一的人类审核工作台，展示待审核队列、风险等级、规范化参数、影响范围、diff/预览、证据、成本、替代方案、回滚方式、有效期和所需审查者角色。
7. 收集 approve、reject、request-changes、provide-information 和 accept-result 等 ReviewResponse，并支持审批理由、限制条件、再次认证与多人审核进度。

其权限边界必须满足：

- UserInteraction 只能表达用户意图，不得直接改变 WorkflowRun、Task、MissionScope、AgentRun、UnitAttempt、Lease、Grant、资源配额、WorkflowCheckpoint 或 SessionCheckpoint 内容。
- 所有控制意图必须携带 IdentityContext、WorkSession、目标对象、expectedVersion、幂等键和原因，经 Kernel 进行认证、授权、策略、状态与版本检查后，才可转发给 Workflow。
- UserInteraction 只展示 Kernel 发布的规范化 RuntimeProjection；不得通过轮询 Worker、读取进程内存或直读其他 Module schema 拼接“真实状态”。
- 用户不得直接创建、销毁或重配置 Agent、Worker、Lease、Sandbox、模型配额和底层资源。用户只能选择系统公开的策略选项，并由 Kernel 决定是否准入。
- SessionCheckpoint 的创建、读取恢复、固定与删除均是对 Workflow 的命令。UserInteraction 只维护其在 SessionTree 中的展示关系、用户标签和选中状态。
- UI 断线、进程关闭或用户退出不得改变 Workflow 生命周期；重连后依据事件游标和 Query 重建视图。
- UserInteraction 只拥有用户原始 ReviewResponse，不得自行创建权威 HumanReviewDecision、改变审核状态、解除 Workflow 等待、签发 Grant/ExecutionPermit，或在请求参数变化后沿用旧决定。
- 审核页面只能展示 Kernel 发布的脱敏 ReviewProjection 和经 ContextEngine ACL 过滤的 Evidence；不得为方便审核而扩大审查者的数据权限。

#### 4.3.2 Workflow

Workflow 是目标分解、业务图推进和业务恢复语义的唯一权威。它接收 Kernel 已准入的 Command、Signal 和 UnitAttempt Event，将用户目标固化为 WorkflowRun、MissionScope Tree 与版本化 TaskGraph，并在已提交事实基础上创建 TaskAttempt、AgentRun、GraphPatch、WorkflowCheckpoint 和 SessionCheckpoint。

Workflow 必须负责：

1. 维护 TaskGraph、GraphRevision、TaskRun/TaskAttempt、MissionScope、AgentRun 与结果验收状态。
2. 根据依赖、Join、输入 Contract、revision barrier 和 MissionScope 状态决定业务可执行性。
3. 生成不可变 UnitIntent，请求 Kernel 执行模型、工具、Context、文件、网络、数据库或 Sandbox 操作。
4. 解释 pause、resume、cancel、retry、rerun、fork、restore 和 compensation 的业务语义。
5. 创建一致的 WorkflowCheckpoint 和自包含的 SessionCheckpoint，并验证恢复兼容性。
6. 在需要人工许可、补充信息、方案选择或结果验收时持久化等待点，并依据 Kernel 发布的 HumanReviewDecision 继续、重新规划、补偿或终止业务流程。
7. 将 Worker 交付的 patch/commit Artifact 组织为确定性 IntegrationPlan，通过 Kernel Unit 在干净集成 workspace 中应用、验证和生成 IntegratedRevision。
8. 解释 checkpoint 恢复语义，生成跨模块 RestorePlan，等待各权威 Module 返回验证、重建或物化结果；不直接修改其他 Module 的状态。

Workflow 不得认证用户、签发 Grant/Lease、分配物理资源、直接执行 Unit、读取 Secret 值、直接访问其他 Module 的领域表，或将 DBOS 状态当作业务事实源。

#### 4.3.3 Kernel

Kernel 是所有控制命令和外部副作用的准入边界，也是执行期身份、策略、资源、租约与审计的唯一权威。它位于用户控制路径和 Unit 执行路径上，但不得替代 Workflow 决定任务依赖、结果验收或恢复点内容。

Kernel 必须负责：

1. 建立 IdentityContext，校验 tenant/project、Policy、HumanReviewDecision、expectedVersion、预算和幂等键。
2. 将已准入的用户控制命令路由给拥有目标状态的 Module。
3. 对 UnitIntent 进行能力、数据范围、Secret、workspace、revision 和资源准入，签发短期 Grant、Lease、fencing token 与 ExecutionPermit。
4. 调度 Executor，监管 Sandbox、模型、MCP、Context 和其他受控执行，并验证返回结果。
5. 汇总领域事件与运行状态，发布脱敏 RuntimeProjection、审计记录和执行指标。
6. 根据风险与 Policy 创建 HumanReviewRequest，验证审查者身份、角色、职责分离、参数绑定和有效期，将 ReviewResponse 裁决为不可变 HumanReviewDecision，并在批准后签发最小权限的短期 Grant。
7. 对 RestorePlan 整体命令和每个需要真实资源的 RestoreAction 重新执行身份、Policy、预算、数据范围和副作用准入；调度 workspace、Artifact、Context 和 reconciliation 操作并返回规范化 Event。

Kernel 不得创建或改写 TaskGraph、MissionScope、WorkflowCheckpoint、SessionCheckpoint、WorkSession、PromptRevision 或 DefinitionVersion，也不得把物理终止直接解释为业务取消成功。

#### 4.3.4 ContextEngine

ContextEngine 是上下文记录、索引版本、检索结果和 ContextPack 的唯一权威。它根据 Kernel 授权的 Context Unit，在 MissionScope、GraphRevision、ACL、来源版本和 token 预算约束内获取、过滤、排序和压缩上下文。

ContextEngine 必须负责来源追踪、索引构建与失效、混合检索、权限与 revision 再过滤、token 裁剪以及 ContextPack 的不可变发布。人类审核需要证据时，它只能在审查者 ACL 和 ReviewRequest 数据范围内生成 EvidenceRef 或摘要。它只能通过 Query、Event 和 ArtifactRef 获取业务引用，不得写入 Workflow 状态、扩大数据可见范围、签发权限、维护通用工具目录，或将可重建索引作为系统事实源。

恢复时 ContextEngine 不回滚全局索引。它必须提供版本化验证/重建接口，对 RestoreAction 返回 `REUSED`、`REBUILT`、`STALE`或 `INCOMPATIBLE` 及来源证据；新运行的 ContextPack 仍必须按当前 ACL、revision 和 token 预算重新过滤。

#### 4.3.5 AgentToolPool

AgentToolPool 是 Agent、Tool、Model、Prompt 和 Contract 静态定义及其兼容关系的唯一权威。它向规划和准入流程提供不可变 DefinitionVersion、能力要求、风险分类、输入输出 schema、供应链状态和运行环境约束。

AgentToolPool 必须保证定义发布后不可变、版本可追溯、兼容性可查询，并支持按 CapabilityRequirement 和 Contract 筛选候选组合。DefinitionVersion 必须声明 riskClass、是否默认需要人工审核、参数变化的失效规则、是否支持 dry-run/回滚、最少审核人数和职责分离要求；这些声明只构成 Policy 输入，不构成批准。它不得保存 MissionScope 或其他运行实例，不得持有真实 Secret、动态预算、Grant、Lease 或授权结论，也不得直接调用已登记的模型和工具。

恢复时 AgentToolPool 必须能按 digest 解析历史 DefinitionVersion，返回兼容性和当前安全状态。定义内容保持不可变，但可另行标记 `ACTIVE`、`DEPRECATED`、`QUARANTINED` 或 `REVOKED`；已撤销定义不得因 checkpoint 引用而继续执行。

### 4.4 基础设施职责矩阵

| 基础设施 | 职责 | 权威范围 | 禁止承载 |
|---|---|---|---|
| Module Host | 组装 Module 与 Adapter，管理进程生命周期 | 进程启动状态、配置加载结果、健康与关闭协调 | 业务调度、权限裁决、任务状态 |
| Shared Contracts | 定义跨边界可验证、可版本化的数据协议 | schema 名称、版本、兼容规则和规范化编码 | Reducer、Policy 结论、调度或检索算法 |
| Persistence Platform | 向各 Module 提供受控事务、migration、Journal、Outbox/Inbox 和备份基础 | 事务提交结果、migration 版本、投递水位和备份状态 | 领域决策、跨 Module 隐式写入、用基础表代替领域事实 |
| Communication Fabric | 传递 Command、Event、Signal 和 Result，提供去重、重试和消费水位 | 消息投递/确认事实与 consumer offset | 解释领域语义、自行改变聚合状态、与 DBOS 形成第二任务状态机 |
| Artifact Store | 存储不可变大对象并提供完整性、引用和生命周期原语 | 对象字节、内容 hash、存储可用性和 GC 执行记录 | 自行决定领域保留、租户授权或恢复语义 |


#### 4.4.1 Module Host

Module Host 是进程组装根，负责配置解析、依赖注入、Module/Adapter 注册、启动顺序、liveness/readiness 和优雅关闭。它可以决定某个 Adapter 是否就绪，但不得决定 Task 是否 READY、Unit 是否允许执行或恢复是否业务成功。关闭时它只调用各 Module 公开的 drain/checkpoint 端口，不直接修改领域表。

#### 4.4.2 Shared Contracts

Shared Contracts 是跨进程和跨 Module 数据形状的唯一公共定义位置，提供 Envelope、核心 ID/Ref、Command/Event/Signal/Result、Error、ArtifactRef、RestorePlan 和 IntegrationResult 的 JSON Schema 及兼容测试。它拥有 schema 名称、版本号和 canonical encoding 规则，但不拥有任何运行状态。具体 Module 拥有自己的 payload schema；公共包不得反向依赖领域实现。

#### 4.4.3 Persistence Platform

Persistence Platform 提供数据库连接、事务、schema/role 隔离、migration lock、Event Journal、Outbox/Inbox、投影水位、备份与 PITR 原语。每个 Module 只能通过自己的 Repository 和受控 platform port 修改状态。平台可报告事务、投递和备份事实，但不解释 WorkflowRun、Review 或 ContextPack 语义。

DBOS datasource transaction 与 Module 领域事务的原子关系必须通过专用 adapter 明确实现和故障注入验证；不得假设两个独立连接或 role 的提交天然原子。若某个 durable step 的领域提交与 DBOS checkpoint 不能同事务，该 step 必须使用稳定幂等键并在重放时读取已提交结果。

#### 4.4.4 Communication Fabric

Communication Fabric 只承担可靠传递：进程内 Router 处理同进程路由，transactional outbox 保证领域提交后最终发布，Inbox 与 consumer checkpoint 保证幂等消费，dead-letter 保留无法处理的消息。领域事实的跨 Module 传递只走这一条规范路径。DBOS Queue 只用于 durable workflow 唤醒或后台作业，不作为第二领域 Event Bus，不决定 Task 状态。

Fabric 不提供全局 exactly-once；producer 必须提供 message/idempotency key，consumer 必须在与自身领域变更同一事务中完成 Inbox 去重与处理结果。

#### 4.4.5 Artifact Store

Artifact Store 提供临时写入、hash/大小/媒体类型校验、不可变内容寻址、读取、引用注册和延迟 GC。它拥有对象字节和存储完整性，领域 Module 拥有 Artifact 的用途、ACL 决策输入、保留根和恢复意义。读取必须携带 Kernel 准入后的范围；Store 不得因命中相同 hash 而泄露其他租户的对象存在性。

恢复时 Artifact Store 只执行引用可读性、hash 和保留根验证，并在需要时物化对象；它不能根据 checkpoint 自行判定用户是否有权恢复。

数据访问层选定 Kysely；不得同时引入 Drizzle 作为第二套权威 schema 或 migration 工具。若替换，必须通过 ADR 和完整 migration/查询回归测试。

## 5 核心领域对象

### 5.1 对象层级

```text
WorkflowRun
├── TaskGraph @ GraphRevision
│   └── TaskRun ── TaskAttempt ── AgentRun
└── MissionScope Tree
    ├── budget / capability ceiling / workspace / cancellation boundary
    └── owns TaskAttempt and AgentRun supervision

AgentRun ── emits UnitIntent ──> Kernel Unit ──> UnitAttempt
                                      └──────> ArtifactRef / Event

WorkSession ── SessionTreeNode ──> WorkflowRun
     └── PromptRevision              └── SessionCheckpoint
```

TaskGraph 决定“何时可运行”，MissionScope Tree 决定“由谁监督、使用何种预算权限与工作区”，WorkSession/SessionTree 决定“用户如何组织、观察和派生多次运行”。三者不可互相替代。

### 5.2 对象定义

| 对象 | 语义 | 可变性与版本规则 |
|---|---|---|
| WorkSession | 用户围绕一个持续目标进行多轮运行、观察和修改的交互容器 | 由 UserInteraction 维护；可包含多个 WorkflowRun 分支 |
| PromptRevision | 用户在初始请求或恢复点提交的不可变意图版本 | 由 UserInteraction 维护；分支时创建新版本，不覆盖父版本 |
| WorkflowRun | 一次完整用户目标运行 | 控制状态可变；绑定当前 GraphRevision |
| GraphRevision | 某一时刻完整有效的任务图版本 | 发布后不可变；Patch 产生新版本 |
| TaskRun | 稳定的逻辑任务身份与最终 Resolution | 任务定义随 revision 版本化；Resolution 单向确定 |
| TaskAttempt | TaskRun 的一次执行尝试 | 创建后固定 attemptNo、输入快照、revision 和执行策略 |
| MissionScope | 目标、预算、权限 ceiling、workspace、上下文可见范围与取消边界 | 版本化更新；形成监督树 |
| AgentRun | 某 AgentDefinitionVersion 在一次 TaskAttempt 中的智能行为 | 内部状态在 WorkflowCheckpoint 边界持久化 |
| Unit | 需要独立授权、调度、资源或审计的不可变操作描述 | 不可变；由幂等键标识逻辑动作 |
| UnitAttempt | Unit 的一次物理执行 | 受 Lease、fencing 与 retry 约束 |
| HumanReviewRequest | Kernel 创建的持久人工审核请求，绑定动作、风险、证据、版本和审查要求 | 状态可变但内容版本化；参数或作用域变化时失效 |
| HumanReviewDecision | 经 Kernel 验证后形成的不可变审核结论 | 不可变；仅对绑定的请求、参数 hash、revision、policyVersion 和有效期生效 |
| WorkflowCheckpoint | Workflow 内部已提交的一致恢复边界 | Workflow 拥有；中等粒度，可按保留策略清理 |
| SessionCheckpoint | 用户可见、可长期恢复的重大业务边界 | Workflow 拥有；自包含恢复清单，挂接 WorkSession/SessionTree |
| Artifact | 大型不可变结果 | SHA-256 内容寻址；metadata 事务化引用 |

### 5.3 MissionScope 及其跨模块约束

MissionScope 是 Workflow 拥有、其他模块共同引用的跨模块控制上下文。它将一个目标或子目标绑定到明确的目标谱系、TaskGraph revision、预算、Capability ceiling、workspace、Context 引用、取消边界和完成条件。Workflow 是 MissionScope 的唯一写入者；其他模块只能通过版本化 `MissionScopeRef`、Query 返回的快照或领域事件投影使用它，不得直接修改 MissionScope 或读取 Workflow 领域表。

| 使用方 | 使用 MissionScope 的目的 | 必须使用的数据 | 边界 |
|---|---|---|---|
| Workflow | 建立目标监督树，归属 TaskAttempt/AgentRun，计算预算继承、取消传播、影响闭包和完成条件 | missionScopeId、parentMissionScopeId、objective、graphRevision、budgetEnvelope、capabilityCeilingRef、workspaceRef、contextRefs、controlState | 唯一写入者；MissionScope 变化必须产生版本化领域事件 |
| ContextEngine | 形成“任务图 + MissionScope 树”感知的 ContextPack，使 Agent 理解当前目标、祖先决策、相邻任务、上游证据和下游消费者 | MissionScope 路径、当前目标与验收条件、当前 GraphRevision、MissionScope 内 TaskGraph 切片、contextRefs、workspaceRef、允许的数据范围 | 通过 Query/Context Unit 获取快照；不得直读 Workflow schema；不得把越权祖先或兄弟 MissionScope 内容装入 ContextPack |
| Kernel | 将执行约束绑定到正确的目标边界，执行授权、预算、资源、workspace、取消和 revision barrier | missionScopeId、capabilityCeilingRef、budgetEnvelope、workspaceRef、controlState、graphRevision、cancelPolicy | MissionScope 不是 Grant 或 Lease；Kernel 依据它签发短期 Grant/Lease，但不得改写其业务状态 |
| AgentToolPool | 在规划期筛选与当前目标约束兼容的 Agent、Tool、Model、Prompt 和 Contract | MissionScope 的目标类型、CapabilityRequirement、数据等级、Contract、执行环境约束 | 只返回静态兼容性与 DefinitionVersion；不得保存 MissionScope 实例、动态预算或授权结论 |
| Shared Infrastructure | 在消息、持久化、事件、Artifact 与遥测中保持目标边界和因果关联 | MissionScopeRef、missionScopeId、graphRevision、tenant/project、correlation/causation | 只传递、存储和索引引用，不解释 MissionScope 业务语义 |

ContextEngine 构造 ContextPack 时必须以 `missionScopeId + graphRevision` 为主定位键。Goal Lineage Materializer 应从当前 MissionScope 沿父链生成根目标、祖先决策和当前子目标；Task Awareness 组件应取得当前 MissionScope 内以及与其存在数据依赖的最小 TaskGraph 切片，明确 READY/BLOCKED 原因、上游 Artifact、当前验收条件和下游输出需求。检索完成后仍须按 MissionScope 对应的数据范围、Artifact ACL、revision 和 token 预算过滤，防止兄弟 MissionScope 或旧 revision 的信息无意进入 prompt。

Kernel 创建 UnitAttempt 时必须记录 `missionScopeId`，并把 MissionScope 的 capability ceiling、预算、workspace 和 graphRevision 纳入 ExecutionPermit。MissionScope 进入 PAUSING、CANCELLING 或 revision barrier 影响集合后，Kernel 必须停止为其签发不兼容的新 Lease；已运行 Attempt 的结果只有同时满足 MissionScope 当前 revision 与 fencing 规则才能提交。

### 5.4 三级 Checkpoint 与 SessionCheckpoint 保存协议

系统必须区分以下三个层级，禁止继续使用无类型的 `Checkpoint` 表示所有恢复点：

| 层级 | 所有者与存储 | 粒度与目的 | 生命周期 | 用户可见性 |
|---|---|---|---|---|
| DBOS Checkpoint | DBOS runtime；`dbos` schema | step、等待、timer、signal 等持久控制流恢复 | 由 DBOS 与 Workflow 的 runtime adapter 按运行保留策略管理 | 不可见，不允许用户选择 |
| WorkflowCheckpoint | Workflow；`workflow.workflow_checkpoints` | Agent/Task/图状态已达到一致提交边界，用于崩溃恢复、暂停续跑和内部重试 | 中短期；仅在不存在保留引用且满足 GC 策略时删除 | 默认隐藏，可用于诊断 |
| SessionCheckpoint | Workflow；`workflow.session_checkpoints` | 阶段完成、并行 Join 后、重规划前、最终完成等重大安全边界，用于跨进程、跨时间的用户回退和分支 | 长期；自动保存点按 SessionCheckpointPolicy 轮换，用户固定/分支基点/最终点不得自动删除 | 可见，可命名、固定、选择恢复和请求删除 |

SessionCheckpoint 可以由某个 WorkflowCheckpoint 晋升产生，但不是指向一条可能被 GC 的 WorkflowCheckpoint 行的脆弱别名。这里的“自包含”是指 manifest 包含恢复决策所需的完整依赖清单、版本、hash、保留证明和重建配方，不是把其他 Module 的数据库行复制进 Workflow。大型状态通过内容寻址 ArtifactRef 共享；删除源 WorkflowCheckpoint 后，SessionCheckpoint 仍必须能够独立验证全部 required dependency。

SessionCheckpoint manifest 至少包括：`sessionCheckpointId`、`workSessionId`、`sourceWorkflowRunId`、`sourceWorkflowCheckpointId?`、`eventSequence`、`graphRevision`、`rootMissionScopeId`、`promptRevisionId`、Workflow 状态快照引用、跨 Module dependency entries、schemaVersion、applicationVersion、milestone、restoreMode、retentionClass、integrityHash 与 availability。每个 dependency entry 至少包含 `owner`、`objectType`、`sourceRef`、`ownerVersion/digest`、`contentHash?`、`required`、`saveStrategy`、`restoreStrategy`、`retentionToken?`、`rebuildRecipeRef?` 和 `validationContractRef`。

正常创建状态为 `CREATING -> PREPARING -> COMMITTING -> AVAILABLE`；创建失败进入 `FAILED`，依赖后来失效可进入 `DEGRADED`、`INCOMPATIBLE`、`REVOKED` 或 `CORRUPTED`。只有 `AVAILABLE` 可直接作为恢复来源，其他状态必须先修复并重新验证或由用户选择其他保存点。

跨 Module 信息按所有权和可恢复性保存：

| 信息类别 | 保存方式 | 删除与恢复约束 |
|---|---|---|
| WorkflowRun、GraphRevision、MissionScope、Task/Agent 状态 | Workflow 在一致边界保存快照或不可变 ArtifactRef | WorkflowCheckpoint 可清理，但有效 SessionCheckpoint 的独立 manifest/Artifact root 不得随之删除 |
| PromptRevision、WorkSession 谱系 | 保存 UserInteraction 拥有的不可变版本引用和 retention token | 可从 UI 隐藏，不得在有效保留关系存在时物理删除正文或版本 |
| DefinitionVersion | 保存 AgentToolPool 返回的 digest、兼容范围和 retention token | 内容不可变且需保留；恢复时仍要检查 `QUARANTINED/REVOKED`，保留不等于允许执行 |
| Artifact、patch/commit、测试证据、effect ledger | 保存内容 hash、ArtifactRef 和 Artifact Store retention token | SessionCheckpoint 是 GC root；只有释放全部保留关系后才可延迟物理回收 |
| ContextPack/检索结果 | 要求精确重现时物化为不可变 Artifact；否则保存 source refs、ACL 范围、revision 与 rebuild recipe | 共享索引和缓存不保存也不回滚；恢复时按当前权限 REFERENCE 或 REBUILD |
| workspace | 保存 base commit + ordered patch/commit refs；只有无法重建时才保存受控 snapshot Artifact | 不保存活目录句柄；恢复时在新 workspace 中 MATERIALIZE |
| Grant、Lease、ExecutionPermit、Secret、Executor 会话、未完成审批 | 只保存审计/effect 引用和“不得继承”标志 | 不建立可复用保留；恢复时失效并重新准入、签发或创建请求 |

所有拥有 dependency 的一级 Module 和 Infrastructure Adapter 必须实现 `CheckpointParticipant` Port：`prepareRetention(checkpointId, dependencies)` 验证对象、版本、hash、可重建性与保留权限并返回 retention token；`commitRetention(token)` 激活保留；`abortRetention(token)` 撤销未提交预留；`queryRetention(token)` 支持崩溃后 reconciliation；`releaseRetention(token)` 只在 Checkpoint 合法删除后解除保留。Workflow 只保存这些结果，不得读取或复制对方领域表来伪造保存。

SessionCheckpoint 创建是可恢复 Saga，而不是跨 Module 分布式事务：

1. Workflow 先在自身一致事务中生成候选 manifest 和 dependency set，状态进入 `CREATING/PREPARING`。
2. Checkpoint Manager 按 owner 调用 `prepareRetention`；需要精确保存但尚未物化的 ContextPack、workspace snapshot 或大型状态通过 Kernel Unit 写入 Artifact Store，再加入 dependency set。
3. 任一 required dependency 不存在、无法保留、无法重建或 Contract 不兼容时，创建失败并幂等 `abortRetention`；不得发布 `AVAILABLE`。
4. 全部 owner 返回版本化准备结果后，Workflow 在一个本地事务提交最终 manifest、integrityHash、retention token、Event 与 Outbox，并将状态置为 `COMMITTING`。
5. 各 owner 幂等执行 `commitRetention`；全部 required token 可查询为 ACTIVE 后，Workflow 才将 SessionCheckpoint 提交为 `AVAILABLE`，UserInteraction 此后才可展示为可恢复。
6. 协调进程崩溃时，Workflow 根据 operation/idempotency key 查询各 token 并继续 commit 或 abort，不重新创建对象。required owner 永久提交失败时释放已激活的保留并进入 `FAILED/INCOMPATIBLE`，不得发布 `AVAILABLE`；可选 dependency 失败只能使保存点进入明确的 `DEGRADED`，并列出不可恢复能力。

有效 retention token 存在时，普通删除只能隐藏或标记待删除，不能物理移除被引用内容。法规删除、安全撤销或数据损坏可以越过普通保留，但 owner 必须保留墓碑并发布失效 Event，使相关 SessionCheckpoint 转为 `DEGRADED`、`INCOMPATIBLE`、`REVOKED` 或 `CORRUPTED`，不得继续显示为 `AVAILABLE`。物理删除 SessionCheckpoint 必须经 Kernel 授权，按 `DELETE_REQUESTED -> DELETING -> DELETED` 释放各 owner 的 retention token；Artifact 只有通过全局可达性和 grace-period 检查后才能 GC。

同一 DBOS workflow 实例的内部历史可能已被清理，因此 SessionCheckpoint 的默认 `restoreMode` 为 `FORK_NEW_RUN`。只有 runtime adapter 明确证明 DBOS execution identity、代码版本和内部历史均兼容时，才允许 `RESUME_SAME_RUN`。

### 5.5 SessionCheckpoint 跨模块恢复协议

本节只适用于以下两种情况：用户明确选择状态为 `AVAILABLE` 的 SessionCheckpoint 创建分支/恢复；或原 WorkflowRun 因 runtime 历史不兼容、必要 workspace 丢失等原因不能安全续跑，经 Policy/用户决定从 SessionCheckpoint 派生替代运行。其输入必须是 SessionCheckpoint，默认输出是新的 WorkflowRun 与新的 DBOS execution。

以下情况明确不使用本协议：进程崩溃后继续同一个运行使用 DBOS resume/replay + Outbox/Inbox + Kernel reconciliation；Worker/Unit 失败使用 retry 和新 UnitAttempt；Task/Agent 发现设计错误使用 replan、GraphRevision/revision barrier 和新 TaskAttempt；撤销已发生外部副作用使用 compensation/reconciliation。只有这些流程最终决定放弃当前分支、选定 SessionCheckpoint 新开运行时，才转换为本节协议。

| 触发场景 | 使用机制 | 是否创建 RestoreOperation |
|---|---|---:|
| Control Plane/Workflow 进程重启并继续原 execution | DBOS resume/replay | 否 |
| Worker 崩溃、Lease 过期或单个 Unit 重试 | 新 UnitAttempt + fencing | 否 |
| Agent 判断设计错误、结果验收失败或需要改图 | replan/GraphPatch + 新 GraphRevision/TaskAttempt | 否 |
| 外部副作用需要撤销或状态未知 | compensation/effect reconciliation | 否 |
| 用户选择 SessionCheckpoint 回到旧业务边界并创建分支 | 本节 restore/fork | 是 |
| 原运行无法安全续跑，选择 SessionCheckpoint 重建 | 本节 restore/fork | 是 |

Workflow 内的 Restore Coordinator 是恢复业务语义的唯一编排者。它负责读取和校验 Workflow 拥有的 checkpoint manifest、创建 `RestoreOperation`、生成不可变 `RestorePlan`、克隆或重建 Workflow 领域状态、等待各权威 Module 结果，并判断新运行何时可从 `RESTORING` 进入 `PLANNING`/`RUNNING`。Workflow 不获得宽泛的“恢复权限”，不得直接恢复 workspace、Secret、Grant、Lease、Context 索引或其他 Module 的数据库状态。

`RestoreOperation` 至少包含 `restoreOperationId`、来源 SessionCheckpoint、目标 WorkflowRun、新 PromptRevision、restoreMode、RestorePlanRef、当前状态、幂等键、版本和诊断引用；状态固定为 `REQUESTED -> VALIDATING -> PLANNING -> MATERIALIZING -> RECONCILING -> READY`，旁路终态为 `FAILED`、`CANCELLED` 和 `NEEDS_ATTENTION`。新 WorkflowRun 在全部 required RestoreAction 完成前必须保持 `RESTORING`，不得创建普通执行 Unit。

RestorePlan 中每个 RestoreAction 必须声明 owner、strategy、sourceRef、targetRef、required、幂等键和验收 Contract。strategy 限定为 `CLONE`、`REFERENCE`、`REBUILD`、`REVALIDATE`、`REISSUE`、`MATERIALIZE`、`RECONCILE` 或 `INVALIDATE`。恢复按下表处理：

| 状态类别 | 权威所有者 | 恢复策略 |
|---|---|---|
| WorkflowRun、TaskGraph、MissionScope、Task/Agent 状态 | Workflow | 在新 ID 命名空中 CLONE/REBUILD，保留 source-to-target mapping |
| Artifact 与已提交 patch/测试证据 | Artifact Store + 领域引用所有者 | 验证 hash/ACL/可读性后 REFERENCE；不覆盖对象 |
| Agent/Tool/Model/Prompt/Contract DefinitionVersion | AgentToolPool | 按 digest REVALIDATE；已 REVOKED 定义必须 INVALIDATE |
| ContextPack 和索引 | ContextEngine | 不回滚共享索引；按当前 ACL/revision REFERENCE 或 REBUILD ContextPack |
| Grant、Lease、ExecutionPermit、Secret | Kernel | 不继承；按当前 Identity/Policy/预算 REISSUE |
| workspace | Kernel + Workspace/Sandbox Executor | 从 commit + patch refs 或 snapshot MATERIALIZE 到新 workspace |
| 开放 HumanReviewRequest 和短期批准 | Kernel/Workflow wait | INVALIDATE；若动作仍需要则按当前参数新建审核 |
| 已发生外部副作用 | Kernel + Workflow Compensation Coordinator | 先 RECONCILE，必要时创建显式补偿 Task；不得借 restore 隐藏历史 |
| WorkSession/SessionTree | UserInteraction | 保留原历史，仅在收到新运行已提交 Event 后追加分支节点 |

所有一级 Module，以及拥有 workspace/Artifact 等可恢复资源的 Infrastructure Adapter，都必须预先实现统一的 `RestoreParticipant` Port：`validate(action)` 只读检查兼容性与权限需求，`execute(action)` 幂等执行本所有者动作，`query(actionId)` 支持崩溃后查回结果，`cleanup(action)` 回收尚未发布的临时资源。返回的 `RestoreActionResult` 至少包含 actionId、owner、status、source/target ref、ownerVersion、evidence/diagnostics、retryability 和 completedAt。某类状态的所有者没有该适配器，或其结果 Contract 未通过兼容测试时，SessionCheckpoint 不得宣称该状态可恢复；不得由 Workflow 用读取对方数据库或伪造成功结果代替。

具体恢复方式为：UserInteraction 创建可选的新 PromptRevision 并提交选定 checkpoint 的恢复意图 → Kernel 校验当前身份、Checkpoint 可见性和恢复权限 → Workflow 锁定 manifest 并验证 availability/integrityHash/required retention token → 创建 `RESTORING` 的目标 WorkflowRun、RestoreOperation 和不可变 RestorePlan → Workflow 克隆自身状态并为其他 owner 生成 RestoreAction → Kernel 对真实资源动作逐项重新准入 → 各 Module 依据当前状态执行 REFERENCE/REBUILD/REVALIDATE/REISSUE/MATERIALIZE/RECONCILE 并提交 RestoreActionResult → Workflow 验收全部 required 结果、提交 source-to-target ID mapping 和新 GraphRevision → Kernel 允许新运行进入普通执行。该过程是可恢复 Saga，不使用跨 Module 分布式事务；中途失败不修改来源运行，临时 workspace、预留预算和其他资源由幂等 cleanup 回收。

## 6 跨模块契约

### 6.1 消息类型

- **Command**：请求目标模块改变其权威状态；必须带 idempotencyKey 和 expectedVersion。
- **Query**：只读请求；不得产生领域副作用；结果带 sourceVersion。
- **Event**：已提交事实；只使用过去式命名；发布后不可变。
- **Signal**：控制、用户变更、权限申请或等待中的通信；接收方必须持久确认。
- **ArtifactRef**：不可变大对象引用；消息中不得内嵌超限载荷。

### 6.2 统一 Envelope

所有跨模块消息至少包含：

```ts
interface BaseEnvelope<T> {
  messageId: string;
  messageType: "command" | "query" | "event" | "signal" | "result";
  schemaName: string;
  schemaVersion: number;
  occurredAt: string;
  producer: string;
  tenantId: string;
  projectId: string;
  workflowRunId?: string;
  missionScopeId?: string;
  aggregateId?: string;
  aggregateVersion?: number;
  graphRevision?: number;
  correlationId: string;
  causationId?: string;
  traceparent?: string;
  payload: T;
}
```

消费者必须拒绝未知 major schema、缺少租户上下文、载荷校验失败或资源归属不匹配的消息。Minor 兼容只允许新增可选字段。任何破坏性字段变更必须创建新 schemaVersion，并提供双读或升级迁移期。

### 6.3 错误模型

统一错误包含 `code`、`category`、`message`、`retryable`、`detailsRef`、`correlationId`。类别固定为 `VALIDATION`、`CONFLICT`、`POLICY`、`RESOURCE`、`TIMEOUT`、`DEPENDENCY`、`EXECUTION`、`INTEGRITY`、`INTERNAL`。公开 API 不返回 Secret、prompt、堆栈或路径敏感内容；完整诊断作为受 ACL 控制的 Artifact。

## 7 关键运行路径与模块协作

本章规定系统主要操作的端到端路径。路径中的每一步只允许由对应权威 Module 提交状态；调用返回、进程内对象或 UI 临时状态均不得代替已提交领域事实。

### 7.1 应用启动、创建 Session 与提交初始 Prompt

```text
Module Host 启动依赖与五个 Module
  -> UserInteraction 创建 WorkSession 与 PromptRevision
  -> Kernel 准入 CreateWorkflow
  -> Workflow 建立运行、目标范围与初始规划
  -> AgentToolPool 固定定义版本不再改变
  -> ContextEngine 完成初始化
      -> Workflow 发布 GraphRevision 并开始执行
      -> Kernel 投影运行状态
      -> UserInteraction 展示 SessionTree 与运行进度
```

1. Module Host 加载配置与 SecretRef，检查 PostgreSQL、DBOS、Artifact Store、Executor 和 schema 兼容性，按 Persistence/Communication → AgentToolPool/ContextEngine → Kernel/Workflow → UserInteraction/API 的顺序启用服务。依赖未达到 readiness 时不得接受创建运行请求。
2. UserInteraction 接收用户输入，创建 `WorkSession`、首个 `SessionTreeNode` 和不可变 `PromptRevision`。正文按数据等级保存为受控记录或 Artifact，交互层只持有其权威引用。
3. UserInteraction 发送包含 IdentityContext、workSessionId、promptRevisionId、幂等键和期望策略选项的 `UserIntent`。Kernel 完成身份、租户、Policy、预算和请求版本准入，写入审计后转发 `CreateWorkflow`。
4. Workflow 幂等创建 `WorkflowRun`、根 `MissionScope`、revision 0、Bootstrap Planning TaskAttempt 和初始 WorkflowCheckpoint；这些对象成功提交后才发布创建事件。
5. Workflow 查询 AgentToolPool，按目标、Contract、风险和执行环境固定 Planner、Model、Tool 与 Prompt 的 DefinitionVersion；目录只返回定义，不参与运行。
6. Planner 需要项目事实时产生 Context UnitIntent。Kernel 校验 allowedDataScope 后调用 ContextEngine；ContextEngine 检索、过滤并发布带 provenance 的 ContextPackRef，Kernel 再将结果事件交还 Workflow。
7. Workflow 验证规划输出并原子发布首个 GraphRevision，计算 READY Task，创建 TaskAttempt 与 AgentRun。后续 Unit 进入 7.4 的通用执行循环。
8. Kernel 将 Workflow 事件、UnitAttempt、Lease、成本与审批组合成 RuntimeProjection；UserInteraction 消费投影并更新 SessionTree、任务图、错误和 Artifact 视图。UI 断线不影响运行。

### 7.2 保存 SessionCheckpoint

```text
用户请求或 SessionCheckpointPolicy 命中安全边界
  -> Kernel 准入 CreateSessionCheckpoint
  -> Workflow 提交一致 WorkflowCheckpoint
  -> Workflow 生成候选 manifest + dependency set
  -> 各 owner prepareRetention / 必要数据物化为 Artifact
  -> Workflow 提交最终 manifest 与 retention tokens
  -> 各 owner commitRetention
  -> Workflow 标记 AVAILABLE
  -> UserInteraction 展示可恢复保存点
```

1. 用户显式保存时，UserInteraction 提交 sourceWorkflowRunId、期望 milestone/retentionClass、expectedVersion 和幂等键；Kernel 校验控制权限后向 Workflow 发送命令。策略触发的保存直接由 Workflow 产生意图，但仍只能在已定义的安全边界执行。V1 只要求用户显式保存。
2. Workflow 停止该边界继续产生新状态，等待已接受结果完成版本/fencing 校验，记录 effect ledger，并在一个本地事务提交一致 WorkflowCheckpoint、Event 和 Outbox。未知外部副作用未完成 reconciliation 时不得创建可恢复的 SessionCheckpoint。
3. Checkpoint Manager 从 Workflow 状态生成候选 manifest，列出 Workflow 快照以及 PromptRevision、DefinitionVersion、Artifact、ContextPack/rebuild recipe、base commit/patch、workspace snapshot 和 effect ledger 等跨 Module dependency；SessionCheckpoint 进入 `PREPARING`。
4. 对每个 owner 调用 `CheckpointParticipant.prepareRetention`。不可变数据返回版本/hash 和 retention token；可重建数据返回 source refs 与重建配方；要求精确重现的数据先通过 Kernel Unit 物化为 Artifact；Grant、Lease、Secret、Executor 会话和未完成审批只记录不得继承，不做保留。
5. 任一 required dependency 无法验证、保留或重建时，Workflow 将创建操作标记为失败并调用所有已准备 owner 的 `abortRetention`。只有可选 dependency 失败时才可按 Policy 形成 `DEGRADED`，且必须明确缺失能力。
6. 全部 required dependency 准备成功后，Workflow 原子提交不可变 manifest、integrityHash、ownerVersion、retention token、Checkpoint Event 与 Outbox，进入 `COMMITTING`；随后各 owner 幂等执行 `commitRetention`。
7. Workflow 通过 `queryRetention` 确认所有 required token 为 ACTIVE 后才提交 `AVAILABLE`。崩溃后使用同一 operationId/idempotency key 继续查询和提交，不重新复制对象，也不依赖进程内响应。
8. Kernel 更新 RuntimeProjection；UserInteraction 只在 `AVAILABLE` 后展示为可恢复，并显示谱系、milestone、retentionClass、兼容性和缺失的可选能力，不读取或修改 manifest。

### 7.3 从 SessionCheckpoint 恢复或派生运行

```text
用户选择 AVAILABLE SessionCheckpoint
  -> UserInteraction 可选创建新 PromptRevision
  -> Kernel 准入 restore/fork
  -> Workflow 验证 manifest、hash 与 retention
  -> 创建新 WorkflowRun(RESTORING) + RestoreOperation/RestorePlan
  -> 各 owner 执行 RestoreAction 并返回版本化结果
  -> Workflow 验收 required 结果并发布新 GraphRevision
  -> Kernel 开放普通执行准入
  -> UserInteraction 将新运行挂入 SessionTree
```

1. 本路径只在用户明确选择 SessionCheckpoint，或原运行不能安全续跑且已经选定 SessionCheckpoint 作为替代来源时使用。普通进程崩溃、Worker 重试、Agent 设计错误/replan 和 compensation 分别走 7.9、Unit/Task 重试、7.6 和 7.8，不进入本路径。
2. UserInteraction 提交 checkpointId、可选的新 PromptRevisionId、目标项目、用户原因、expectedVersion 和幂等键。Kernel 校验当前身份、Checkpoint 可见性、目标数据范围和恢复权限；旧审批、Grant、Lease 或 Secret 不构成当前授权。
3. Workflow 锁定 SessionCheckpoint，验证状态为 `AVAILABLE`、integrityHash 正确、schema/application 兼容、全部 required retention token 仍 ACTIVE；失效或强制删除的 dependency 使操作进入 FAILED/NEEDS_ATTENTION，不得降级为无提示的部分恢复。
4. Workflow 以复合事务幂等创建新的 `RESTORING` WorkflowRun、parentRunId/parentSessionCheckpointId、新 DBOS execution 启动意图、RestoreOperation、RestorePlan、初始 source-to-target ID mapping、Event 与 Outbox。默认 `FORK_NEW_RUN`，来源运行和保存点保持不变。
5. Workflow 克隆自己拥有的 Graph/MissionScope/Task 状态；其他信息只生成面向 owner 的 RestoreAction。Kernel 对 workspace 物化、Context 重建、DefinitionVersion 验证和任何资源动作按当前 Policy 重新准入。
6. Artifact Store 验证 hash/ACL；AgentToolPool 验证 digest 与安全状态；ContextEngine 引用已物化 ContextPack 或按当前 ACL 重建；Workspace Adapter 从 base commit + patch/commit refs 创建新 workspace；Kernel 重新签发必要 Grant/Lease/ExecutionPermit。各方返回可幂等查询的 RestoreActionResult。
7. Workflow 验收所有 required 结果并固化最终 ID mapping；定义被 REVOKED、Artifact 缺失、权限收窄或 effect-unknown 时进入 FAILED/NEEDS_ATTENTION，不得绕过当前安全策略。中途产生的临时 workspace 和预留资源通过幂等 cleanup 回收。
8. 全部 required RestoreAction 成功后，Workflow 提交新 GraphRevision，使 RestoreOperation 进入 `READY`；Kernel 此后才允许普通 Unit 准入。UserInteraction 只在分支创建 Event 已提交后把新运行挂到 SessionTree，失败操作不产生虚假运行中节点。

### 7.4 活跃 Workflow 的 Unit 执行循环

```text
Workflow/AgentRun -> UnitIntent -> Kernel admission -> Scheduler
  -> Executor/ContextEngine
  -> Kernel validation + UnitAttempt Event
  -> Workflow consume + accept/retry/replan
  -> RuntimeProjection -> UserInteraction
```

1. Workflow 根据当前 GraphRevision、Join、MissionScope 和输入 Contract 选择 READY Task，创建固定输入快照的 TaskAttempt 与 AgentRun。
2. AgentRun 每次需要模型、工具、Context、文件、网络或数据库操作时，只能生成不可变 UnitIntent；不得直接调用 Provider 或 Adapter。
3. Kernel 校验 Unit schema、DefinitionVersion、CapabilityRequirement、MissionScope ceiling、Policy/HumanReviewDecision、预算、数据范围、workspace ownership、revision 和 deadline，随后由 Scheduler 分配资源并签发 Grant、Lease、fencing token 与 ExecutionPermit。
4. Kernel 根据 UnitType 调用相应执行面：Context Unit 交给 ContextEngine；模型或工具 Unit 依据 AgentToolPool 固定定义调用 LiteLLM/MCP adapter；代码和命令 Unit 进入隔离 Sandbox/worktree。AgentToolPool 不执行 Unit，ContextEngine 不接受未授权的直接调用。
5. Executor 仅向 Kernel 返回结构化结果、usage、effect record、diagnosticsRef 和 ArtifactRef。Kernel 校验 Lease、fencing、revision、结果 schema、大小与 Artifact hash，在同一事务提交 UnitAttempt 状态、事件和 Outbox。
6. Workflow 消费已提交 Event，验证 owner、correlation 和 revision。AgentRun 可继续产生 UnitIntent、请求人工信息、提交 GraphPatch 或给出 AgentResult；Workflow 负责结果验收、Task Resolution、Join 重算和后续 Task 激活。
7. Kernel 持续将业务事件与执行状态合成为 RuntimeProjection；UserInteraction 只展示投影和公开 Query 结果。循环直至完成条件成立，或进入等待、暂停、取消、失败、重新规划与补偿路径。

### 7.5 Git 集成与结果验收

```text
TaskAttempt 交付 ChangeSet
  -> Workflow 固定 IntegrationPlan
  -> Kernel 物化干净集成 workspace
  -> 顺序应用 patch/commit
  -> 冲突分类
  -> build/test/contract quality gates
  -> IntegratedRevision 或 IntegrationFailed
  -> Task/Workflow 最终验收
```

1. 写代码的 TaskAttempt 不得仅返回“完成”文本。它必须提交不可变 `ChangeSet`，至少包含 base revision、patch/commit ArtifactRef、变更路径、rename/delete/binary metadata、worker workspace identity、已运行测试和预期输出 Contract。
2. Workflow 内的 Integration Coordinator 以 GraphRevision、Task 依赖、base revision 和 ChangeSet hash 生成不可变 IntegrationPlan。顺序必须确定且可解释；同一输入不得因 Event 到达先后而改变集成顺序。
3. 集成使用全新 workspace，不直接修改任一 Worker workspace 或用户原工作树。Workflow 生成 Workspace/Command UnitIntent，Kernel 重验路径、预算、revision 和权限后调用 Executor 物化 base、逐个应用 ChangeSet 并返回结构化结果。
4. 冲突分为 `TEXTUAL`、`STRUCTURAL`、`SEMANTIC`、`BINARY`、`BASE_MISMATCH` 和 `POLICY`。系统不得静默选择任一 Worker 结果；V1 对非自动可解决冲突停止集成并返回 Evidence，后续版本可创建显式修复 Task 或人工审核。
5. 全部 ChangeSet 应用后必须在同一干净 workspace 运行版本化 QualityGate，至少包含 patch 完整性、禁止路径、构建/测试命令和最终 diff 检查。Worker 自身测试只是 Evidence，不代替集成后测试。
6. 所有门通过后，Workflow 提交 `IntegratedRevision`，绑定 base revision、ordered ChangeSet hash、最终 diff/commit Artifact、QualityGateResult 和 provenance，再解析集成 Task。失败则提交 `IntegrationFailed`，保留 workspace diagnostics，不得将 WorkflowRun 报告为成功。
7. 集成 workspace 的提交、推送、建 PR 或发布是独立外部副作用，必须经过新的 Kernel 准入/人工审核；`IntegratedRevision` 本身不等于已推送或已发布。

### 7.6 运行中变更与重新规划

```text
UserInteraction 创建 PromptRevision 并提交变更
  -> Kernel 准入 replan/UserChangeSignal
  -> Workflow 计算影响闭包
  -> Kernel 冻结受影响执行范围
  -> Workflow 提交安全 Checkpoint 与新 GraphRevision
  -> 未受影响分支继续，新规划进入 Unit 循环
```

1. UserInteraction 固化新的 PromptRevision，提交带目标引用、expectedVersion、变更原因和幂等键的 replan/UserChangeSignal；不得覆盖原 PromptRevision。
2. Kernel 校验身份、控制权限、版本和策略后持久化信号。Workflow 计算 MissionScope 子树、DAG 下游、Join、共享 Artifact、workspace、权限与副作用形成的影响闭包。
3. 影响范围尚未确定时，Kernel 停止为候选范围签发新 Lease，并阻止新的不可逆副作用；Workflow 将确定受影响的 MissionScope 转为 PAUSING。
4. Workflow 等待安全边界，提交 WorkflowCheckpoint 和 effect record，校验 Planner 提案后原子发布新 GraphRevision 与 revision barrier。旧 revision 的迟到结果只作为 Evidence 保存。
5. 未受影响分支只有通过输入输出 Contract、workspace 隔离和共享 Artifact 兼容检查后才能继续；受影响分支基于新 PromptRevision 重新规划并进入 7.4 的 Unit 执行循环。

### 7.7 人类审核与执行恢复

```text
Workflow/Kernel 识别人工审核条件
  -> Kernel 创建 HumanReviewRequest 并冻结相关动作
  -> ContextEngine 提供受控 Evidence
  -> UserInteraction 展示审核工作台并收集 ReviewResponse
  -> Kernel 验证审查者并提交 HumanReviewDecision
  -> Workflow 继续、重新规划、等待或终止
  -> Kernel 在批准时签发短期 Grant/ExecutionPermit
```

1. Workflow 可因权限请求、关键业务选择、信息缺失或结果验收产生 HumanReviewIntent；Kernel 也可在 Unit 准入时因高风险 Tool、敏感数据、外部副作用、生产环境或预算阈值直接触发审核。
2. Kernel 根据 Policy 和 AgentToolPool 的 riskClass 创建持久 HumanReviewRequest，绑定 WorkflowRun、MissionScope、Task/Agent/Unit、规范化参数 hash、GraphRevision、DefinitionVersion、policyVersion、影响范围、有效期和审查者要求。相关 Unit 不得进入 Scheduler；Workflow 将受影响对象置于持久等待状态。
3. Kernel 汇总已有 Artifact、diff、dry-run、预算与回滚信息；需要补充证据时，以受限 Context Unit 请求 ContextEngine 生成 EvidenceRef。证据必须同时满足动作数据范围和审查者 ACL。
4. UserInteraction 从 Kernel 获取 ReviewProjection，展示风险、参数、目标资源、证据、替代方案、回滚方式和多人审核进度，收集 approve、reject、request-changes、provide-information 或 accept-result ReviewResponse。高风险决定必须再次认证并要求理由。
5. Kernel 验证审查者身份、角色、职责分离、最少人数、参数 hash、revision、policyVersion 和有效期，幂等提交不可变 HumanReviewDecision。任一绑定条件变化时原请求转为 INVALIDATED，并创建新请求；UserInteraction 的点击本身不构成授权。
6. Workflow 消费决定：批准后重新确认当前业务状态并恢复等待点；拒绝或要求修改时选择替代方案、重新规划或结束目标；补充信息进入新的 Prompt/Signal；结果验收决定完成或返工。Kernel 仅在有效批准且其他准入条件仍满足时签发最小权限、短时 Grant 与 ExecutionPermit。
7. Kernel 更新 RuntimeProjection 和 AuditRecord，UserInteraction 展示最终决定及后续状态。客户端断线、请求过期或重复提交不得自动批准，也不得触发重复副作用。

### 7.8 取消与补偿

```text
UserInteraction 请求取消
  -> Kernel 准入并撤销 Lease/ExecutionPermit
  -> Workflow 进入 CANCELLING 并传播 MissionScope
  -> Kernel 返回运行中 Unit 的终止结果
  -> Workflow 结算结果并编排补偿
  -> Kernel 投影最终业务状态
```

1. UserInteraction 提交带目标、expectedVersion、原因和幂等键的 cancel 意图；Kernel 完成身份、Policy 和状态准入，并向 Workflow 投递持久取消命令。
2. 为限制继续产生副作用，Kernel 可先撤销相关 Lease、Grant 和 ExecutionPermit，停止新调度，并要求 Executor 在 grace period 内安全终止。该物理动作不构成业务取消完成。
3. Workflow 将目标 WorkflowRun/MissionScope 转为 CANCELLING，向子 MissionScope 传播控制状态，停止产生新 UnitIntent，并等待 Kernel 返回 SUCCEEDED、CANCELLED、ABANDONED 或 effect-unknown 等规范化结果。
4. Workflow 保留已提交结果和费用，依据 effect record 判断是否需要显式 Compensation Task；Kernel 对状态未知的外部副作用执行 reconciliation，无法确认时转入人工审核或 NEEDS_ATTENTION。
5. 必需补偿完成或人工处置结论提交后，Workflow 写入 CANCELLED/NEEDS_ATTENTION 等业务状态；Kernel 更新 RuntimeProjection，UserInteraction 展示可审计的取消、补偿和遗留影响。

### 7.9 进程故障、重启与重连

```text
Module Host 重启并检查依赖
  -> DBOS 恢复 Workflow 等待点
  -> Outbox 重放、Inbox 去重
  -> Kernel reconciliation 回收 Lease 与孤儿 Attempt
  -> Workflow 从已提交事实继续
  -> UserInteraction 按事件游标重连
```

1. Module Host 重启后检查数据库、DBOS、Artifact Store、策略、定义版本和 Executor 健康；关键依赖未就绪时保持 not-ready，不接收新的状态变更请求。
2. DBOS 恢复 Workflow 控制流等待点，Persistence Platform 重放未发布 Outbox；消费者先写 Inbox 去重记录，再处理重复或乱序消息。
3. Kernel reconciliation 回收过期 Lease，识别孤儿 UnitAttempt 和状态未知的副作用；只有满足重试安全条件的 Unit 才能使用新 fencing token 重新调度。
4. Workflow 从已提交领域表、Event Journal 和 WorkflowCheckpoint 恢复业务状态，不从 Worker 内存或 Executor 存活状态推断结果。待处理 HumanReviewRequest 保持等待；已提交 HumanReviewDecision 按幂等规则重新投递。
5. UserInteraction 使用最后事件游标恢复 SSE；游标失效时重新查询 RuntimeProjection、ReviewProjection 与 SessionTree。任何恢复路径均不得重新执行已确认的不可逆副作用，结果未知时进入 effect reconciliation 或人类审核。

### 7.10 完成提交协议

Workflow 与 Kernel 使用两阶段完成握手，避免“Workflow 等待 Lease 消失、Kernel 又等待 Workflow 先终态”的循环依赖：

1. Workflow 确认 required Task/Join/MissionScope、最终 IntegrationAttempt/QualityGate、必需 Signal/审核、Artifact 与 effect record 均满足后，只进入 `FINALIZING` 并发布绑定当前 aggregateVersion 的 `WorkflowCompletionProposed`；此时停止产生新 UnitIntent，但不得写入 `SUCCEEDED`。
2. Kernel 收到提案后停止该 scope 的新准入，结算用量，关闭或回收 Grant、Lease 与 ExecutionPermit，处理仍运行或 effect-unknown 的 UnitAttempt，并返回同一 proposal version 的 `ExecutionScopeDrained` 或 `ExecutionDrainFailed`。
3. Workflow 只在收到匹配版本的 `ExecutionScopeDrained` 并重新验证最终 Artifact/hash 与验收条件后提交 `SUCCEEDED`。无法确认的副作用、无法回收的资源或失败的最终验收进入 `NEEDS_ATTENTION`/失败路径，不得用超时推断成功。

## 8 Kernel 执行与调度设计

### 8.1 Unit 准入流水线

准入顺序固定为：schema 校验 → 身份与租户校验 → DefinitionVersion 解析 → CapabilityRequirement → PolicyDecision/HumanReviewDecision → 预算预留 → 资源与速率配额 → workspace/path ownership → Executor 选择 → Lease/fencing → ExecutionPermit。任一步失败均不得启动 Executor。

### 8.2 Human Review Gate

PolicyDecision 要求人工判断时，Kernel 必须在创建 Lease 和启动 Executor 之前建立 HumanReviewRequest，并把 Unit 准入状态置为 `WAITING_HUMAN_REVIEW`。Gate 负责规范化参数、计算 parametersHash、绑定 revision/policyVersion/DefinitionVersion、确定审查者角色与人数、生成 ReviewProjection，并在收到 ReviewResponse 后执行身份、职责分离、有效期和绑定校验。

只有 APPROVED HumanReviewDecision 可以使 Unit 重新进入准入流水线；它不能直接把 Unit 标记为已调度。REJECTED、CHANGES_REQUESTED、EXPIRED、INVALIDATED 和 REVOKED 必须形成规范化 Event 返回 Workflow。Gate 不处理 INFORMATION、DECISION 或 ACCEPTANCE 的业务含义，但仍负责审查者授权和决定完整性。

### 8.3 Scheduler

Scheduler 输入为已由 Workflow 声明可执行且通过静态校验的 Unit。调度优先级按以下顺序综合计算：显式优先级、deadline、关键路径、租户 weighted fairness、MissionScope 配额、Provider RPM/TPM、CPU/内存/GPU、workspace 路径冲突。调度决策必须可解释并记录 reason code。

完整 Scheduler 的目标能力包括：

- 每租户、每 WorkflowRun、每 Provider 和全局并发上限。
- 预算预留与实际用量结算；预留失败不启动执行。
- Lease TTL、heartbeat、续租、撤销和单调 fencing token。
- 优雅取消期限；超时后终止 Sandbox 并将 Attempt 标记为 ABANDONED 或 CANCELLED。
- Worker 失联、孤儿 Lease、stale Attempt 与资源泄漏的周期性 reconciliation。

V1 只实现单项目、全局与每 WorkflowRun 的并发上限，确定性 Worker 的运行时间/资源上限，以及最小 Lease TTL、heartbeat、撤销和 fencing。租户公平性、Provider RPM/TPM、成本预算结算和复杂优先级在 V1.1/Beta 实现。

### 8.4 Executor 与 Sandbox

Executor 统一实现 `prepare`、`execute`、`heartbeat`、`cancel`、`collectResult`、`destroy`。SandboxProvider 统一实现 `create`、`exec`、`upload`、`download`、`snapshot`、`pause`、`resume`、`setNetworkPolicy`、`metrics`、`destroy`。

默认 Sandbox 使用 rootless Docker/Podman：非 root 用户、只读根文件系统、移除 Linux capabilities、限制 PID/CPU/内存/磁盘/执行时间、默认禁网、仅挂载授权 worktree、不得挂载宿主密钥。可信本地开发可用受限 subprocess，但必须明确标识为非安全边界且不得执行不可信代码。

## 9 权限、身份与 Secret

### 9.1 授权链

```text
IdentityContext
  -> MissionScope capability ceiling
  -> Tool/Model CapabilityRequirement
  -> PolicyDecision
  -> optional HumanReviewDecision
  -> short-lived CapabilityGrant
  -> ExecutionPermit
  -> side-effect-time enforcement
```

Grant 必须绑定 tenant、project、WorkflowRun、MissionScope、TaskAttempt、resource、action、expiry、policyVersion 和 graphRevision。AgentToolPool 的 manifest 和 Tool 描述只声明需求，不构成授权。SecretManager 只向具体 Attempt 注入短期派生凭据；长期凭据不得进入 prompt、日志、Artifact 或数据库明文字段。

### 9.2 与人类审核的准入衔接

授权链发现需要人工判断时必须停止在 PolicyDecision 与 Grant 之间，由 Kernel 创建 HumanReviewRequest。人工批准不是 Grant，也不能跳过预算、资源、Lease、revision 和副作用时重验；只有审核有效且其余准入条件全部满足时，Kernel 才能签发短期 CapabilityGrant 与 ExecutionPermit。完整的人类在环模型见第 10 章。

## 10 人类在环设计

### 10.1 目标与适用范围

人类在环用于处理自动系统不应独立决定的权限、风险、业务歧义和结果验收问题。其目标是在不破坏并行执行与持久恢复的前提下，使每个关键人工决定具有明确请求、充分证据、合法审查者、不可变结论、有限作用域和完整审计。

系统必须区分四类人类参与，禁止全部压缩为“批准/拒绝”：

| 类型 | 解决的问题 | 典型决定 | 权威所有者 |
|---|---|---|---|
| APPROVAL | 是否允许高权限、高风险或外部副作用动作 | approve、reject、request-changes | Kernel 拥有请求与决定；Workflow 持有等待语义 |
| INFORMATION | 执行所需事实缺失或存在歧义 | provide-information、cannot-provide | Workflow 拥有问题与等待语义；UserInteraction 拥有用户回答记录；Kernel 准入传递 |
| DECISION | 多个合法方案需要业务选择 | select-option、request-alternative | Workflow 拥有选项与后续业务语义；Kernel 验证决定者权限 |
| ACCEPTANCE | 阶段性或最终结果需要人工验收 | accept-result、reject-result、request-rework | Workflow 拥有验收状态；Kernel 验证审查者和决定有效性 |

### 10.2 模块权威与协作边界

| 模块 | 人类在环职责 | 禁止行为 |
|---|---|---|
| UserInteraction | 提供 Review Inbox/详情页；展示 ReviewProjection 和允许访问的 Evidence；收集 ReviewResponse、理由、约束和再次认证结果；恢复断线后的审核视图 | 自行判断请求已批准、直接解除 Workflow 等待、签发权限、修改请求绑定或在客户端合并多人决定 |
| Kernel | 依据 Policy 和 riskClass 创建 HumanReviewRequest；验证审查者身份、角色、职责分离和有效期；聚合多人响应；提交 HumanReviewDecision；失效、撤销和审计请求 | 决定 Task 业务成功、替 Workflow 选择业务方案、将批准当作永久授权 |
| Workflow | 产生业务型 HumanReviewIntent；在 AgentRun/TaskAttempt/MissionScope 上建立持久等待；消费决定并继续、返工、重新规划、补偿或终止 | 认证审查者、修改 Kernel 的请求/决定、在未收到有效决定时推断同意 |
| ContextEngine | 在请求数据范围和审查者 ACL 交集内生成证据摘要、引用和 provenance | 为审核扩大数据访问范围，或把未经授权的原始内容写入 ReviewProjection |
| AgentToolPool | 在 DefinitionVersion 中声明 riskClass、默认审核策略、dry-run/回滚能力、参数失效规则、所需角色和最少审核人数 | 保存运行中请求、审查者身份或授权结论 |

### 10.3 触发条件与风险分级

以下情况必须进入人工审核：

1. 删除、覆盖或迁移不可恢复数据，销毁资源、密钥、备份或环境。
2. 生产环境操作、权限提升、扩大 Capability ceiling、读取高敏 Secret、放宽网络或 Sandbox 边界。
3. 对外发送消息、发布内容、提交或合并代码、部署、写入第三方系统以及其他代表用户产生的外部副作用。
4. 突破 MissionScope 预算、成本、并发、运行时间或受管资源阈值。
5. 关键需求存在歧义、合法方案具有显著不同业务影响，或重规划将实质改变用户目标。
6. 最终结果、生产变更、安全配置、权限规则或其他高影响交付需要业务验收。
7. 外部副作用状态未知、补偿失败、完整性异常或自动系统无法安全确定下一步。

风险级别固定为 `LOW`、`MEDIUM`、`HIGH`、`CRITICAL`、`UNKNOWN`。LOW 可自动执行并审计；MEDIUM 默认按 Policy 自动执行或通知；HIGH 必须执行前单人审核；CRITICAL 必须再次认证，可要求多人审核与职责分离；UNKNOWN 默认停止并转人工。自动降级不得降低由数据等级、环境或 Tool Definition 规定的最低风险级别。

### 10.4 审核对象与状态模型

HumanReviewRequest 至少包含 reviewId、reviewType、riskLevel、tenant/project、WorkflowRun/MissionScope/TaskAttempt/AgentRun/Unit 引用、requestedAction、normalizedParametersHash、graphRevision、policyVersion、DefinitionVersion 列表、impactScope、EvidenceRef、diff/preview/rollback 引用、requiredReviewerRoles、minimumApprovals、separationOfDuties、expiresAt 和 correlationId。

HumanReviewDecision 至少包含 reviewId、决定、审查者身份或多人决定集合、理由、附加约束、reviewedParametersHash、graphRevision、policyVersion、decidedAt 和审计引用。Decision 发布后不可变；后续撤销必须形成新的 Revoke 事实，不得覆盖历史。

```text
PENDING -> PARTIALLY_APPROVED -> APPROVED
        -> REJECTED
        -> CHANGES_REQUESTED
        -> EXPIRED
        -> INVALIDATED
        -> REVOKED
```

多人审核未达到 minimumApprovals 时只能处于 PENDING/PARTIALLY_APPROVED。任何拒绝是否立即终止请求由 ReviewPolicy 明确规定。终态请求不能重新打开；需要再次审核时创建具有 parentReviewId 的新请求。

### 10.5 绑定、失效与授权规则

审核决定必须绑定精确动作、规范化参数 hash、目标资源、影响范围、WorkflowRun、MissionScope、GraphRevision、DefinitionVersion、policyVersion、预算上限和有效期。参数、目标资源、revision、权限范围、预算、DefinitionVersion、Policy、来源 PromptRevision/Checkpoint 或审查者资格发生变化时，Kernel 必须把原请求标记为 INVALIDATED，并在仍需执行时创建新请求。

批准仅表示允许 Kernel 继续执行准入，不保证动作一定执行或业务一定成功。Kernel 在签发 Grant 和 ExecutionPermit 前必须重验 Lease、预算、deadline、资源、workspace、revision 与当前 Policy；Workflow 在恢复等待点前必须重验目标聚合状态。拒绝、过期和失效不得自动转换为 Task 失败，具体业务结果由 Workflow 根据 required、替代方案和补偿策略决定。

### 10.6 审核工作台与证据要求

UserInteraction 必须提供按风险、类型、WorkSession、WorkflowRun、截止时间和状态筛选的 Review Inbox。详情页必须展示动作的自然语言摘要与规范化参数、目标资源、数据等级、影响范围、diff/dry-run/预览、预计成本、不可逆性、替代方案、回滚或补偿计划、相关 Artifact/Evidence provenance、请求来源和剩余有效时间。

审查者只能看到其 ACL 允许的证据。高风险决定必须填写理由；CRITICAL 决定必须再次认证并显示职责分离与多人审核进度。界面必须将“提供信息”“选择方案”“批准权限”和“验收结果”显示为不同操作，不得使用含义模糊的统一确认按钮。重复提交使用 reviewId 与 idempotencyKey 去重；并发决定使用 requestVersion 决胜并返回明确冲突。

### 10.7 持久等待、恢复与审计

Workflow 的人工等待必须持久化 reviewId、reviewType、等待对象、恢复位置、deadline 和允许决定集合；DBOS 只恢复等待控制流。客户端关闭、Control Plane 重启或消息重复不改变审核状态。Kernel 的 HumanReviewRequest、ReviewResponse 接收记录、HumanReviewDecision、失效原因、Grant 签发和最终执行结果必须形成同一 correlation 链。

审核超时按 ReviewPolicy 进入 EXPIRED，默认不批准；Workflow 可选择继续等待、使用低风险替代方案、重新规划或进入 NEEDS_ATTENTION。外部副作用状态未知时禁止通过普通 APPROVAL 让用户猜测是否成功，必须先执行 effect reconciliation，并将可验证证据与剩余不确定性提交给人工决定。

## 11 ContextEngine 与 AgentToolPool

### 11.1 ContextEngine

ContextPack 必须按目标谱系、当前 revision、ACL、来源可信度和 token 预算组装。检索流程为路径/文本/符号/语义召回 → RRF 或加权融合 → 可选 rerank → ACL 与 revision 再过滤 → 去重与压缩 → token 裁剪 → provenance 固化。

每个 chunk 必须记录 sourceRef、sourceRevision、parserVersion、embeddingModel、createdAt 和 ACL 标签。索引为可删除重建的派生数据；源文件、领域记录和 Artifact 才是事实。ContextEngine 不得直接写 Workflow 状态，Workflow 也不得直读 ContextEngine 数据库。

HumanReviewRequest 需要补充证据时，ContextEngine 接收 Kernel 授权的 Review Evidence Unit，并以 `requestDataScope ∩ reviewerDataScope` 为最大可见范围生成摘要或 EvidenceRef。证据必须携带来源、版本、ACL 与生成时间；无法安全脱敏时返回拒绝，不得把原始敏感内容交给 UserInteraction。

### 11.2 AgentToolPool

DefinitionVersion 发布后不可变，至少包含 schema、digest、来源、兼容范围、风险分类、CapabilityRequirement 和供应链验证状态。ToolType、CapabilityRequirement 与输入输出 Contract 必须作为同一版本化发布单元。运行开始后固定版本；目录升级不得改变既有运行的解析结果。

可能产生外部副作用或高权限访问的 DefinitionVersion 还必须声明 riskClass、defaultReviewPolicyRef、reviewInvalidationFields、dryRunSupport、rollbackSupport、requiredReviewerRoles、minimumApprovals 与 separationOfDuties。Kernel 可根据运行时 Policy 提高审核要求，但不得低于定义声明的最低要求。

## 12 数据架构与一致性

### 12.1 PostgreSQL schema 与模块数据库权限

V1 使用单一 PostgreSQL 实例，但必须隔离 schema、数据库 role 与连接池：`interaction`、`workflow`、`kernel`、`context`、`catalog`、`platform`、`dbos`。迁移使用独立 migration role；应用运行 role 不得拥有 DDL、role 管理、`BYPASSRLS` 或其他 schema 的隐式 `PUBLIC` 权限。生产环境必须撤销 schema/table 的默认 `PUBLIC` 权限，并以 tenant/project RLS 或等价查询守卫实施纵深防御。

权限记号：`RW` 表示该 Module 是领域写入所有者；`R*` 表示仅可读取专门发布、可撤销的稳定投影/view；`API` 表示不得直连，必须通过 Query/Event；`-` 表示无访问权。

| 数据 schema | 领域内容与维护者 | UserInteraction | Workflow | Kernel | ContextEngine | AgentToolPool |
|---|---|---:|---:|---:|---:|---:|
| `interaction` | WorkSession、SessionTree、InteractionTurn、PromptRevision、ReviewResponse、UI 偏好；UserInteraction migration/维护 | RW | API | R* | API | API |
| `workflow` | WorkflowRun、TaskGraph、MissionScope、Attempt、HumanReviewWait、WorkflowCheckpoint、SessionCheckpoint；Workflow migration/维护 | API | RW | R* | API | API |
| `kernel` | PolicyDecision、HumanReviewRequest/Decision、Grant、Lease、UnitAttempt、审计、RuntimeProjection/ReviewProjection；Kernel migration/维护 | R* | API | RW | API | API |
| `context` | ContextRecord、索引元数据、RetrievalResult、ContextPack；ContextEngine migration/维护 | API | API | R* | RW | API |
| `catalog` | Agent/Tool/Model/Prompt/Contract DefinitionVersion；AgentToolPool migration/维护 | R* | R* | R* | R* | RW |
| `platform` | Outbox、Inbox、Artifact metadata/ref、consumer offset、共享审计设施；Persistence Platform migration/维护 | 最小 R*/受控写入端口 | 最小 R*/受控写入端口 | 最小 R*/受控写入端口 | 最小 R*/受控写入端口 | 最小 R*/受控写入端口 |
| `dbos` | DBOS runtime 内部表；仅 DBOS/runtime adapter 维护 | - | 仅 adapter | - | - | - |

`R*` 不是对领域基表的通配 SELECT。它只能授予明确列集合的 view、materialized projection 或独立 read model，例如 Kernel 可读取 Workflow 的控制摘要，UserInteraction 可读取 Kernel 的脱敏 RuntimeProjection。包含 prompt、Secret、原始工具输出、Checkpoint manifest、effect ledger 或 ACL 内部字段的基表默认不得跨模块授权。

引用权限与数据所有权必须分离：一个 Module 可以持久化其他 Module 对象的 opaque ID/VersionedRef，但不得借此获得目标对象的读写权。例如 `interaction.session_tree_nodes.session_checkpoint_id` 只是引用；SessionCheckpoint 的 manifest 与 availability 仍由 Workflow Query 返回。跨 schema 不建立级联外键；引用完整性由 Command 准入、版本化 Query、领域事件和 reconciliation 保证。

每个写事务只能由拥有目标 schema 的 Module 发起。`platform` 的 Outbox/Inbox 和 ArtifactRef 必须通过受控 Persistence/Artifact Port 参与所有者事务，不得向 Module 暴露可任意修改共享表的宽权限。备份、PITR、归档、GC 与 migration 属于平台运维权限，不得复用应用 role。

公共列规范：主键 `text`；聚合版本 `bigint`；时间 `timestamptz`；JSON 扩展字段 `jsonb`；幂等键建立租户范围唯一约束；所有领域表包含 `tenant_id`、`created_at`、`updated_at`。高敏字段不得写入通用 JSONB。

### 12.2 事务与事件

聚合更新采用 optimistic concurrency：`UPDATE ... WHERE id=? AND version=?`，成功后版本加一。同一事务写入领域表、Event Journal 和 Outbox。Outbox dispatcher 采用批量锁定和 `SKIP LOCKED`，成功发布后记录状态；consumer 先写 Inbox 唯一键再执行业务，重复 eventId 返回已处理结果。

事件只承诺至少一次投递。跨 Module 或跨外部资源的长流程使用 Saga/补偿，不使用分布式事务；同一 Module 内只有模块设计明确列出的复合一致性边界才可在一个数据库事务中修改多个聚合，并必须规定锁顺序、expectedVersion 和故障注入测试。其余跨聚合流程仍使用 Event/Saga。事件保序只保证到 aggregateId；消费者不得依赖全局顺序。

### 12.3 Artifact 一致性

先将对象写入临时区并计算 SHA-256，再原子移动到 CAS 键，最后在领域事务中提交 ArtifactRef。数据库提交失败产生孤儿对象，由延迟 GC 清理；对象写入失败则不得提交引用。读取时校验 hash、size、mediaType、租户和访问许可。

## 13 API 与操作入口

### 13.1 HTTP API

Fastify API 以 `/v1` 版本化，TypeBox schema 同时生成 OpenAPI。最低资源集合：

- `POST /workflows`：创建运行，要求 `Idempotency-Key`。
- `POST /sessions`、`GET /sessions/{id}`：创建/读取 WorkSession 与 SessionTree。
- `POST /sessions/{id}/prompts`：提交不可变 PromptRevision。
- `GET /sessions/{id}/checkpoints`：读取 Workflow 发布的用户可见 SessionCheckpoint 摘要。
- `POST /sessions/{id}/fork`：从指定 SessionCheckpoint 和新 PromptRevision 派生 WorkflowRun。
- `POST /session-checkpoints/{id}/pin|unpin|delete`：请求修改长期保留策略或删除；不得直接修改 Workflow 表。
- `GET /workflows/{id}`：读取总体状态与版本。
- `POST /workflows/{id}/pause|resume|cancel|replan|fork|rerun`：控制命令，要求 expectedVersion。
- `GET /workflows/{id}/graph?revision=`：读取图快照。
- `GET /workflows/{id}/mission-scopes|tasks|agents|units|artifacts|audit`：游标分页查询。
- `GET /workflows/{id}/events`：SSE，支持 `Last-Event-ID` 断线续传。
- `GET /reviews`、`GET /reviews/{id}`：按权限读取 HumanReviewRequest 列表与 ReviewProjection。
- `POST /reviews/{id}/responses`：提交 approve、reject、request-changes、provide-information、select-option 或 accept/reject-result；要求 `Idempotency-Key`、requestVersion 和必要的再次认证证明。
- `POST /reviews/{id}/revoke`：在动作尚未执行且 Policy 允许时请求撤销本人决定；撤销形成新事实，不覆盖原决定。
- `GET /health/live`、`GET /health/ready`：进程与依赖健康。

写请求返回 `202 Accepted` 和 operation/correlation 标识；确定性查询返回 `200`。冲突使用 `409`，策略拒绝使用 `403`，幂等键载荷冲突使用 `422`。API 不以 HTTP 连接生命周期绑定 Workflow 生命周期。

### 13.2 CLI 与 Web

V1 CLI 至少提供 `workflow create|run|inspect|cancel`、`review list|show|respond`、`checkpoint create|list|restore` 和 `report`；静态 TaskGraph 由文件输入，不提供 `plan`、动态 `replan` 或 `rerun`。完整产品可逐步增加 WorkSession/Prompt、pause/resume、fork、Web 和 IDE Adapter。所有操作面均属于 UserInteraction，不得直连领域数据库；V1 至少展示 WorkflowRun、GraphRevision、Task/Unit、Lease、审批、Artifact、diff、测试证据和因果链。

## 14 用户变更、取消、恢复与补偿

用户提交改变时，UserInteraction 必须先创建不可变 PromptRevision，再由 Kernel 持久化控制意图并完成准入，Workflow 随后记录 UserChangeSignal，计算 MissionScope 子树、DAG 上下游、Join、共享 Artifact、workspace ownership、权限和副作用构成的影响闭包。范围未知时，Kernel 必须冻结候选范围的新 Lease 与不可逆副作用；不得先继续执行再事后修正。

Workflow 对影响集合进入 PAUSING，在安全边界提交 WorkflowCheckpoint 与 effect record，并在 policy 要求时物化 SessionCheckpoint，随后发布新 GraphRevision 和 revision barrier。旧 Attempt 结果保留为 Evidence，但不能写入当前投影。未受影响分支只有通过输入输出 Contract、workspace 隔离和共享 Artifact 兼容检查后才能继续。

恢复语义必须区分：retry 创建同一 TaskRun 的新 TaskAttempt；resume 从兼容 WorkflowCheckpoint 延续同一 WorkflowRun；rerun 创建新 WorkflowRun；fork/restore 从 SessionCheckpoint 创建带 parentRunId、parentSessionCheckpointId 与新 PromptRevision 的新运行；compensation 创建显式反向 Task。不得通过删除 Event、改写任何已提交恢复点或覆盖终态模拟恢复。

## 15 错误处理与责任归属

### 15.1 处理原则

错误由最接近其权威状态且能够作出确定性判断的 Module 分类和提交，其他 Module 只能传播结构化错误或依据自身状态采取后续动作。所有错误使用第 6.3 节的统一模型并携带 correlationId；跨模块错误不得只以异常字符串、日志或 HTTP 状态传递。

错误处理必须遵循以下顺序：入口校验 → 权威 Module 分类并提交事实 → 局部重试或隔离 → Workflow 判断业务影响 → Kernel 更新 RuntimeProjection 与审计 → UserInteraction 向用户呈现可执行的处置选项。可重试不代表无限重试；每类重试必须受次数、deadline、预算、幂等性和副作用安全约束。

### 15.2 模块错误责任矩阵

| 责任方 | 负责识别和处理的错误 | 本地处置 | 向外输出 |
|---|---|---|---|
| UserInteraction | Prompt/表单格式错误、缺少用户输入、过期视图或审核版本、SSE 断线、客户端草稿与展示失败 | 在提交前校验；保留草稿；按游标重连；审核冲突时刷新 ReviewProjection | UserIntent/ReviewResponse 校验结果，或对 Kernel 错误的脱敏展示；不得自行重试非幂等控制命令或推断批准 |
| Workflow | 非法领域状态转换、GraphPatch/Join/Contract 错误、Task/Agent 结果不合格、revision 冲突、Checkpoint 不一致、业务完成或补偿失败 | 拒绝状态变更；保持终态不可逆；按策略创建新 Attempt、重新规划、补偿或等待人工处理 | 已提交领域 Event、失败 Resolution、恢复可用性及业务影响；不得伪造 Kernel 执行结论 |
| Kernel | 身份、Policy、HumanReviewRequest/Decision、审查者资格、预算、配额、Lease/fencing、Executor、Sandbox、Provider、Secret 和副作用状态错误 | 准入拒绝；使审核失效；限次重试；撤销 Permit；隔离 Worker；回收 Lease；执行 effect reconciliation | 规范化 HumanReview/UnitAttempt/Policy/Resource Event、诊断引用和可重试标志；不得直接改写 Workflow 终态 |
| ContextEngine | 数据源不可用、索引版本不一致、解析/embedding/rerank 失败、ACL 或 revision 过滤失败、token 超限 | 使用允许的降级检索；废弃污染索引；重建派生数据；拒绝越权结果 | Context Unit 的成功、降级或失败结果及 provenance；不得返回未通过 ACL 的部分结果 |
| AgentToolPool | Definition 不存在、版本/Contract 不兼容、供应链验证失败、定义 schema 无效 | 拒绝发布或解析；保留既有不可变版本；标记不可调度 | 结构化目录错误和兼容候选；不得自动替换既有运行已固定的版本 |
| Shared Infrastructure | 数据库、Outbox/Inbox、Artifact、通信和 Module Host 的可用性或完整性错误 | 事务回滚、重复去重、延迟重放、完整性校验、健康状态降级 | 基础设施错误与健康事件；不得解释 Task 或 Workflow 的业务结果 |

### 15.3 典型错误路径

- **输入与契约错误**：发现方以 `VALIDATION` 拒绝请求。若错误发生在 Agent 输出，Kernel 保存原始输出 Artifact，Workflow 决定修复提示、替代模型或使 Attempt 失败。
- **并发与版本冲突**：拥有聚合的 Module 以 `CONFLICT` 拒绝旧 expectedVersion；调用方重新读取权威状态后重新计算，不进行隐式覆盖或三方合并。
- **权限与人类审核错误**：Kernel 以 `POLICY` 拒绝且不启动 Executor。审查者无资格、人数不足，或参数、revision、policyVersion、有效期和影响范围不匹配时，HumanReviewDecision 不得用于授权。
- **资源、限流与超时**：Kernel 以 `RESOURCE` 或 `TIMEOUT` 记录 UnitAttempt；只在 Unit 幂等、deadline 与预算允许时创建新物理 Attempt。Workflow 决定任务级 retry、fallback 或 replan。
- **依赖与检索错误**：ContextEngine、AgentToolPool 或外部 Provider 返回 `DEPENDENCY`；Kernel 记录具体依赖状态，Workflow 判断能否降级、等待或更换兼容定义。
- **执行与 Sandbox 错误**：Kernel 终止或隔离执行环境，保存 diagnosticsRef 和可用 Artifact；旧 Lease/fencing 的结果不得提交，Workflow 仅消费规范化 Event。
- **完整性错误**：Artifact hash、Checkpoint manifest、Event 序列或数据库约束异常统一视为 `INTEGRITY`，立即停止相关提交和恢复；在 reconciliation 或人工确认完成前不得报告成功。
- **内部未知错误**：责任 Module 以 `INTERNAL` 记录受控诊断，触发告警并保持最后已提交状态；不得把堆栈、Secret、路径或原始 prompt 暴露给公开 API。

### 15.4 重试、降级与人工介入边界

Kernel 只重试 UnitAttempt 的物理执行，Workflow 只重试 TaskAttempt 或重新规划业务路径，DBOS 只重放幂等 step；三层不得同时重试同一副作用。状态未知的外部写入必须先按 idempotency key 查询或进入 effect reconciliation。自动降级不得扩大权限、数据范围、成本上限或 Contract；不能安全分类、补偿或恢复的错误进入 `NEEDS_ATTENTION`/等价等待状态，由 UserInteraction 展示原因、证据和允许的操作。

## 16 可观测性、审计与数据保护

### 16.1 关联模型

log 和 span 在对象存在时携带 `tenant.id`、`workflow.run.id`、`mission.scope.id`、`task.attempt.id`、`agent.run.id`、`unit.attempt.id`、`correlation.id` 与 `graph.revision`。metric 标签只允许低基数字段，例如状态、类型、错误码和环境；具体 ID 通过 trace/log 或 exemplar 关联，禁止把 run/attempt ID 直接作为 Prometheus 标签。OpenTelemetry Collector 可统一接收数据，PostgreSQL append-only 审计表和 Artifact Store 才是审计事实源。

### 16.2 关键指标

- 工作流：完成率、恢复率、重规划率、人工介入率、端到端延迟。
- 调度：queue P50/P95/P99、租约等待、公平性偏差、配额拒绝、Lease 过期。
- 模型：TTFT、token、cost、结构化输出失败、fallback、Provider 错误率。
- 工具与 Sandbox：启动时间、超时、退出码、网络拒绝、资源峰值与清理失败。
- 数据：Outbox backlog、Inbox 重复率、事务冲突、连接池耗尽、Artifact 校验失败。
- 检索：Recall@k、MRR/nDCG、引用正确率、token 节省和 rerank 延迟。
- 人类审核：各类型待审数量、等待时长 P50/P95、过期/失效/拒绝率、多人审核完成时间、审核后重规划率、决定到执行延迟和重复响应率。

prompt、工具参数、源代码与模型原始输出默认不写入 span。日志必须执行字段级分级、Secret 脱敏、采样和 retention；用户删除请求与法定保留冲突时遵循明确的数据治理策略。

## 17 部署与运行

### 17.1 V1 部署单元

V1 使用 pnpm workspace 和 TypeScript/Node.js LTS。单个 Control Plane 进程承载 Module Host、已实现的 Module、最小 Fastify API、Scheduler 与 Outbox dispatcher；PostgreSQL 同时承载领域 schema 和独立 `dbos` schema，本地 CAS 保存 Artifact。V1 使用受限本地 subprocess 或开发环境已有的 rootless container 运行确定性 Worker；subprocess 必须显式标记为非安全边界。LiteLLM、MCP、OTel Collector、Prometheus/Grafana、S3 和 Web 均不是 V1 运行必需依赖。逻辑并列不要求物理拆进程，但模块包、接口和测试边界必须独立。

建议包边界：

```text
apps/control-plane        Fastify、Module Host、后台任务
apps/cli                  操作入口
packages/contracts        TypeBox/JSON Schema 公共契约
packages/user-interaction CLI 命令、最小 WorkSession/PromptRevision 与投影
packages/workflow         Workflow、Integration、Restore 领域与 DBOS adapter
packages/kernel           最小 Policy、APPROVAL、Scheduler、Lease、Executor
packages/context-engine   路径/ripgrep 查询 adapter
packages/catalog          确定性 Worker/Contract 定义
packages/persistence      Kysely、migration、outbox/inbox
packages/artifacts        本地 CAS
packages/observability    结构化日志、审计与基础指标端口
workers/executor          确定性本地/容器 Worker
```

### 17.2 配置与启动

配置按默认值、配置文件、环境变量、SecretRef 分层覆盖；启动时完成 schema 兼容检查、migration 锁、依赖健康、Definition 校验和策略加载。readiness 只有在数据库、DBOS、Artifact Store 与关键 Executor 可用时通过。关闭顺序为停止接收新用户控制请求、停止发放 Lease、等待 grace period、提交 WorkflowCheckpoint、按策略生成必要的 SessionCheckpoint、刷新 Outbox、持久化 UserInteraction 游标并关闭连接。DBOS Checkpoint 由 runtime 自身协议完成，不得以应用层伪造。

### 17.3 备份与灾难恢复

V1 必须提供可脚本化的 PostgreSQL 与本地 CAS 备份/恢复演练，并证明恢复后可重建固定 fixture Workflow 因果链。PITR、对象存储版本化、季度灾备和正式 RPO/RTO 是 Beta/Production 要求；在实测前不声明生产目标。

## 18 测试与质量门

### 18.1 测试层级

- V1 工具基线：Vitest 执行单元/集成测试，fast-check 执行状态机和 DAG 属性测试，Testcontainers 管理 PostgreSQL，固定 Worker/Kernel/其他 Module fake 提供可重现输入。测试不得绕过生产 schema 校验和 Adapter 边界。
- 单元测试：Reducer、状态转换、Policy、预算、Join、图校验、错误映射。
- 属性测试：DAG 无环、版本单调、终态不可逆、重复 Event 幂等、fencing 单调、预算守恒。
- 契约测试：所有 schema 正反例、兼容性、OpenAPI、跨模块 producer/consumer。
- 集成测试：PostgreSQL、DBOS、Outbox/Inbox、本地 CAS、确定性 Executor、Git patch 应用、QualityGate，以及各 owner 的 CheckpointParticipant/RestoreParticipant 契约。
- 故障注入：领域事务后崩溃、Outbox 发布前崩溃、重复/乱序消息、Worker kill、Lease 过期、Artifact 写入失败、集成中崩溃、prepare/commit retention 中崩溃和 restore action 中崩溃。
- V1 E2E：静态图、单/双 Worker、ALL Join、ChangeSet、文本/base mismatch 冲突、集成测试门、单人 APPROVAL、cancel、崩溃 resume、跨 Module SessionCheckpoint 保存、fork 和最终报告。
- 错误归属测试：每类统一错误只能由责任 Module 作出权威分类，跨模块传播不得丢失 correlation、retryable、detailsRef 与业务影响。
- 安全测试：路径逃逸、symlink/junction、禁止路径、越权 Artifact 和命令审批绕过。MCP/OAuth/SSRF 和不可信模型输出属于 V1.1/Beta。
- 性能测试：10 个并发 Workflow 的队列、数据库争用、Outbox backlog、Git 集成延迟和崩溃恢复时间。

### 18.2 发布阻断条件

任一关键不变量无自动化测试、状态机存在未定义转换、schema 破坏性变更无迁移、故障恢复产生重复不可逆副作用、旧 fencing 可提交、HumanReview 被绕过或失效决定仍可授权、越权访问 Artifact、Secret 出现在日志、备份不可恢复，均阻断发布。

## 19 实施计划与交付物

### 19.1 Phase 1：工程、契约与事实源

建立 pnpm workspace、严格 TypeScript、lint/测试；实现 Shared Contracts、ID/Clock/Error、Kysely migration、Module schema/role 隔离、本地 CAS、领域事务与 Outbox 原子提交。交付契约包、migration、兼容测试和本地开发环境。

### 19.2 Phase 2：单 Worker 可恢复纵向闭环

接入 DBOS，实现静态 TaskGraph、WorkflowRun、TaskRun/TaskAttempt、确定性脚本 Worker、UnitIntent/UnitAttempt、最小 Lease/fencing、Inbox/Outbox 和 `ALL` Join。交付单 Worker 从创建到完成的闭环，并用进程中断验证恢复不会重复提交结果。

### 19.3 Phase 3：双 Worker 与 Git 结果集成

增加最多两个隔离 workspace、路径 ownership 预检、ChangeSet、IntegrationPlan、IntegrationAttempt 和干净集成 workspace；按确定顺序应用 patch/commit，区分预检冲突、应用冲突和质量门失败。交付可复现的最终 IntegratedRevision、diff 与测试报告。

### 19.4 Phase 4：准入、完成与显式恢复

实现本地路径白名单、资源/运行时间上限、单人 `APPROVAL`、完成候选与 Kernel drain 握手；实现简化 SessionCheckpoint 的 CheckpointParticipant 保留协调、RestoreOperation/RestorePlan，以及各 Module 的验证、重建、物化和失效响应。交付 cancel、retry、崩溃 resume、跨 Module 保存和从保存点派生新 WorkflowRun 的闭环。

### 19.5 Phase 5：操作面与 V1 验收

实现 CLI 和其所需的最小 Fastify API、基于路径/`ripgrep`/ArtifactRef 的上下文装配、结构化日志与最终报告；完成固定 fixture、故障注入和小规模性能测试。V1 完成后才能把真实模型输出引入可靠性基线。

### 19.6 V1.1 与后续阶段

V1.1 接入单模型 Provider、Bootstrap Planner 和真实 coding Agent，并建立质量、token、成本和延迟基线。动态改图、更丰富的人类在环、语义检索、Web UI、多租户、独立消息系统、强 Sandbox 与生产供应链能力根据实测瓶颈和风险逐步进入 Beta/Production。

每个 Phase 的完成定义是：代码、migration、schema、测试、操作手册、指标和回滚方案同时合并；仅完成业务代码不视为交付。

## 20 总体验收标准

系统达到实现基线必须同时满足：

1. 任意结果可追溯至 WorkflowRun、TaskAttempt、UnitAttempt、ChangeSet、IntegrationAttempt、Identity、Grant、Lease、DefinitionVersion 和 GraphRevision；尚未启用的 AgentRun 不作为 V1 前置条件。
2. 任意 Module 或 Worker 崩溃后，已提交状态不丢失，恢复不会产生失控的重复副作用。
3. 重复、乱序、迟到 Event 不破坏当前投影，旧 Lease、旧 fencing、失效 Grant 和 barrier 前 revision 均不能提交当前结果。
4. 两个独立 workspace Worker 可并行；路径 ownership 冲突在执行前阻止，非显式冲突由 IntegrationAttempt 检出，只有通过集成质量门的 IntegratedRevision 才可成为最终代码结果。
5. V1 ContextPack 只使用路径、`ripgrep` 和明确 ArtifactRef；每项关键事实仍具有来源、版本和范围证据，语义检索质量不作为 V1 验收项。
6. 用户可通过 CLI 创建运行、取消、提交审批、查看结果，并从 SessionCheckpoint 派生新 WorkflowRun；动态 replan 和运行中局部影响闭包留到后续阶段。
7. 全局状态视图可从领域 Event 重建，AgentToolPool 升级不改变既有 DefinitionVersion，Artifact 可校验且不可变。
8. DBOS Checkpoint、WorkflowCheckpoint 与 SessionCheckpoint 的所有权、保留和恢复语义不混淆；SessionCheckpoint 只有在全部 required dependency 获得 ACTIVE retention token 后才为 `AVAILABLE`，普通删除不能破坏这些引用；RestorePlan 获得各权威 Module 的显式结果，恢复分支不继承旧 Grant、Lease、Secret、审批或 Executor 会话。
9. 五个 Module 的数据库 role 不能写入其他 Module schema，跨模块读取只限公开投影或 Query；越权 SQL 在集成测试中被数据库拒绝。
10. V1 的安全、可靠性、小规模性能、备份恢复和 E2E 质量门通过，并保留可复现测试记录；生产容量与灾备指标不是 V1 完成条件。
11. 静态图单 Worker、双 Worker、Git 集成、预检冲突、应用冲突、质量门失败、审批、取消、重复消息、进程崩溃和 Checkpoint 派生路径均有端到端测试。
12. V1 只验收单人 `APPROVAL` 的持久等待与恢复；`INFORMATION`、`DECISION`、`ACCEPTANCE` 和多人审核保留稳定契约，但不作为 V1 实现完成条件。

## 21 架构变更控制

以下变更必须提交 ADR：模块权威边界变化、公开 schema 的破坏性变更、Kysely/DBOS/PostgreSQL 的替换、引入第二消息系统或图运行时、Sandbox 信任边界变化、Grant 模型变化、Artifact 寻址方式变化。ADR 必须记录问题、约束、方案、决策、后果、迁移、回滚和验证指标。

允许在不改变公共契约的前提下替换 Adapter。引入 NATS、S3、gVisor、microVM、Restate、Temporal 或独立向量库前，必须用队列积压、恢复率、数据库 P95、检索质量、Sandbox 启动时间、并行收益、冲突率和成本数据证明必要性，并确保系统仍只有一个任务状态权威、一个 PolicyAuthority 和一个 Workflow 恢复所有者。
