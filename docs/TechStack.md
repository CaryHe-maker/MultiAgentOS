# AgentOS 技术栈报告

> 文档状态：暂定技术基线，可随原型和基准结果调整  
> 评估日期：2026-09-16  
> 项目目标：构建一个以进程、线程、资源、权限、调度和检查点为核心抽象，支持多任务、多 Agent 并行执行，并且可恢复、可审计、可扩展的 AgentOS。

> 范围说明：本文同时记录当前与目标技术选项。当前 M1/V1 依赖和实施范围以 `docs/DesignReport/TargetM1.md` 为准，首月顺序以 `docs/DesignReport/M1AchievePlan.md` 为准；本文列出的完整 Phase、依赖矩阵和候选技术不自动进入当前完成定义。

## 1. 暂定推荐组合

### 1.1 推荐技术栈

```text
TypeScript + Node.js LTS
+ 自有 AgentOS Domain / Task Graph / Scheduler / Capability
+ DBOS Durable Workflow
+ PostgreSQL + pgvector + transactional outbox
+ Fastify + TypeBox/Ajv + OpenAPI + SSE
+ MCP + Vercel AI SDK + LiteLLM Proxy
+ Git worktree + rootless Docker/Podman
+ S3-compatible Artifact Store
+ ripgrep + Tree-sitter + SCIP + PostgreSQL FTS/pgvector
+ 可选 BGE/Qwen3 Reranker Python sidecar
+ OpenTelemetry Collector + Prometheus/Grafana
```

这是当前推荐的目标技术栈，不等于 V1 依赖清单。V1 只启用 TypeScript/Node.js、PostgreSQL、DBOS、Kysely、最小 Fastify API、本地 CAS、Git workspace 和结构化日志；模型 SDK/Gateway、MCP、容器沙箱、语义检索、对象存储、完整可观测平台与 Web UI 按 V1.1/Beta 的验证结果引入。DBOS 复用 PostgreSQL 提供持久控制流，AgentOS 自己保留任务图、资源准入、集成、恢复和 Artifact 等领域语义。

选择该组合的主要原因：

- 基础设施数量较少，适合先完成端到端纵向切片；
- PostgreSQL 同时承载领域状态、DBOS、outbox 和初期向量检索，降低早期运维成本；
- AgentOS 的公共协议不绑定 DBOS，可在后期替换为 Restate 或 Temporal；
- 不在 V1 过早部署 NATS、Redis、独立向量数据库、Kubernetes 或双重 Graph runtime；
- TypeScript 控制面可通过 Python sidecar 使用成熟的 embedding/rerank 推理生态。

### 1.2 总体架构

```text
CLI / Web UI / Public API
            |
Fastify Control Plane
Auth · Policy · Planner · Scheduler · Context · Integrator
            |
AgentOS Domain
Process · Thread · TaskGraph · Lease · Artifact · Approval
            |
DBOS Durable Runtime
Workflow · Step · Queue · Signal · Recovery
            |
Worker Runtime
Sandbox · Git worktree · MCP Tools · Model Invocation
            |
PostgreSQL · Object Store · Code Index · LiteLLM
            |
OpenTelemetry · Metrics · Traces · Logs · Audit · Evaluation
```

### 1.3 各技术的作用

| 技术或组件 | 在 AgentOS 中的作用 |
|---|---|
| TypeScript + Node.js LTS | 控制面、调度器、worker SDK、MCP、CLI 和 Web API 的主运行时。 |
| AgentOS Domain | 定义 Process、Thread、TaskGraph、ResourceLease、Capability、Checkpoint、Artifact 和 Approval，是系统的稳定核心。 |  
| DBOS | 负责 durable workflow、step 重试、恢复、队列、消息和流式值；不负责 AgentOS 的业务调度策略。 |
| PostgreSQL | 保存 run、process、thread、attempt、lease、checkpoint、审批、usage 和审计 metadata，是控制面事实源。 |
| pgvector | PostgreSQL的扩展件，保存可重建的 embedding 派生索引，支持早期语义检索。 |
| transactional outbox | 保证状态变化与待发布事件在同一个数据库事务中提交，避免数据库与消息系统双写不一致。 |
| Fastify | 暴露控制面 HTTP API；配合 OpenAPI、SSE 和 WebSocket 提供调用与实时状态。 |
| TypeBox + Ajv | 以 JSON Schema 为中心定义和校验跨进程、跨语言契约。 |
| MCP | Agent 与外部工具、服务和数据源之间的标准协议。 |
| Vercel AI SDK | TypeScript 应用内的模型调用、结构化输出、tool calling 和 streaming 抽象。 |
| LiteLLM Proxy | 统一多家模型接口，提供 provider 路由、fallback、预算、虚拟 key 和成本记录。 |
| Git worktree | 为并行 coding worker 提供独立代码工作区，降低写入冲突。 |
| rootless Docker/Podman | 隔离 worker 执行环境，限制文件、进程、网络和硬件资源。 |
| S3-compatible storage | 保存不可变的大型 artifact，例如 diff、日志、测试报告、快照和模型原始输出。 |
| ripgrep | V1 的路径、标识符和文本搜索。 |
| Tree-sitter | 增量语法解析、结构化分块和 AST/CST 信息提取。 |
| SCIP | 提供跨文件 definition、reference 和 implementation 等精确符号关系。 |
| PostgreSQL FTS + pgvector | 组合词法与语义召回；结果经过融合、ACL、版本和 token 预算过滤。 |
| BGE/Qwen3 Reranker | 对小批候选上下文进行第二阶段重排；属于可选增强组件。 |
| OpenTelemetry | 统一生成 metrics、logs 和 traces，并关联 run/process/thread/tool/model 调用。 |
| Prometheus + Grafana | 保存、查询和展示系统指标与告警。 |

