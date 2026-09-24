# MultiAgentOS M1–M5 总达成计划

> 文档类型：产品与架构增量路线图<br>
> 里程碑：固定为 M1、M2、M3、M4、M5，共五个<br>
> M1 范围权威：`docs/M1Plan/TargetM1.md`<br>
> 长期终态权威：`docs/DesignReport/TargetArchitecture.md`
> 版本规则：M1–M5 是开发里程碑；M1–M4 对应 0.x 预发布版本，M5 通过完整生产验收后发布 V1.0

## 1. 目标与解释规则

本计划把 MultiAgentOS 的长期架构拆成五个可独立运行、独立验收并安全合入 `main` 的中间产品。每个 M 都必须形成从用户输入到成功、失败或合法等待状态的自身闭环；禁止交付必须依赖下一 M 才能运行的半成品。M5 完成时必须完整实现 `TargetArchitecture.md`。

1. 当前 M 的范围和发布门以该 M 的目标设计与需求规格为准。
2. `TargetArchitecture.md` 描述最终形态，其中尚未分配到当前 M 的能力不自动扩大当前范围。
3. V1.0 平台语义由 M1–M5 渐进兑现；当前 M1/0.1 仍以 `TargetM1.md` 的本地单 Agent MVP 为准，只有 M5 通过生产验收后才能发布 V1.0。
4. 后一 M 通过实现既有 Port、替换 adapter、放宽 capability 或增加 schema major 演进，不得改写五 Module、五 Infrastructure 的所有权和关键调用方向。
5. 标记“条件引入”的技术必须有 ADR 和实测数据，不得仅为预留而安装。

## 2. 所有 M 的共同发布门

每个 M 合入 `main` 前必须同时满足：

- **产品闭环**：合法请求一定到达可解释的成功、失败、取消或等待状态。
- **架构闭环**：新增能力经过既有 Module、Port、Envelope、Artifact 和权限边界，无临时直连。
- **数据闭环**：新增数据具有唯一 owner、版本、一致性、持久化与保留定义。
- **失败闭环**：超时、依赖失败、非法输入和 Unsupported 均为结构化结果，不依赖解析日志。
- **验证闭环**：单元、contract、集成、E2E、安全及必要的故障测试通过并关联需求 ID。
- **运维闭环**：具有启动、health、关闭、升级、回滚、已知限制和运行手册。
- **兼容闭环**：前一 M 的验收任务继续通过；破坏性变化有新 major、迁移和回滚方案。
- **分支闭环**：合并后 `main` 始终可构建、可运行、可演示，不存在发布阻断项。

## 3. 五阶段总览

| M | 可交付产品 | 核心增量 | 主要新增技术栈 | 验收任务摘要 |
|---|---|---|---|---|
| M1 / 0.1 | 本地只读 Repository Analysis Agent | 单任务、真实模型、只读检索工具、来源化报告 | Node.js、TypeScript、pnpm、TypeBox、AI SDK、Vitest、Commander、ripgrep | 在陌生仓库定位实现与测试并生成可复验分析报告 |
| M2 / 0.2 | 安全且可恢复的单 Coding Agent | 先完成隔离写入/命令/测试与本地确认，再依次加入 PostgreSQL、durable workflow、幂等、取消、恢复 | Git、PostgreSQL、Kysely、DBOS、Testcontainers、Fastify | 完成小型代码修复，并在 Control Plane 崩溃后恢复且副作用不重复 |
| M3 | 多任务并行 Coding System | 静态 DAG、多 Executor、Lease/fencing、ChangeSet、确定性集成 | fast-check DAG 测试、Git 集成；NATS 条件引入 | 两个并行任务独立交付并通过统一集成质量门 |
| M4 | 可长期恢复、可审核的安全系统 | Checkpoint/Restore、HITL、强隔离、Secret、完整观测 | rootless container、OpenTelemetry、Prometheus/Grafana；gVisor 条件引入 | checkpoint fork 后经人工批准高风险动作并完成任务 |
| M5 / V1.0 | 完整 MultiAgentOS 平台 | 多租户、远程执行、动态协作、完整 HITL、Web、生产运维 | OIDC、RLS、S3、React、SSE、MCP、NATS；microVM/向量库条件引入 | 多租户远程多 Agent 在故障、审批、恢复、灾备下完整交付，通过后发布 V1.0 |

