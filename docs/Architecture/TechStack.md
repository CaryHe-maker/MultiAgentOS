# MultiAgentOS 完整实现技术栈

## 1. 选择原则

本文定义完整 MultiAgentOS 的目标实现技术栈。技术选择必须服从领域所有权和 Port：替换数据库、durable runtime、broker、模型 Provider、检索引擎或 Sandbox 不得改变 TaskGraph、MissionScope、Unit、Checkpoint 和 Artifact 的语义。

本文不表示仓库已经安装全部组件。已声明依赖及精确版本见 `docs/Requirements/Dependencies.md`；交付范围的技术限制由总文档索引指向的交付技术栈规定。

## 2. 完整技术组合

| 能力 | 规范选择 | 替换边界 |
|---|---|---|
| Runtime / Language | Node.js LTS、TypeScript、pnpm | 编译和 package boundary |
| Schema | TypeBox、JSON Schema、Ajv | Shared Contracts |
| API / UI | Fastify、OpenAPI、SSE、React | UserInteraction Adapter |
| Durable workflow | DBOS | Durable Runtime Port |
| Database / Query | PostgreSQL、Kysely | Persistence Port |
| Reliable messaging | NATS JetStream、Outbox/Inbox | Communication Port |
| Artifact | S3-compatible Store、本地 CAS | ArtifactStorePort |
| Model | Vercel AI SDK、Provider Adapter、可选 LiteLLM Gateway | Model Execution Port |
| Tool | MCP TypeScript SDK、OpenAPI Tool Adapter | Tool Execution Port |
| Retrieval | ripgrep、tree-sitter、SCIP、pgvector、Embedding/Rerank Adapter | Context Port |
| Workspace / Isolation | Git worktree、rootless Docker/Podman | Execution/Sandbox Port |
| Identity / Policy | OIDC、RBAC/ABAC、PostgreSQL RLS、Policy Adapter | Kernel Control boundary |
| Secret | Secret Manager Adapter、短期 materialization | SecretRef boundary |
| Observability | OpenTelemetry、Prometheus、Grafana、结构化日志 | Telemetry Adapter |
| Test | Vitest、fast-check、Testcontainers、Playwright | Test harness |

以上组件共同构成完整实现基线。替换组件必须通过架构决策和兼容性验证，不得并行维护第二套领域事实源。

## 3. 语言与工程

| 领域 | 选择 | 约束 |
|---|---|---|
| Runtime | Node.js LTS | ESM、受支持的单一 major |
| Language | TypeScript | strict、NodeNext、项目引用 |
| Workspace | pnpm | 单 lockfile、`workspace:*` |
| Schema | TypeBox + JSON Schema + Ajv | 类型从 Schema 派生，边界运行时校验 |
| Quality | ESLint、typescript-eslint、Prettier | 统一 `check` 门禁 |
| Test | Vitest、fast-check | 单元、Contract、属性、集成和故障注入 |

## 4. 应用与接口

- CLI 使用 Commander，只适配 UserInteraction。
- HTTP Adapter 使用 Fastify，并由 OpenAPI 描述公开接口。
- 实时投影使用 SSE；双向交互仅在明确需要时采用 WebSocket。
- Web UI 使用 React，但不得直接访问领域数据库或 Executor。
- 所有入口复用 UserIntent、KernelControlPort 和 RuntimeProjection。

## 5. 持久工作流

DBOS 是 durable runtime Adapter，用于 workflow、step、timer、signal 和崩溃恢复。Workflow 领域层不导入 DBOS 类型，TaskGraph 仍是业务事实源。启用前必须验证：

- PostgreSQL 事务与领域 Journal/Outbox 的原子或幂等桥接；
- 等待 Unit/Signal、进程 kill 和代码升级后的恢复；
- runtime checkpoint 保留与 SessionCheckpoint fork 的兼容；
- replay 不重复外部副作用。

Restate 和 Temporal 仅作为替换候选；采用时必须通过架构决策证明隔离部署、吞吐、运维或跨语言收益。不得并行维护两套业务状态机。

## 6. Workflow 与 Agent Graph

TaskGraph、Readiness、Join、MissionScope 和 GraphRevision 由 Workflow 自研领域模型实现，以保证所有权、版本屏障、持久化和确定性验收。LangGraph 可以作为 Agent 内部推理 Adapter，但不得成为 WorkflowRun、TaskGraph 或 checkpoint 的第二事实源。

## 7. 模型与工具