### 1.4 各技术栈实现顺序

以下 Phase 仅表示技术实现顺序，不限定系统架构、服务划分或部署方式。

#### Phase 1：基础工程与数据契约

- 建立 TypeScript、Node.js LTS 和 pnpm workspace。
- 配置 lint、类型检查和基础测试。
- 使用 TypeBox、Ajv 和 JSON Schema 定义核心数据契约。
- 接入 PostgreSQL、数据访问层和 migration。
- 实现本地内容寻址 Artifact Store。

#### Phase 2：单 Worker 持久执行

- 接入 DBOS，并明确 DBOS workflow 与领域事务/outbox 的桥接边界。
- 实现静态 TaskGraph、确定性脚本 Worker、UnitIntent/UnitAttempt 和 `ALL` Join。
- 实现 Inbox、transactional outbox、有限 retry/cancel、最小 Lease/fencing。
- 通过 kill/restart 验证恢复不会重复提交结果。

#### Phase 3：双 Worker 与 Git 集成

- 为最多两个 Worker 创建隔离 Git workspace。
- 实现路径 ownership 预检、ChangeSet、IntegrationPlan 和 IntegrationAttempt。
- 在干净集成 workspace 中确定性应用 patch/commit，并运行测试质量门。
- 输出 IntegratedRevision、diff、测试证据与冲突分类。

#### Phase 4：准入、完成与恢复

- 实现本地路径白名单、资源/运行时间上限和单人 `APPROVAL`。
- 实现完成候选、Kernel drain、Workflow 最终提交的两阶段完成协议。
- 实现简化 SessionCheckpoint、RestoreOperation/RestorePlan 和跨 Module 恢复结果。
- 恢复时创建新 WorkflowRun/DBOS execution，并重新签发 Grant、Lease 与执行许可。

#### Phase 5：V1 操作面与验收

- 使用 Fastify 实现 CLI 所需的最小控制 API。
- 实现 create/run/cancel/approve/checkpoint/restore/inspect/report CLI。
- 使用路径、`ripgrep` 和 ArtifactRef 装配上下文。
- 完成固定 fixture、崩溃、重复消息、Git 冲突、恢复和小规模性能测试。

#### Phase 6：V1.1 真实 Agent

- 接入 Vercel AI SDK 和单一模型 Provider；需要统一网关时再部署 LiteLLM。
- 实现 Bootstrap Planner 与真实 coding Agent，但复用 V1 的 Task、Unit、ChangeSet、IntegrationPlan 和 RestorePlan 契约。
- 建立单 Agent/双 Agent 的质量、token、成本、延迟和冲突基线。

#### Phase 7：Beta/Production 增强

- 按评测引入 MCP、rootless Docker/Podman、Tree-sitter、SCIP、FTS/pgvector 和 reranker。
- 按运行规模引入 OTel Collector、Prometheus/Grafana、Web UI、对象存储或独立消息系统。
- 完成多租户、安全供应链、容量、灾备和更强隔离。

### 1.5 核心设计边界

以下部分应由 AgentOS 自己定义，不应直接暴露为某个框架的内部对象：

- WorkSession、WorkflowRun、MissionScope、TaskGraph、TaskAttempt、UnitAttempt 和状态机；
- 资源目录、优先级、公平性、配额、租约和 API 并发调度；
- capability、策略判定、人工审批和审计事件；
- Artifact、Checkpoint、ContextPack、证据与 provenance；
- 文件 ownership、Git workspace、ChangeSet、IntegrationPlan、质量门与 IntegratedRevision；
- RestoreOperation、RestorePlan、跨 Module RestoreAction/RestoreActionResult 和新运行 ID 映射；
- workflow、broker、provider、sandbox 和 retrieval 的适配接口。

Durable Workflow 与 Agent Graph 必须分层：DBOS 负责同一 execution 的控制流重放；Workflow 负责业务图和 Checkpoint 的恢复语义；Kernel 负责恢复准入与物理动作；各 Module 只恢复自己拥有的状态。自有 Task Graph 不重复实现 durable replay，DBOS 也不得替代跨 Module RestorePlan。

## 2. 推荐依赖矩阵

### 2.1 实现策略说明

- **采用开源**：直接使用成熟项目，只编写配置和薄适配层。
- **自研核心**：属于 AgentOS 的差异化领域能力，需要自主设计和测试。
- **混合实现**：底层依赖开源基础设施，上层语义和安全边界由 AgentOS 实现。

### 2.2 依赖与自研范围