### 3.1 Agent、Tool、ContextEngine 与 AgentToolPool 累积路线

每个里程碑都必须同时增加 Agent 能力、可受控 Tool、ContextEngine 能力和 AgentToolPool 治理能力。后续 M 继承前序能力，不通过替换整套协议获得新功能。

| M | Agent 能力增量 | Tool 能力增量 | ContextEngine 增量 | AgentToolPool 增量 |
|---|---|---|---|---|
| M1 | 单 Repository Analysis Agent；Context→Query/Read→Observation→Final；多轮补充检索 | tree/search/read；不提供写入、命令和测试副作用 | 文件树、路径/文本/符号检索、分块、裁剪、provenance | 内置 Analysis Agent/Model/Prompt/只读 Tool/Contract；稳定 version/digest；运行固定版本 |
| M2 | 首个 Coding Agent；可修改/测试、可恢复、可取消、预算感知；同一 AgentRun durable resume | write/command/test/diff/worktree，加上幂等键、effect 分类、状态查询、取消、reconciliation | revision-aware snapshot、持久索引元数据、缓存失效、测试错误反馈、恢复后重建 ContextPack | Coding Agent bundle、写工具风险声明、定义持久化/生命周期、恢复兼容性、Provider fallback、Tool retry/effect 声明 |
| M3 | Planner、并行 Worker、结果 Reviewer 提案能力；静态图上的监督与委派 | worktree、ChangeSet、patch、冲突检查、QualityGate、集成证据 | Task/MissionScope 隔离上下文、增量索引、依赖/符号关系、跨任务 Artifact 检索 | 多角色 Agent bundle、Tool 组合、兼容求解、任务能力匹配、版本固定矩阵 |
| M4 | 可暂停/恢复、审批感知、权限感知的长运行 Agent；人工信息可进入新步骤 | checkpoint、review request、secret broker、sandbox profile、受审批高风险工具 | checkpoint context manifest、ACL/敏感信息裁剪、可复现重建、长期记忆受控保留 | 签名与来源、风险等级、权限声明、ACTIVE/DEPRECATED/REVOKED、restore compatibility |
| M5 | ReAct、Plan-and-Execute、Router、Supervisor/Worker、Critic/Reflection、Handoff、协商/投票、事件驱动、完整 HITL、多模态等通用能力族 | MCP、OpenAPI/function、远程工具、浏览器/数据/代码工具、动态发现、凭据/配额/审批/观测 | keyword/vector/symbol/graph hybrid retrieval、reranker、压缩、多级记忆、ACL、多模态、个性化 | 动态 Catalog、能力与依赖求解、组织级发布、灰度/回滚、供应链证明、评测与推荐、模型路由 |

分配规则：Agent 只提出计划、动作、委派和结果；Workflow 仍拥有业务状态与完成判断，Kernel 仍拥有准入和副作用，Integration/Restore/Policy 的确定性结论不得转交给 Agent。Tool 每增加一种副作用类型，都必须同时增加输入/输出 Contract、权限要求、effect 语义、超时/取消、审计和 fake。

## 4. M1：本地只读 Repository Analysis Agent

### 4.1 功能闭环

本地用户通过 CLI 提交仓库和分析问题。系统创建 WorkSession/WorkflowRun，固定 DefinitionVersion，通过 ContextEngine 理解仓库，经 Kernel 准入后让单 Repository Analysis Agent 使用 tree/search/read 进行多轮调查，最终输出包含文件、行范围、repository revision 和 provenance 的结构化分析报告。M1 不修改代码、不运行项目命令，也不创建 Coding Agent。

### 4.2 增加的功能

- 建立五个 Module 和五项 Infrastructure 的真实 package、Port、adapter 与测试边界。
- 打通 `CLI → UserInteraction → Kernel → Workflow → UnitIntent → Kernel → ContextEngine/Executor`。
- 单 TaskGraph、根 MissionScope、单 TaskAttempt、单 AgentRun、多 AgentStep。
- 一个真实模型 Provider、结构化 AnalysisAction 和 Context/Model/FILE_READ Unit。
- 文件树、路径、文本、符号检索，ContextPack token 裁剪与 provenance。
- 只读 workspace 边界、路径安全、超时、输出限制和步数/token/模型调用/时间预算。
- 来源完整性与结论引用验收、本地运行记录、Artifact 完整性、RuntimeProjection、AnalysisReport。
- M2–M5 协议族的 typed Ref、Port、capability 和 Unsupported handler。

