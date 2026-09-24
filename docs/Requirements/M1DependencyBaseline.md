# MultiAgentOS M1 依赖基线

> 文档状态：M1 规范性基线<br>
> 基线日期：2026-09-24<br>
> 适用范围：当前仓库的 M1 薄实现、3 个 app、11 个 package
> 产品版本：`0.1`；M1–M5 是里程碑，M5 完成后发布 V1.0

## 1. 目的与事实源

本文统一记录 M1 可以直接使用的运行时、开发工具和第三方 npm 依赖，并明确它们属于哪个架构边界。版本判断按以下优先级执行：

1. 根 `package.json` 与各 workspace `package.json` 声明期望的精确版本；
2. `pnpm-lock.yaml` 固定完整传递依赖图；
3. 本文解释采用原因、所有权和阶段范围；
4. `TechStack.md` 中未被本文列入的技术均为后续候选，不自动成为 M1 依赖。

M1 的公共对象协议仍以 `packages/contracts` 中的 TypeBox/JSON Schema 为唯一事实源。第三方 SDK 自身传递安装的 Zod 或其他 schema 库只服务于该 SDK，不得成为 MultiAgentOS 的公共协议定义工具。

## 2. 运行环境基线

| 项目 | M1 基线 | 规则 |
|---|---:|---|
| Node.js | `24.19.0`，允许 `>=24.19.0 <25` | 使用 Node 24 LTS；开发机和 CI 保持同一 major |
| pnpm | `11.25.0` | 必须使用根 `packageManager` 指定版本和单一 lockfile |
| TypeScript | `6.0.3` | 与 TypeBox 1.x 及 typescript-eslint 8.70.x 的共同受支持范围一致 |
| Git | 能读取 revision/status 的维护版本 | M1 固定并验证 repository revision；worktree/diff 从 M2 使用 |
| ripgrep | 支持 PCRE2 的维护版本 | ContextEngine 的 M1 文本检索后端 |
| PowerShell | Windows PowerShell 5.1 或 PowerShell 7 | Windows 下调用 npm 工具时使用 `pnpm.cmd`；脚本不得假定仅有新版 .NET API |

## 3. 根开发依赖

下表依赖只用于构建、检查和测试，不属于任何领域 Module 的运行时协议。

| 依赖 | 精确版本 | 用途 |
|---|---:|---|
| `typescript` | `6.0.3` | strict 编译、declaration 和 project references |
| `@types/node` | `24.13.6` | 与 Node 24 对齐的运行时类型 |
| `typescript-eslint` | `8.70.1` | TypeScript parser、plugin 和 typed lint 配置 |
| `eslint` | `10.11.0` | 静态检查 |
| `@eslint/js` | `10.0.1` | ESLint 官方 JavaScript 基础规则 |
| `prettier` | `3.9.8` | 源码和工程配置格式化 |
| `vitest` | `5.0.1` | 单元、contract 和集成测试运行器 |
| `@vitest/coverage-v8` | `5.0.1` | V8 覆盖率；必须与 Vitest 保持同版本 |
| `fast-check` | `4.10.2` | 协议、状态机与不变量属性测试 |
| `tsx` | `4.23.15` | 开发期直接运行 TypeScript 入口或 harness |

根命令的语义固定为：

- `pnpm.cmd run build`：构建全部 TypeScript project references；
- `pnpm.cmd run lint`：检查 `apps` 与 `packages` 源码；
- `pnpm.cmd run test`：运行 Vitest；没有测试文件时骨架阶段允许以 0 退出；
- `pnpm.cmd run check`：依次执行格式、lint、类型检查和测试，是提交前统一门禁。

## 4. M1 运行依赖及所有权

### 4.1 `packages/contracts`

| 依赖 | 精确版本 | 用途与边界 |
|---|---:|---|
| `typebox` | `1.3.34` | 定义版本化 JSON Schema 与对应 TypeScript 类型 |
| `ajv` | `8.20.0` | 编译并执行跨边界 schema 校验 |
| `ajv-formats` | `3.0.1` | 为 Ajv 提供标准 format 校验 |

只有 `packages/contracts` 可以定义平台共有 Envelope、ID/Ref、Error 和跨 Module schema。其他包通过 `@multiagentos/contracts: workspace:*` 使用它，不得各自引入第二套权威 schema。

### 4.2 `apps/cli`

| 依赖 | 精确版本 | 用途与边界 |
|---|---:|---|
| `commander` | `15.0.0` | 解析 CLI 命令和参数；只适配 UserInteraction，不直连 Workflow |