| 能力 | 暂定选型 | 实现策略 | AgentOS 需要负责的部分 |
|---|---|---|---|
| 主语言与运行时 | TypeScript + Node.js LTS | 采用开源 | 编码规范、包边界、版本策略。 |
| Monorepo | pnpm workspace | 采用开源 | workspace 划分和发布规则。 |
| 领域契约 | JSON Schema + TypeBox + Ajv | 混合实现 | Process/Thread/Event/Artifact/Policy 等 schema 及兼容策略。 |
| HTTP API | Fastify + OpenAPI + SSE | 混合实现 | API 资源模型、错误码、游标、审批和实时事件语义。 |
| Durable Workflow | DBOS | 混合实现 | workflow adapter、step 边界、幂等键、版本与恢复策略。 |
| Agent Graph | 自有 Task Graph API | 自研核心 | DAG、动态扩图、状态 reducer、依赖、ownership 和验收条件。 |
| Scheduler | 自有 scheduler | 自研核心 | 优先级、公平性、预算、依赖释放、资源租约和取消传播。 |
| 工具协议 | MCP TypeScript SDK | 混合实现 | Tool Manifest、capability、超时、输出限制、审计和沙箱包装。 |
| Agent 间协议 | 内部 JSON Schema；未来 A2A | 混合实现 | 内部任务、结果和 artifact 引用协议。 |
| 模型 SDK | Vercel AI SDK | 混合实现 | Provider Capability Registry、结构化输出和直连 adapter。 |
| LLM Gateway | LiteLLM Proxy | 采用开源 | 路由规则、预算同步、错误归一化和能力探测。 |
| 状态数据库 | PostgreSQL | 采用开源 | schema、事务边界、RLS、备份和数据保留。 |
| 数据访问 | `pg` + Kysely 或 Drizzle | 采用开源 | 二选一；migration 和查询约束。 |
| 向量索引 | pgvector | 采用开源 | chunk、ACL、版本、embedding provenance 和召回评测。 |
| 事件分发 | PG outbox / DBOS Queue | 混合实现 | event envelope、outbox dispatcher、幂等 consumer 和 dead-letter。 |
| Artifact Store | 本地 CAS -> S3-compatible | 混合实现 | manifest、SHA-256、ACL、provenance、GC 和生命周期。 |
| 代码检索 | rg + Tree-sitter + SCIP + PG FTS/pgvector | 混合实现 | 增量索引、查询融合、代码图扩展、ACL 和 ContextPack。 |
| Rerank | BGE/Qwen3 sidecar，可选 | 采用开源 | 统一接口、候选裁剪、模型基准和降级策略。 |
| Workspace | Git worktree | 混合实现 | 创建/销毁、ownership、diff、集成和冲突管理。 |
| Sandbox | rootless Docker/Podman | 混合实现 | SandboxProvider、profile、网络、挂载、配额和销毁保证。 |
| AuthN | OIDC/OAuth 2.1 | 混合实现 | 用户、service identity 和 session 绑定。 |
| Policy/AuthZ | 类型化规则；复杂后采用 OPA | 自研核心 + 开源引擎 | capability、Policy Enforcement Point、审批与 decision log。 |
| Secrets | OS keyring -> Vault/云 Secret Manager | 采用开源/外部服务 | 短期凭据派生、注入、脱敏和吊销。 |
| Observability | OTel + Collector + Prometheus/Grafana | 混合实现 | 内部事件语义、trace 关联、脱敏、采样和 retention。 |
| LLM 可观测性 | Langfuse，可选 | 采用开源 | 与系统 trace、dataset 和评测结果关联。 |
| CLI/Web | Commander/oclif + React | 混合实现 | AgentOS 操作模型、DAG、审批、diff 和报告界面。 |
| 测试 | Vitest、fast-check、Testcontainers、Playwright | 混合实现 | 状态机不变量、故障恢复、E2E 和固定任务集。 |
| 性能/故障注入 | k6 + Toxiproxy | 混合实现 | 压测模型、kill/replay/重复消息/租约过期场景。 |
| 部署 | Docker Compose -> 现有编排平台 | 混合实现 | 配置、升级、备份、PITR、RPO/RTO 和灾难恢复。 |
| 供应链 | Renovate、Trivy/OSV、Syft、Cosign | 采用开源 | 依赖策略、SBOM、许可证、签名和准入规则。 |
## 3. 其他可行方案

推荐组合并不是唯一可行路线。以下方案适用于不同阶段或约束。

### 3.1 Restate 服务化方案

```text
TypeScript + 自有 Task Graph/Scheduler
+ Restate Workflow/Virtual Objects
+ PostgreSQL/pgvector
+ MCP + AI SDK + LiteLLM
+ S3-compatible Artifact Store
+ Docker/Podman -> gVisor
+ OpenTelemetry
```

将 Process、provider quota 和 workspace lease 映射为 key-addressable Virtual Object，run 映射为 workflow。Restate 负责 durable call、定时器、信号和恢复。它适合远程 worker 和服务化架构，但会增加独立运行时，并需要处理 Restate 与领域数据库之间的状态边界。

### 3.2 Temporal 生产可靠性方案

```text
TypeScript + Temporal
+ 自有 Task Graph/Scheduler/Policy
+ PostgreSQL/pgvector + NATS JetStream
+ S3-compatible Artifact Store
+ MCP + LiteLLM/Provider adapters
+ gVisor 或托管 microVM
+ OTel + Prometheus/Grafana/Tempo
```