### 4.3 模块增量与可拆分交付流

| 交付流 | 本阶段交付 | 可独立验收结果 |
|---|---|---|
| Workflow + UserInteraction | WorkSession/PromptRevision、单 Task 状态机、只读分析 loop、预算、终止和 CLI 投影 | Fake Kernel 下从分析问题运行到成功/失败报告 |
| Kernel + Executor | Context/Model/FILE_READ Unit 准入、workspace/path 安全；写入与命令明确 Unsupported | 固定只读 Unit fixture 在 workspace 执行并形成审计结果 |
| ContextEngine | RepositorySnapshot、tree/path/text/symbol 检索、分块/去重/排序/裁剪、provenance | 未知文件检索 fixture 生成预算内 ContextPack |
| AgentToolPool + Agent | 发布 Analysis Agent、默认 Model/Prompt、tree/search/read Tool 与 AnalysisAction Contract；运行固定 digest | 相同 DefinitionQuery 稳定解析到相同版本，目录变化不影响既有运行 |
| Platform + Quality | Contracts、Router、Repository、Artifact、Module Host、架构/contract/E2E 测试 | 五 Module/五 Infrastructure 可替换装配并通过质量门 |

M1 的 Repository Analysis Agent 采用最小通用循环，允许请求补充 Context、搜索、读取文件和提交 Final；Tool 集固定为 repository tree/search 与 file read。任何 FILE_WRITE、COMMAND、TEST、Git 变更或外部副作用请求都必须确定性返回 Unsupported。

### 4.4 增加的技术栈

- Node.js 24 LTS、TypeScript strict、pnpm workspace。
- TypeBox/JSON Schema、AI SDK、一个 OpenAI 或 Anthropic adapter。
- Commander、ripgrep、Vitest、ESLint、Prettier。
- 不引入 PostgreSQL、DBOS、NATS、MCP、Web 或容器 SDK。

### 4.5 验收要求

- 更新后的 `TargetM1.md` 和 M1 SRS 的全部 FR/NFR/AC、固定分析任务集和发布门通过。
- 五 Module、五 Infrastructure、Executor 均可独立构建、替换 adapter 并通过 contract test。
- 至少一个真实模型分析任务成功；报告中的关键结论都能追溯到 revision/path/line evidence。
- 原 checkout 不变；Windows 路径、junction、只读边界、超时和输出限制通过专项测试。
- 可独立安装、运行、检查和清理，可作为本地开发者产品合入 `main`。

### 4.6 验收任务

提供一个未透露目标文件名的小型计算器仓库并询问：“折扣边界逻辑在哪里实现、哪些测试覆盖它、负数输入为什么可能产生错误？”Agent 必须通过至少两轮检索定位实现、调用方和测试，输出结构化结论、相关文件与行范围、repository revision、证据引用、未确认项、步骤链和用量。报告不能包含无来源的关键断言，仓库不得发生任何修改。

## 5. M2：可恢复的单 Coding Agent

### 5.1 功能闭环

保持单 Task/单 Agent 产品范围，在 M1 只读分析闭环上先建立安全、需本地确认的 Coding Agent，再分阶段加入领域持久化与 durable execution。M2 不允许把 Agent 写入/命令能力和 DBOS/PostgreSQL 同时作为第一个集成点；各子阶段必须独立验收。最终用户可以查询和取消持久运行；Control Plane 或 Executor 在已定义故障点崩溃后，系统恢复同一 WorkflowRun，幂等处理重复消息与副作用。

### 5.2 增加的功能

- PostgreSQL 分 schema/role 的 Repository、migration 与领域事务。
- Coding Agent 的 SEARCH/READ/WRITE/COMMAND/TEST/FINAL 动作、多轮测试修复和 diff/test 双重验收。
- 一次性隔离 Git worktree、FILE_WRITE、COMMAND、TEST、git diff、命令 allowlist、默认禁网/显式网络策略、资源限制、进程树清理、本地副作用确认和原 checkout 不变保障。
- DBOS durable adapter；DBOS 恢复控制流但不拥有领域状态。
- idempotency、expectedVersion、有限 retry、cancel、进程重启恢复。
- Event Journal、Outbox/Inbox、重复/乱序处理和投影重建。
- Kernel EffectRecord、未知副作用 reconciliation、Artifact metadata 持久化。
- 最小 Fastify `/v1` 控制/查询 API 和备份恢复脚本。
- 明确 DBOS replay、Kernel UnitAttempt retry、Workflow TaskAttempt retry 的唯一责任。