### 4.3 `packages/kernel`

| 依赖 | 精确版本 | 用途与边界 |
|---|---:|---|
| `ai` | `7.0.107` | 模型调用、结构化输出和 Provider 抽象 |
| `@ai-sdk/openai` | `4.0.71` | OpenAI Provider adapter 候选 |
| `@ai-sdk/anthropic` | `4.0.58` | Anthropic Provider adapter 候选 |
| `dotenv` | `18.0.1` | 本地开发配置加载；Secret 不得进入协议、日志或 Artifact |

两个 Provider SDK 可以同时安装以固定 adapter 编译边界，但一个具体 M1 运行必须通过配置只启用一个 Provider。Workflow、AgentToolPool、UserInteraction 和 Executor 不得直接导入这些模型 SDK。

### 4.4 仅使用平台与 workspace 依赖的边界

以下 workspace 在 M1 不需要额外第三方运行依赖：

- `apps/control-plane`：只负责最终 composition；
- `apps/executor`：通过 Shared Contracts 接受 Kernel 请求，M1 仅使用 Node 内置 fs/path 实现受限只读访问；subprocess、文件写入与测试执行从 M2 的安全门之后引入；
- `packages/workflow`：领域状态机和 Agent loop；
- `packages/context-engine`：通过 Port 使用文件系统和 ripgrep adapter；
- `packages/agent-tool-pool`：内置只读 DefinitionVersion catalog；
- `packages/user-interaction`：WorkSession、UserIntent 和 RuntimeProjection view model；
- `packages/module-host`：注册、生命周期和装配；
- `packages/persistence`：M1 run-scoped 文件 adapter；
- `packages/communication`：M1 进程内 Router；
- `packages/artifacts`：Node 内置 fs/crypto 实现本地 Artifact Store；
- `packages/testing`：复用根 Vitest/fast-check，并依赖各 workspace 的公开入口。

“当前无第三方依赖”不等于边界可以删除或跨层直调。每个 package 仍必须保留公开 Port、默认/fake adapter、测试位置和升级槽位。

## 5. 当前明确不安装的依赖

下列依赖不属于 M1 初始实现，不得仅因长期架构提到它们就提前加入当前 manifests：

| 后续能力 | 候选依赖/基础设施 | 最早评估阶段 |
|---|---|---|
| 持久工作流和数据库事实源 | PostgreSQL、DBOS、Kysely、migration 工具 | M2 |
| 多 Executor Process 与可靠消息 | NATS 或其他 broker、Lease/fencing 支撑 | M3 |
| 工具生态 | MCP TypeScript SDK | M3/M4，按真实工具需求 |
| 强隔离 | Docker/Podman SDK、gVisor 或 microVM adapter | M4 |
| HTTP/Web 产品入口 | Fastify、OpenAPI、SSE、React | M5，或更早出现已批准的非 CLI 入口时 |
| 完整可观测性 | OpenTelemetry SDK/Collector、Prometheus/Grafana | M4/生产化 |
| 数据库集成测试和浏览器 E2E | Testcontainers、Playwright | 对应 adapter/UI 进入范围时 |
| 语义检索 | Tree-sitter、SCIP、pgvector、embedding/reranker | M5 前按检索评测分项验证 |

## 6. 版本与变更规则

1. 所有直接外部依赖使用精确版本，不使用 `^`、`~`、`latest`、beta、RC 或 canary。
2. 内部依赖统一使用 `workspace:*`；不得把本仓库 package 替换成 registry 版本。
3. `pnpm-lock.yaml` 必须提交；CI 安装使用 `pnpm.cmd install --frozen-lockfile`。
4. Vitest 与 `@vitest/coverage-v8` 保持相同版本；Node major 与 `@types/node` major 保持一致。
5. TypeScript 升级前必须同时验证 TypeBox 和 typescript-eslint 的官方支持范围。
6. Provider SDK 升级必须通过结构化输出、tool call、错误映射和 usage contract tests。
7. 新增第三方依赖必须说明 owner workspace、替代方案、协议影响、许可/供应链风险以及移除方式。
8. 传递依赖不得被源码直接导入；需要直接使用时必须显式加入正确 workspace 的 manifest。

依赖变更完成定义：

```powershell
pnpm.cmd install
pnpm.cmd peers check
pnpm.cmd run check
git diff --check
```

四项全部成功后，依赖基线才可视为可用。