Temporal workflow 编排确定性控制流，模型、Git、sandbox、MCP 和外部 API 作为 activity。该方案适合跨机器、持续数天和恢复要求高的生产任务，但组件、运维和 workflow versioning 成本最高。Temporal 与 NATS 不得共同决定任务状态。

### 3.3 LangGraph Agent 原型方案

```text
TypeScript + LangGraph.js
+ PostgreSQL checkpointer/store
+ 自有外层 Scheduler/Policy/Sandbox adapter
+ MCP + LiteLLM
+ PostgreSQL/pgvector + Artifact Store
+ OpenTelemetry/Langfuse
```

可以快速获得 graph、checkpoint、interrupt 和 streaming，适合验证 Planner/Worker/Reviewer/Integrator 交互。它不会自动提供全局资源调度、多租户 capability、worktree 集成和完整生产运维；LangGraph checkpoint schema 不应成为 AgentOS 公共协议。

### 3.4 Durable Workflow + LangGraph 双层方案

```text
DBOS / Restate / Temporal（外层 Process 与跨 Agent 编排）
+ LangGraph.js（单 Agent 内部 reasoning/tool loop）
+ PostgreSQL + MCP + LiteLLM + Sandbox
```

仅当单 Agent 内部确实需要复杂循环、分支或 HITL 时采用。外层 durable runtime 必须是唯一恢复所有者，内层 LangGraph 不再独立重试外部副作用。该方案容易产生双重重试、取消传播失败和两个 thread ID 体系，首版不推荐。

### 3.5 完全自研 Graph Executor 方案

```text
TypeScript + Fastify
+ 自有 Task Graph Executor / Lease Scheduler / Checkpoint
+ PostgreSQL transactional outbox
+ NATS JetStream
+ MCP + LiteLLM + Sandbox + OTel
```

该方案最贴合 AgentOS 的 OS 语义，但必须自行覆盖 crash recovery、timer、signal、cancel、retry、compensation、versioning、dead-letter 和 replay。只有现有 durable runtime 经原型证明无法表达核心语义时才应采用。

## 4. 各组件选型说明

### 4.1 语言、契约与 API

**推荐组合：TypeScript + Node.js LTS + TypeBox/Ajv + Fastify。**

TypeScript 适合控制面、MCP、流式 API 和前端类型共享。Node.js 跟随 LTS 版本并开启 `strict`。JSON Schema 作为跨语言契约，TypeBox 负责类型和 schema，Ajv 负责运行时校验，Fastify 负责 HTTP/OpenAPI/SSE。

| 选择 | 优点 | 缺点或限制 | 适用情况 |
|---|---|---|---|
| TypeScript + Node.js | 工具和 Web 生态统一；异步 I/O 和 streaming 成熟；类型可共享。 | CPU 密集型任务需 worker/sidecar；类型不能代替运行时校验。 | **推荐主运行时。** |
| Python | AI/ML 和推理生态强；Agent 框架多。 | 大型控制面的类型和并发治理成本更高；与当前 TypeScript 方向冲突。 | 推理、数据处理 sidecar。 |
| Rust/Go | 性能和单文件部署好，适合 supervisor。 | 开发速度和跨语言成本较高。 | 后期高性能 worker/sandbox 管理。 |
| TypeBox + Ajv | JSON Schema 原生，适合 Fastify 和跨语言契约。 | API 比 Zod 更偏 schema。 | **推荐契约层。** |
| Zod | TypeScript 开发体验好、生态广。 | 若同时维护独立 JSON Schema 容易出现双事实源。 | 可以整体替换 TypeBox，不应并存为权威 schema。 |

### 4.2 Durable Workflow

**推荐组合：DBOS。**

DBOS 以 PostgreSQL 为底座提供 workflow、step、queue、消息、事件和 stream，适合用较少组件完成早期纵向闭环。AgentOS 仍需定义自己的状态机、幂等键和 workflow adapter。