M2 强制顺序为：`M2-A 安全非持久 Coding → M2-B PostgreSQL 领域持久化 → M2-C DBOS durable execution → M2-D API/备份/故障验收`。M2-A 未通过副作用边界测试前不得开始恢复自动重放；M2-B 的领域事务与 Outbox 语义未验证前不得接入 DBOS。

### 5.3 模块增量与可拆分交付流

| 交付流 | 本阶段交付 | 可独立验收结果 |
|---|---|---|
| Workflow + Persistence | DBOS durable loop、领域事务、Journal、Outbox/Inbox、cancel/retry/recovery | 任意等待点 kill/restart 后恢复同一业务状态 |
| Kernel + Executor | 一次性 worktree、本地副作用确认、命令/网络/资源策略、EffectRecord、幂等执行、执行状态查询、取消、未知结果 reconciliation | 未确认或越界副作用不执行；同一幂等键不会重复副作用，未知 effect 不被推断成功 |
| ContextEngine | 持久 RepositorySnapshot/IndexRevision metadata、revision-aware cache、失效/重建协议、恢复后的 ContextPack 重放或重建 | 重启后对相同 revision 得到可验证等价上下文，revision 变化必然失效 |
| AgentToolPool + Agent | 新增 Coding Agent bundle、Coding Prompt、write/command/test/diff Tool；Definition 持久化与 ACTIVE/DEPRECATED；Model fallback 受 Contract 约束 | 恢复运行仍解析原 digest；Coding Agent 只能获得其声明且经 Kernel 批准的工具 |
| API + Operations | 最小 Fastify API、投影重建、migration、备份/恢复和故障注入 | API/CLI 观察同一 sourceVersion，备份恢复后因果链可重建 |

M2 为每个 ToolDefinition 增加 `idempotencyMode`、`effectClass`、`riskClass`、`retryPolicyRef`、`cancellationMode` 和 `reconciliationContractRef`；为 Coding AgentDefinition 增加允许工具集、durable state schema、resume compatibility 和预算恢复规则。ContextEngine 增加测试失败 Observation 的检索入口，但只持久化自己拥有的 Snapshot/Index metadata，不接管 Workflow 历史或 Agent 状态。

### 5.4 增加的技术栈

- PostgreSQL、Kysely、DBOS TypeScript SDK。
- Testcontainers 管理集成环境。
- Fastify 与 TypeBox OpenAPI。
- 暂不引入多任务、NATS、Web UI 或生产容器。

### 5.5 验收要求

- M1 全部只读分析回归继续通过；Coding 能力作为新 Agent/Tool bundle 接入，不改变 Analysis Agent 行为。
- Coding Agent 能在隔离 worktree 完成至少一个小型修改、运行测试并交付 diff/evidence，原 checkout 不变。
- 未经本地用户确认的写入/命令/测试不得执行；workspace、网络、资源、进程树与输出边界测试通过。
- 在领域提交、Outbox、DBOS wait、Unit 执行前后 kill 进程，恢复后不丢状态、不重复提交结果。
- 重复 Command/Event、乱序结果、版本冲突和取消竞争均有确定性结论。
- ContextEngine 的 revision cache/IndexRevision 在重启后可重建且不会返回旧 revision；恢复运行继续使用原 DefinitionVersion digest。
- Coding Agent 的 Tool effect/retry/cancel/reconciliation 声明通过共享 contract test，Analysis Agent 的 M1 行为保持不变。
- 数据库 role 阻止跨 Module 写入；migration、备份、恢复可演练。
- 可作为“可靠的本地单 Agent 服务”独立部署并合入 `main`。

### 5.6 验收任务

给系统一个小型仓库和“修复折扣边界错误并补充回归测试”的目标。Coding Agent 必须先复用 M1 分析能力定位实现，再在隔离 worktree 修改和测试。分别在模型返回、文件写入、测试启动和完成提交处强制终止 Control Plane；重启后恢复同一 WorkflowRun，已确认副作用不重复，未知副作用先 reconciliation，最终只有一个有效 patch 和一个成功终态，原 checkout 不变且审计链完整。