- Vercel AI SDK 提供应用内模型调用和结构化输出抽象；Provider Adapter 位于 Kernel/Execution 边界。需要集中路由、配额或多 Provider 治理时使用 LiteLLM Gateway，但不改变 Model Port。
- OpenAI、Anthropic 或兼容 Provider 由配置选择；具体运行固定 DefinitionVersion。
- MCP TypeScript SDK 可作为 Tool Adapter；MCP server 声明不是授权。Tool 必须封装在 UnitDefinitionVersion 中，所有调用由 Workflow 创建 UnitIntent，并经 Kernel 校验成员关系与准入。
- OpenAPI 工具通过版本化定义生成参数 Schema；禁止动态执行未审查描述。
- Agent、Unit、Tool、Executor、Prompt 和 Model 的供应链 digest 由 AgentToolPool 管理；运行时 Executor 健康度与负载由 Kernel 管理。

## 8. 数据与迁移

- PostgreSQL 是领域事实、Journal、Outbox/Inbox、投影和审计数据库。
- Kysely 是数据访问与 Migration 工具；不得同时维护第二套权威 Schema/Migration 系统。
- 本地开发可以使用 Port 后的文件 Adapter，但不能改变事务和版本语义。
- Redis 只用于可丢失缓存、限流或短期协调，不保存领域事实。

## 9. Artifact

本地 CAS 用于开发和单机运行；S3-compatible Store 承担完整系统的远程对象、复制和生命周期管理。所有 Adapter 统一执行 SHA-256、size/mediaType 验证、tenant 隔离、retention token 和延迟 GC。数据库只保存 ArtifactRef 和业务引用。

## 10. Communication

同进程 Router 用于进程内调用；NATS JetStream 承担独立进程间的背压和可靠消费。Outbox/Inbox 仍是领域提交与至少一次投递的边界。Broker 不承担 TaskGraph、retry policy 或业务状态。

## 11. Context 与检索

| 能力 | 技术选择 |
|---|---|
| 文本/路径搜索 | ripgrep Adapter；不可用时确定性文件扫描 |
| 语法分块 | tree-sitter |
| 符号/引用 | SCIP；不支持的语言使用语言服务 Adapter |
| 向量存储 | PostgreSQL + pgvector |
| Embedding/Rerank | 通过 Kernel MODEL Unit 调用，不在 ContextEngine 内直连 Provider |
| 缓存 | 内容 hash + IndexRevision + ACL/revision key |

混合检索必须先以无模型评测验证收益。语义检索不能替代 provenance、ACL 和 repository revision 过滤。

## 12. Workspace 与 Sandbox

Git worktree 提供独立代码 workspace；rootless Docker/Podman 提供进程隔离。gVisor 或 microVM 仅作为高风险执行的强化替换方案。Sandbox 必须支持文件系统、网络、CPU、内存、磁盘、进程数、deadline、输出和 Secret 策略。

## 13. 身份、策略与 Secret

- OIDC 提供用户/服务身份；tenant/project 权限由 RBAC/ABAC 与数据库 RLS 共同约束。
- Policy Engine 位于 Kernel Adapter 后；PolicyDecision 必须版本化和可审计。
- Secret Manager 通过短期 SecretRef/materialization 提供凭据；不把值写入协议或数据库正文。
- 本地模式可以使用受限配置 Adapter，但必须保持相同 SecretRef 和脱敏语义。

## 14. 可观测性

OpenTelemetry 统一 trace、metric 和 log correlation；Collector 将数据发送到选定后端。Prometheus/Grafana 可用于指标和告警，结构化日志进入受控日志系统。Telemetry 不成为业务事实源，也不记录完整 Prompt、源码、工具输出或 Secret。

## 15. 测试与供应链

- Testcontainers 验证 PostgreSQL、broker、对象存储和服务 Adapter。
- Playwright 验证 Web 用户路径；CLI 使用进程级 E2E。
- 故障注入覆盖进程 kill、网络分区、ack 丢失、存储损坏、Lease 过期和 Provider 未知效果。
- 依赖固定精确版本，生成 SBOM，执行漏洞、许可、签名和 provenance 检查。
- Provider、runtime、数据库和 Sandbox 升级必须通过 Contract、恢复、安全和基准回归。

## 16. 替换与引入门

新增基础设施前必须记录：Owner/Adapter、解决的问题、基准、故障模型、协议影响、运维成本、安全与许可风险、替代方案、退出方式和回滚验证。不得因长期架构提到某项技术就提前使其成为必需依赖。