| 选择 | 优点 | 缺点或限制 | 适用情况 |
|---|---|---|---|
| [DBOS](https://docs.dbos.dev/) | TypeScript SDK；普通函数式 API；无需独立 workflow server；复用 PostgreSQL；支持通信与 streaming。 | 依赖 PostgreSQL；跨地域、超长历史和大规模版本迁移需要验证。 | **推荐 V1/Beta。** |
| [Restate](https://docs.restate.dev/) | durable execution、Virtual Object、强一致状态、可靠调用和并行组合完整。 | 需要 Restate Server；代码需遵守其 handler/context 原语。 | 服务化 Beta/Production。 |
| [Temporal](https://docs.temporal.io/) | 长任务、信号、定时器、跨机器 worker、恢复和版本演进成熟。 | 集群和心智成本最高；确定性重放约束严格。 | 高可靠生产阶段。 |
| [Hatchet](https://docs.hatchet.run/) | 自托管；TypeScript SDK；队列、并发、速率限制、重放和 UI 完整。 | 与 AgentOS scheduler 职责重叠；需要验证生态与迁移成本。 | 备选或对照实验。 |
| 完全自研 | 完全符合 Process/Thread 语义。 | 故障恢复、租约、定时器、取消和版本演进成本极高。 | 只自研领域状态机，不推荐首版自研 engine。 |

### 4.3 Agent Graph

**推荐组合：自有 Task Graph API，执行映射到 DBOS。**

自有图模型可以原生表达 Thread/Process、资源租约、capability、artifact、动态扩图、路径 ownership 和验收条件，同时避免公共协议被第三方框架锁定。

| 选择 | 优点 | 缺点或限制 | 适用情况 |
|---|---|---|---|
| 自有 Task Graph | 与 AgentOS 领域模型一致；后端可替换。 | 需要实现图校验、reducer、动态扩图、并发合并和版本化。 | **推荐稳定领域层。** |
| [LangGraph.js](https://github.com/langchain-ai/langgraph) | 状态图、并行、checkpoint、interrupt/HITL 和 streaming 完整。 | 节点可能重执行；与 DBOS/Restate/Temporal 叠加会产生双重恢复语义。 | 快速原型或不持久化的内层 Agent loop。 |
| [GraphAgent](https://github.com/llm-graph/graphagent) | TypeScript、轻量、函数式、类型安全，提供 fork/join 和 batch。 | 社区较小；缺少 durable persistence、租约、HITL 和生产运维。 | 借鉴 API 或纯内存子图。 |

### 4.4 工具协议和 Agent 间协议

**推荐组合：MCP + 内部 JSON Schema；A2A 作为未来扩展。**

MCP 负责工具互操作，不负责授权。每次调用必须经过 capability、schema、超时、输出大小、网络、敏感信息和审计检查。

| 选择 | 优点 | 缺点或限制 | 适用情况 |
|---|---|---|---|
| [MCP](https://modelcontextprotocol.io/specification/) | 工具生态成熟；标准化 tools/resources/prompts；TypeScript SDK 完整。 | tool 描述会增加上下文；存在 OAuth、SSRF、session 和本地 server 执行风险。 | **推荐工具协议。** |
| 内部 JSON Schema | 简单、可版本化、可严格限制字段和大小。 | 需要自行维护兼容规则。 | **推荐内部 worker/控制面通信。** |
| [A2A](https://a2a-protocol.org/) | 支持独立 Agent 服务发现、任务和 artifact 交换。 | 对同一系统内的 worker 偏重；引入新的身份和安全边界。 | 未来跨组织、跨运行时协作。 |

MCP server 必须使用 allowlist、固定包或镜像 digest、OAuth audience 校验、egress policy、明确授权和沙箱。禁止直接把 MCP server 描述转换为权限。

### 4.5 LLM Gateway 和模型 SDK

**推荐组合：Vercel AI SDK + LiteLLM Proxy + 自有 Provider Capability Registry。**

AI SDK 提供 TypeScript 应用内抽象，LiteLLM 提供集中式多 provider 网关；自有能力目录记录 tools、JSON schema、vision、reasoning、stream、cache、上下文、地区和数据等级，避免 OpenAI-compatible 接口掩盖供应商差异。

| 选择 | 优点 | 缺点或限制 | 适用情况 |
|---|---|---|---|
| [LiteLLM Proxy](https://docs.litellm.ai/) | 多 provider、统一接口、fallback、预算、虚拟 key、成本和限流。 | 高级功能需要 PostgreSQL/Redis；部分 provider 特性无法完全归一化。 | **推荐集中 gateway。** |
| [Vercel AI SDK](https://ai-sdk.dev/) | TypeScript 结构化输出、tools、streaming 和 middleware 体验好。 | 它是应用 SDK，不是跨团队网关和账单事实源。 | **推荐应用内 SDK。** |
| Provider 直连 | 完整使用 Responses、cache、reasoning、batch 等专有能力。 | adapter 和错误处理数量增加。 | 作为高级能力旁路和故障降级。 |
| 完全自研 Gateway | 可完全控制协议和策略。 | 重复建设 provider 适配、价格、错误映射和兼容测试。 | 不推荐。 |

网关性能应通过 TTFT、吞吐、SSE 连接数、P95/P99、数据库开销和故障转移进行基准测试，不预设性能结论。

### 4.6 数据库、缓存、迁移和 Artifact

**推荐组合：PostgreSQL + pgvector + `pg`/Kysely + S3-compatible storage。**

PostgreSQL 是状态和审计 metadata 的事实源；pgvector 是可删除重建的语义索引；大对象进入内容寻址对象存储。控制面、DBOS 和检索使用独立 schema、连接池与资源配额。

| 选择 | 优点 | 缺点或限制 | 适用情况 |
|---|---|---|---|
| PostgreSQL | 事务、锁、JSONB、RLS、FTS、复制和运维生态完整。 | 检索和高频状态写入共库时需隔离负载。 | **推荐核心数据库。** |
| pgvector | 与 PostgreSQL 共用事务和 ACL；支持 exact、HNSW、IVFFlat、量化和扩展。 | HNSW 内存、构建、VACUUM 和带过滤 ANN 需要调优；不是无限扩展。 | **推荐初期向量索引。** |
| Qdrant/Milvus | 独立扩展和向量功能更丰富。 | 新增系统、同步和 ACL 边界。 | 基准证明 pgvector 不足后使用。 |
| Kysely | 轻量、类型安全、接近 SQL。 | 需要主动维护 migration 和关系约束。 | **推荐 query layer 候选。** |
| Drizzle | Schema 和 migration 生态完整。 | 与 Kysely 并用会形成两套数据访问方式。 | 可整体替换 Kysely。 |
| Redis | 低延迟缓存、计数和分布式限流。 | 不是任务事实源；增加一致性和持久化配置。 | 多实例确有共享低延迟状态时引入。 |
| S3-compatible storage | 大对象、生命周期、版本和容量扩展成熟。 | metadata 事务和对象写入不是原子操作。 | **推荐 Artifact Store。** |

Artifact 采用 SHA-256、不可变对象和 provenance。先写对象并校验 hash，再提交数据库引用；垃圾回收器处理孤儿对象。迁移任务必须串行、带 advisory lock，并采用可回滚或 forward-fix 策略。
### 4.7 Event Bus、队列和 Scheduler

**推荐组合：PostgreSQL outbox + DBOS Queue；规模增长后迁移到 NATS JetStream。**

AgentOS 自研事件 schema、outbox、幂等消费和调度策略，不自研网络 broker。Event Bus 用于通知和分发，PostgreSQL 仍是任务状态事实源。

| 选择 | 优点 | 缺点或限制 | 适用情况 |
|---|---|---|---|
| PG outbox + 进程内 emitter | 状态和事件同事务；组件最少；容易重放。 | 吞吐和多消费者能力有限；需自建 dispatcher。 | **推荐单机 V1。** |
| DBOS Queue/Messaging | 与推荐 workflow 集成；支持 durable queue、消息和 stream。 | 与 DBOS 绑定；领域 audit 仍需单独保存。 | **推荐 DBOS 方案。** |
| [NATS JetStream](https://docs.nats.io/nats-concepts/jetstream) | 持久 stream、durable consumer、ack、重投递、replay；运维较轻。 | 至少一次投递会产生重复；需要新集群。 | 团队 Beta/Production。 |
| Redis Streams | consumer group、pending/claim 和 replay；已有 Redis 时方便。 | 单 stream 不自动跨实例分片；内存和持久策略需谨慎。 | 已有 Redis 基础设施。 |
| Kafka/Redpanda | 大吞吐、长保留、多个下游和数据平台生态。 | 对早期项目过重。 | 超大事件平台或已有集群。 |

事件 envelope 至少包含 `event_id`、`aggregate_id`、`aggregate_version`、`causation_id`、`correlation_id` 和 schema version，并配套幂等 consumer、dead-letter、poison message 和重放边界。

Scheduler 是 AgentOS 自研核心，负责 DAG 依赖、优先级、weighted fairness、tenant quota、deadline、provider RPM/TPM、CPU/GPU、路径冲突、heartbeat、lease TTL 和 fencing token。普通消息队列不能自动完成这些工作。

### 4.8 代码索引、检索和 Rerank

**推荐组合：ripgrep + Tree-sitter + SCIP + PostgreSQL FTS/pgvector + 可选 Reranker。**

```text
Git revision / file watcher
  ├─ 路径、标识符、substring/regex：ripgrep -> Zoekt
  ├─ 语法结构：Tree-sitter
  ├─ 精确符号关系：SCIP indexer / Language Server
  ├─ 词法召回：PostgreSQL FTS
  └─ 语义召回：embedding + pgvector
             -> RRF/加权融合 -> 可选 reranker
             -> ACL/版本/token 裁剪 -> ContextPack
```

| 选择 | 优点 | 缺点或限制 | 适用情况 |
|---|---|---|---|
| ripgrep | 无服务、快速、精确，适合路径和文本检索。 | 不提供持久索引、语义或精确符号图。 | **推荐 V1 词法搜索。** |
| [Tree-sitter](https://tree-sitter.github.io/tree-sitter/) | 增量解析、容错好、语言覆盖广，适合结构化分块。 | 生成 concrete syntax tree，不等于跨文件语义分析。 | **推荐语法层。** |
| [SCIP](https://github.com/scip-code/scip) | 语言无关，可表达 definition/reference/implementation。 | 依赖各语言 indexer；本身不是搜索引擎。 | **推荐精确符号层。** |
| [Zoekt](https://github.com/sourcegraph/zoekt) | 面向源码的 trigram 索引，substring/regex 和多仓库性能好。 | 需要独立索引服务和同步。 | 多仓库或 `rg` 延迟不足时。 |
| PostgreSQL FTS | 与 ACL/版本数据共库，运维简单。 | 内置 ranking 不能直接等同 BM25。 | **推荐初期词法索引。** |
| ParadeDB/专用搜索引擎 | 可提供 BM25 和更完整的搜索能力。 | 增加扩展、同步和运维。 | 基准证明 FTS 不足时。 |
| pgvector | 语义召回与 metadata 过滤结合方便。 | 代码精确搜索不能只依赖 embedding。 | **推荐语义补充。** |

Rerank 只处理 top 20–50 候选，不是基础事实源：

| 模型 | 优点 | 缺点或限制 | 推荐方式 |
|---|---|---|---|
| [BGE-reranker-v2-m3](https://huggingface.co/BAAI/bge-reranker-v2-m3) | 约 0.6B、多语言、Apache-2.0、部署成本较低。 | 仍有推理延迟；代码检索效果需真实基准。 | **默认轻量候选。** |
| [Qwen3-Reranker-0.6B](https://github.com/QwenLM/Qwen3-Embedding) | 支持多语言、代码检索和 instruction，成本低于 4B。 | 吞吐和硬件仍需测量。 | 与 BGE 做首轮对比。 |
| [Qwen3-Reranker-4B](https://huggingface.co/Qwen/Qwen3-Reranker-4B) | 32K 上下文、代码检索和长文本能力强。 | GPU、延迟和并发成本明显更高。 | 只有质量增益覆盖成本时使用。 |

统一测量 Recall@k、MRR/nDCG、引用正确率、P95、token 节省和每查询成本。Python 推理通过 vLLM、TEI 或 HTTP sidecar 暴露，TypeScript 只依赖统一接口。

### 4.9 Workspace 和 Sandbox

**推荐组合：Git worktree + rootless Docker/Podman；高风险任务升级到 gVisor 或托管 microVM。**

| 选择 | 优点 | 缺点或限制 | 适用情况 |
|---|---|---|---|
| Git worktree + 受限 subprocess | 启动快、开发简单、便于 diff 和合并。 | subprocess 不是安全边界，无法安全执行不可信代码。 | 可信开发者的本地原型。 |
| rootless Docker/Podman | OCI 生态成熟；可限制用户、capability、seccomp、CPU、内存和挂载。 | 共享宿主内核；Windows/macOS 依赖 VM/WSL2。 | **推荐本地/Beta 默认。** |
| [gVisor](https://gvisor.dev/docs/) | 用户态 application kernel，隔离强于普通容器，可接入 Docker/Kubernetes。 | syscall 兼容性和性能开销需验证。 | 不可信代码和生产 worker。 |
| [Firecracker](https://firecracker-microvm.github.io/) | 独立内核、microVM 隔离、启动快、资源开销低。 | 需要 Linux/KVM、镜像、网络、snapshot 和容量平台。 | 成熟生产平台，不建议 V1 直接自建。 |
| [E2B](https://e2b.dev/docs) | 托管 microVM、TypeScript SDK、快速启动和弹性扩展。 | 成本、数据边界、外部依赖及部署条款需核验。 | 希望快速使用云端强隔离。 |

所有后端实现统一 `SandboxProvider`：create、exec、upload/download、snapshot、pause/resume、network policy、metrics 和 destroy。默认无网络、无宿主密钥、只挂载授权路径，并限制 PID、CPU、内存、磁盘和执行时间。

### 4.10 身份、权限、策略和密钥

**推荐组合：OIDC + AgentOS capability + 类型化策略；复杂后引入 OPA；密钥由 OS keyring/Vault 管理。**

| 选择 | 优点 | 缺点或限制 | 适用情况 |
|---|---|---|---|
| OIDC/OAuth 2.1 | 标准身份和短期 token，可对接企业 IdP。 | 不能直接表达 Agent 的资源和工具权限。 | **推荐 AuthN。** |
| AgentOS capability | 可绑定 tenant/project/run/process/tool/path、范围和过期时间。 | 令牌签发、吊销、委托和审计需自主实现。 | **推荐执行授权核心。** |
| 类型化 allow/deny 规则 | 简单、低延迟、容易单元测试。 | 复杂策略会散落在代码中。 | **推荐 V1 Policy。** |
| [OPA](https://www.openpolicyagent.org/docs/) | 策略即代码、独立版本、测试和 decision log。 | 引入 Rego 和 sidecar；Policy Enforcement Point 仍需自己实现。 | 多租户和复杂属性策略。 |
| OS keyring | 本地使用简单，避免明文配置。 | 不适合分布式 worker 和统一轮换。 | **推荐本地开发。** |
| Vault/云 Secret Manager | 集中管理、轮换、审计和短期凭据。 | 新的运维和云依赖。 | 团队和生产环境。 |

高风险动作进入持久 approval queue，包含目标、影响、参数、diff、回滚和证据。审批有过期时间和 policy version；Agent 只能提出建议，不能自行扩大权限。worker 只获得短期派生凭据，长期 key 不进入 prompt、artifact 或日志。

### 4.11 Observability、审计和评测

**推荐组合：OpenTelemetry + Collector + Prometheus/Grafana；按需增加 Tempo/Loki/Langfuse。**

```text
OTel SDK -> OTel Collector
  ├─ Metrics -> Prometheus -> Grafana/Alertmanager
  ├─ Traces  -> Tempo 或 Jaeger
  └─ Logs    -> Loki 或现有日志平台

LLM/Agent 分析（可选） -> Langfuse
审计/计费事实 -> PostgreSQL append-only 表 + Artifact Store
```

| 选择 | 优点 | 缺点或限制 | 适用情况 |
|---|---|---|---|
| [OpenTelemetry](https://opentelemetry.io/) | 跨供应商标准，统一 traces/metrics/logs 和上下文传播。 | 它不是存储和 UI；GenAI 语义仍可能演进。 | **推荐采集标准。** |
| Prometheus + Grafana | 指标、PromQL、dashboard 和告警生态成熟。 | 不适合作为精确计费或完整审计库。 | **推荐系统指标。** |
| Tempo/Jaeger + Loki | 分布式 trace 和日志关联。 | 增加存储、retention 和运维。 | 多服务 Beta/Production。 |
| [Langfuse](https://langfuse.com/docs) | LLM trace、prompt、dataset、experiment 和 evaluation 体验完整。 | 不能替代系统指标、权限审计和账单事实。 | 可选 Agent/LLM 分析层。 |

必须记录 run/process/thread/attempt、queue time、lease、checkpoint、provider/model、token/cost、TTFT、tool call、policy decision、sandbox resource、diff、测试和 artifact hash。prompt、工具参数、源代码和模型输出默认不完整写入 span，必须经过分级、脱敏、采样和 retention policy。

### 4.12 CLI、Web、测试、部署和供应链

**推荐组合：Commander/oclif + React；Vitest/Testcontainers/Playwright；Docker Compose 起步。**

- CLI 至少支持 plan、run、pause、resume、cancel、approve、replay、inspect 和 report。
- Web 展示 DAG、进程/线程树、队列、成本、trace、diff、artifact 和审批。
- 状态与模型流优先使用 SSE；交互式 terminal 使用 WebSocket；断线恢复依赖 event cursor。
- 单元和属性测试采用 Vitest + fast-check；集成测试使用 Testcontainers；E2E 使用 Playwright。
- 性能测试使用 k6；Toxiproxy 和随机 kill worker 验证断网、重复消息、租约过期和恢复。
- 本地使用 Docker Compose；只有存在真实集群需求时才采用 Kubernetes 或现有编排平台。
- 使用 lockfile、Renovate/Dependabot、Trivy/OSV、Syft 和 Cosign 管理更新、漏洞、SBOM 和签名。
- PostgreSQL 配置 PITR，对象存储设置版本和生命周期，并定期进行恢复演练。

## 5. 推荐演进顺序

1. **V1 协议与事实源**：冻结 Task、Unit、Event、Artifact、ChangeSet、IntegrationPlan、RestorePlan 和 Checkpoint schema，验证领域事务/outbox 原子性。
2. **V1 确定性纵向闭环**：静态图、一个再到两个脚本 Worker、隔离 workspace、Git 集成、质量门、单人审批、崩溃恢复和报告；不接真实模型。
3. **V1.1 Agent 能力**：接入单模型 Provider、Bootstrap Planner 和真实 coding Agent，用固定任务集比较单 Agent 与双 Agent 的质量、成本和延迟。
4. **Beta 安全与检索**：按风险和评测加入 rootless container、MCP 权限包装、Tree-sitter、SCIP、pgvector 和检索回归集；依据策略复杂度决定是否接入 OPA。
5. **服务化与生产强化**：出现远程 Worker、多控制面和多个独立消费者后再评估 NATS、对象存储、Restate/Temporal、强 Sandbox、企业 IdP、多租户与灾备。

升级必须由数据触发：数据库 P95、队列积压、恢复率、检索质量、sandbox 启动时间、并行收益、token 成本、冲突率和人工介入率都应设置阈值。

## 6. 优先验证项目

1. DBOS execution 与 PostgreSQL 领域事务/outbox 的桥接方式，以及 step 重放时的幂等边界。
2. Worker crash、取消、重复/迟到 Event、Lease 过期和 fencing 拒绝的组合故障。
3. 两个隔离 workspace 的 patch/commit 交付、确定性集成顺序、冲突分类和质量门失败恢复。
4. SessionCheckpoint 派生时 RestorePlan 的跨 Module 验证、物化、ID 映射和临时权限失效。
5. 完成候选与 Kernel drain 的握手，确保“任务成功但仍有活跃副作用”不能误报完成。
6. 真实 Agent 在 V1.1 固定任务集上的正确率、token、成本、延迟和并行收益。
7. MCP、容器隔离、语义检索、LiteLLM 和 OTel 平台能力在进入 Beta 前分别完成安全或收益验证。

## 7. 参考资料

- [DBOS](https://docs.dbos.dev/)
- [Restate](https://docs.restate.dev/)
- [Temporal](https://docs.temporal.io/)
- [LangGraph](https://github.com/langchain-ai/langgraph)
- [GraphAgent](https://github.com/llm-graph/graphagent)
- [Model Context Protocol](https://modelcontextprotocol.io/specification/)
- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices)
- [Agent2Agent Protocol](https://a2a-protocol.org/)
- [LiteLLM](https://github.com/BerriAI/litellm)
- [NATS JetStream](https://docs.nats.io/nats-concepts/jetstream)
- [Redis Streams](https://redis.io/docs/latest/develop/data-types/streams/)
- [PostgreSQL](https://www.postgresql.org/docs/current/)
- [pgvector](https://github.com/pgvector/pgvector)
- [Tree-sitter](https://tree-sitter.github.io/tree-sitter/)
- [SCIP](https://github.com/scip-code/scip)
- [Zoekt](https://github.com/sourcegraph/zoekt)
- [BGE Reranker](https://huggingface.co/BAAI/bge-reranker-v2-m3)
- [Qwen3 Reranker](https://huggingface.co/Qwen/Qwen3-Reranker-4B)
- [Docker Rootless Mode](https://docs.docker.com/engine/security/rootless/)
- [gVisor](https://gvisor.dev/docs/)
- [Firecracker](https://firecracker-microvm.github.io/)
- [Open Policy Agent](https://www.openpolicyagent.org/docs/)
- [OpenTelemetry](https://opentelemetry.io/docs/)
- [Prometheus](https://prometheus.io/docs/introduction/overview/)
- [Grafana Tempo](https://grafana.com/docs/tempo/latest/)
- [Langfuse](https://langfuse.com/docs)