## 6. M3：多任务并行与确定性 Git 集成

### 6.1 功能闭环

TaskGraph 放宽为静态 DAG，多个 Executor/AgentRun 在独立 workspace 并行。系统经 readiness、`ALL` Join、Lease/fencing 收集 ChangeSet，在干净 workspace 按确定顺序集成、处理冲突并运行统一 QualityGate，输出 IntegratedRevision。

### 6.2 增加的功能

- 静态多 Task、依赖、readiness、`ALL` Join、有限并发。
- 多 Executor、heartbeat、Lease、fencing 和迟到结果拒绝。
- 独立 worktree、绑定 base revision 的 ChangeSet、确定性 IntegrationPlan。
- 冲突分类、干净集成 workspace、QualityGate、IntegratedRevision。
- Task/Agent retry、失败传播、MissionScope 监督和完成候选 drain。
- 并行收益、冲突率、队列延迟、资源利用指标。

### 6.3 模块增量与可拆分交付流

| 交付流 | 本阶段交付 | 可独立验收结果 |
|---|---|---|
| Workflow + Planner | 静态 DAG、readiness、`ALL` Join、MissionScope、Planner 输出的图提案与确定性图校验 | 固定目标生成合法静态图，非法/有环图不进入运行 |
| Kernel + Executor | 多 Executor 调度、Lease/fencing、heartbeat、独立 worktree 和迟到结果拒绝 | Executor 失联后接管，旧 attempt 结果不推进状态 |
| ContextEngine | 按 Task/MissionScope/AgentRun 隔离 ContextPack；增量索引；符号/依赖关系；worktree/base/integrated revision 感知；跨任务只读 Artifact 检索 | 并行任务获得不串线且绑定各自 revision 的上下文 |
| AgentToolPool + Agent | Planner Agent、Coding Worker、Result Reviewer 三类定义；Agent bundle 与 Tool bundle 兼容求解；按任务能力匹配 | 不兼容 Agent/Tool/Contract 组合在运行前被拒绝，既有运行继续固定版本 |
| Integration + Quality | ChangeSet/IntegrationPlan、patch/conflict Tool、QualityGate、IntegratedRevision、并行与冲突基线 | 独立 ChangeSet 在干净 workspace 确定性集成或结构化失败 |

Planner Agent 只提出 TaskGraph；Workflow validator 发布 GraphRevision。Result Reviewer 可以根据 diff、测试与证据提出接受/返工建议，但 Workflow/Integration Coordinator 仍执行确定性验收。M3 新增 Tool 包括 worktree create/status、ChangeSet emit、patch preflight/apply、conflict inspect、QualityGate run 和 integrated diff；危险 Git 操作不作为 Agent 自由工具开放。

### 6.4 增加的技术栈

- Git patch/worktree 集成适配器，fast-check DAG/Join/状态机属性测试。
- PostgreSQL locking 或等价协调原语。
- NATS 仅在现有 transport 的积压、吞吐或隔离数据证明必要时经 ADR 引入。

### 6.5 验收要求

- M1、M2 回归全部通过。
- DAG、readiness、`ALL` Join 在重复/乱序事件下确定，旧 fencing 永不推进状态。
- 多 Executor 不共享可写 workspace；base mismatch、patch 冲突、QualityGate 失败不被静默解决。
- 每个 Task/MissionScope 的 ContextPack 相互隔离并绑定正确 worktree/base revision；跨任务信息只经受控 ArtifactRef 进入。
- Planner/Worker/Reviewer 与 Tool bundle 的兼容求解、版本固定和不兼容拒绝通过自动化测试。
- Executor 自测不替代集成 QualityGate，最终只交付验证后的 IntegratedRevision。
- 可作为“本地并行软件工程 Agent 系统”合入 `main`。

### 6.6 验收任务

给系统一个含 API、实现和测试区域的仓库，静态图包含两个并行任务及一个集成任务。两个 Executor 在独立 worktree 生成 ChangeSet；注入一个过期 Lease 的迟到结果，系统必须拒绝。Integration Coordinator 在干净 workspace 确定性集成并通过全量 QualityGate。第二次运行注入 patch 冲突，系统必须停在可诊断失败而非覆盖代码。

## 7. M4：Checkpoint、人类控制与强安全边界

### 7.1 功能闭环

长任务可以安全暂停、审批、长期保存和恢复。SessionCheckpoint 通过跨 Module participant 保留 required dependency；用户可从 AVAILABLE checkpoint 派生新运行。高风险动作持久等待人工审批，并在强隔离环境执行；全链路具有 trace、metric、audit 和 Secret 控制。

### 7.2 增加的功能

- WorkflowCheckpoint、SessionCheckpoint、manifest、retention token、GC root。
- Checkpoint participant prepare/commit/abort/query/release。
- RestoreOperation、RestorePlan、ID mapping、默认 `FORK_NEW_RUN`。
- 单人 `APPROVAL` 的持久等待、决定、失效、重新准入和审计。
- Policy/Review Gate、最小权限 Permit、SecretRef、短时 Grant。
- rootless container、网络策略、资源配额、进程树回收。
- OpenTelemetry、Prometheus/Grafana、append-only audit 和故障注入。

### 7.3 模块增量与可拆分交付流

| 交付流 | 本阶段交付 | 可独立验收结果 |
|---|---|---|
| Workflow + Restore | Workflow/Session Checkpoint、participant Saga、RestorePlan、ID mapping、长期等待 | required dependency 不完整时 checkpoint 不可用，成功 restore 派生新 run |
| Kernel + Security | Policy/Review Gate、Permit/Grant、SecretRef、rootless sandbox、网络/资源策略 | 无批准或批准失效时高风险 Unit 永不执行 |
| ContextEngine | Checkpoint context manifest、IndexRevision retention、ACL/Secret-aware selection、敏感片段 redaction、可复现 ContextPack rebuild | restore 后在权限允许范围内重建等价上下文且不泄漏 Secret |
| AgentToolPool + Agent | 审批感知/可暂停 Agent、Definition 签名与来源、风险/权限声明、ACTIVE/DEPRECATED/REVOKED、restore compatibility | 被撤销定义不能启动新运行；既有 checkpoint 按策略恢复或明确失败 |
| Observability + UI | Review/Checkpoint 操作面、OTel、audit、Prometheus/Grafana、故障注入 | 一条 correlation 链可还原暂停、审批、恢复与执行事实 |

M4 Agent 可以提出 HumanReviewIntent、补充信息请求和安全替代方案，并在批准后从明确 AgentStep 恢复；它不能批准自己的请求或签发 Permit。新增 Tool/系统操作包括 checkpoint save/query/fork、review request/status、secret resolve、sandbox execute 和 retention verify，这些操作分别受 owner Port 和 Kernel 准入控制，不等同于普通模型函数调用。

### 7.4 增加的技术栈

- rootless Podman/Docker 或同等级 runtime。
- OpenTelemetry SDK/Collector、Prometheus、Grafana。
- Secret manager adapter、PostgreSQL retention/audit、Artifact retention。
- gVisor 仅在威胁模型和基准证明普通 rootless container 不足时引入。

### 7.5 验收要求

- M1–M3 回归全部通过。
- required participant 与 retention 全部 ACTIVE 后 SessionCheckpoint 才能 AVAILABLE。
- Restore 创建新 WorkflowRun，不继承旧 Grant、Lease、Secret、审批或 Executor 会话。
- resume、retry、replan、restore 身份和语义不混淆。
- 无有效审批的高风险动作绝不执行；参数/revision/策略/期限变化使旧批准失效。
- Checkpoint/Restore 后 ContextEngine 能按 manifest、ACL 和 IndexRevision 重建上下文，不泄漏已失效或无权来源。
- AgentToolPool 能阻止 REVOKED 定义启动新运行，并对 checkpoint 中的旧定义给出兼容恢复或结构化失败。
- Sandbox、网络、Secret、Artifact 越权测试通过；观测系统不是第二事实源。
- 可作为“可暂停、可审核、可长期恢复的安全 Agent 系统”合入 `main`。

### 7.6 验收任务

执行多任务仓库迁移，在首个并行阶段后创建 SessionCheckpoint 并关闭全部进程。重启后从 checkpoint fork 新 WorkflowRun，旧 Lease、Grant 和 Executor 会话必须失效。后续高风险命令持久等待人工批准；批准后 Kernel 重新校验并在 rootless container 执行。最终通过 QualityGate，并能从 audit/trace 还原 checkpoint、restore、review、permit 和执行因果链。

## 8. M5 / V1.0：完整 MultiAgentOS 平台

### 8.1 功能闭环

完整实现 `TargetArchitecture.md`：面向组织和多租户提供 Web、CLI、API、远程 Executor、动态 TaskGraph、协作式多 Agent、完整 HITL、长期恢复、生产级隔离、对象存储、可观测性与灾难恢复。扩缩容、节点故障、消息重复、人工等待和版本升级下仍保持单一事实源；全部生产验收通过后首次发布 MultiAgentOS V1.0。

### 8.2 增加的功能

- 多租户、组织/项目、OIDC、RBAC/ABAC、RLS、配额和公平调度。
- 远程 Executor 池、容量/亲和性、跨主机 workspace/materialization。
- GraphPatch/replan、revision barrier、`ANY/QUORUM` Join、协作式多 Agent。
- 完整 `INFORMATION/DECISION/APPROVAL/ACCEPTANCE` HITL、职责分离与多人审核。
- MCP、动态 Catalog、兼容求解和供应链治理。
- 语义检索、增量索引、ACL-aware retrieval、reranker 和重建协议。
- S3-compatible Artifact、版本化、ACL、retention、GC、PITR、跨区域灾备。
- React Web、SSE 投影、审核台、checkpoint/restore 与诊断界面。
- 多 Control Plane、高可用通信、滚动升级、旧运行封存。
- compensation/reconciliation、生产 SLO、容量、成本和安全响应。
- 用数据决定继续 DBOS 或经 durable runtime Port 迁移 Restate/Temporal。

### 8.3 模块增量与可拆分交付流

| 交付流 | 本阶段交付 | 可独立验收结果 |
|---|---|---|
| Workflow + Multi-Agent | 动态 GraphPatch、revision barrier、ANY/QUORUM、层级监督、委派/handoff、协作/竞争与 compensation | 多种 Agent 拓扑在 revision、取消、失败和恢复下保持单一业务状态 |
| Kernel + Remote Execution | 多租户策略、远程调度、容量/亲和性、远程 Permit/Lease/fencing、配额和成本治理 | 跨主机接管不接受旧执行结果，租户资源和 Secret 不越界 |
| ContextEngine + Memory | keyword/vector/symbol/graph hybrid retrieval、reranker、压缩、多级记忆、多模态、ACL、个性化与可删除性 | 固定评测集证明质量/成本，并验证租户隔离、来源和删除传播 |
| AgentToolPool + Ecosystem | 动态 Catalog、MCP/OpenAPI/function Tool、模型路由、能力/依赖求解、签名、灰度、回滚、组织发布、评测与推荐 | 不兼容/不可信组件无法解析；升级可灰度和回滚，运行固定版本可复现 |
| Experience + Platform | Web/SSE、完整 HITL、组织治理、S3、HA messaging、多 Control Plane、PITR/DR、SLO | 多租户生产场景在升级、故障、审批和灾备下闭环 |

M5 的通用 Agent 能力至少覆盖以下可组合模式，而不是为每个模式建立新的状态权威：

- **推理与执行**：ReAct、Plan-and-Execute、结构化 function calling、流式输出、长任务分段执行。
- **路由与委派**：Router、Supervisor/Worker、层级 Agent、能力路由、handoff/delegation、并行 fan-out/fan-in。
- **质量改进**：Critic/Reviewer、Reflection、自我纠错、候选方案比较、辩论/投票；所有结论仍由 Workflow 验收。
- **协作与人类控制**：共享目标下的协作、信息请求、决策、审批、结果验收、多人审核和职责分离。
- **记忆与上下文**：working memory、episodic memory、semantic memory、procedural memory、用户/项目偏好；全部具有 owner、来源、ACL、retention 和删除语义。
- **模型能力**：多 Provider/多 Model 路由、fallback、成本/延迟/质量策略、结构化输出、多模态输入输出和上下文窗口适配。
- **工具生态**：内置 Tool、MCP、OpenAPI/function、本地/远程 Tool、异步长任务 Tool、事件订阅；统一权限、凭据、幂等、effect、审批、配额、审计和可观测性。
- **评测与治理**：离线 benchmark、在线质量/成本指标、prompt/model/tool 版本对比、回归、灰度、撤销、供应链证明和组织策略。

AgentToolPool 在 M5 形成 Agent、Model、Prompt、Tool、Contract、PolicyRequirement 和 EvaluationProfile 的统一版本目录，但不拥有运行实例、授权结论或业务状态。ContextEngine 形成检索与记忆平台，但不得把模型推断写成事实；所有 ContextItem 必须保留来源、revision、范围、检索方法和权限依据。

### 8.4 增加的技术栈

- OIDC Provider、PostgreSQL RLS、策略引擎 adapter。
- NATS 或经 ADR 选定的可靠消息系统。
- S3-compatible object storage。
- React、SSE、完整 Fastify `/v1` API。
- MCP SDK、向量存储/语义索引、reranker，产品选择由评测决定。
- 远程 rootless container；microVM 仅在威胁模型和数据要求时引入。
- 集中 OTel/Prometheus/Grafana/日志/告警；Restate/Temporal 条件引入。

### 8.5 验收要求

- M1–M4 回归通过，并完成向后兼容和滚动升级演练。
- `TargetArchitecture.md` 第 1–21 章的所有权、协议、路径、数据、安全、API、部署、测试和总验收均有证据。
- 租户数据、Artifact、Secret、审查者和资源不能跨界；越权测试通过。
- Control Plane、Executor、消息、数据库、对象存储故障不产生双重成功或接受旧 fencing。
- 动态 replan、多 Agent、完整 HITL、restore、compensation、drain 可组合工作。
- 通用 Agent 模式、MCP/OpenAPI/远程 Tool 和多模型路由均通过统一 Definition/Contract/Policy 解析，不形成旁路运行时。
- ContextEngine hybrid retrieval 与多级记忆达到固定质量/成本基线，并通过 provenance、ACL、retention、删除传播和租户隔离测试。
- AgentToolPool 的签名、依赖求解、评测、灰度、撤销和回滚能在不破坏既有运行的情况下完成。
- PITR、对象版本化、故障转移、滚动升级和灾备达到公布的 SLO/RPO/RTO。
- 安全审查、性能/成本基线、运维、值班、回滚方案齐备，可作为生产平台合入 `main`。

### 8.6 验收任务

两个租户同时经 Web/API 提交跨仓库升级任务。Planner 动态生成图，多个远程 Agent 使用 MCP 和语义检索并行工作；注入 Executor 丢失、消息重复、Control Plane 滚动升级和 patch 冲突。生产发布须经职责分离的多人 APPROVAL，最终结果还须 ACCEPTANCE。新节点接管后必须拒绝旧 fencing，完成集成、QualityGate、补偿和 drain，生成租户隔离的 Artifact/审计。随后从 SessionCheckpoint fork 并执行 PostgreSQL/Object Store 灾备恢复；恢复前后因果链与权限一致，另一租户无法观察任何数据。该任务通过即证明完整 TargetArchitecture 闭环。

## 9. 不可回退约束

```text
M1 单 Agent 可运行
  -> M2 单 Agent 可恢复
    -> M3 多任务可并行并确定性集成
      -> M4 可长期恢复、可审批、有强安全边界
        -> M5 多租户、远程、多 Agent、生产化完整平台
```

- UserInteraction 拥有人类输入；Workflow 决定业务可执行性和成功；Kernel 决定准入与物理执行。
- ContextEngine 只生成带来源的上下文；AgentToolPool 只拥有版本化定义；Executor 不判断业务成功。
- DBOS/替代 runtime、消息、数据库和观测系统都不是第二业务事实源。
- 跨边界只传版本化 Contract 与 ArtifactRef；Secret 和 owner 内部状态不得泄漏。
- 重试具有明确 Attempt；旧 Lease/fencing、审批和 revision 结果不得推进新状态。
- 每个 M 合入 `main` 后都必须保持可运行，不得用长期目标为当前假成功辩护。

## 10. 每个 M 的发布 PR 清单

1. 目标设计、需求版本、范围内/外清单。
2. 功能、协议、数据、migration、配置和依赖变更。
3. 自动化测试、验收任务、性能、安全与故障报告。
4. 升级、兼容、回滚、备份恢复和旧运行处理方案。
5. 运行手册、监控告警、已知限制和下一 M backlog。
6. 对本计划共同发布门的逐项签字。
