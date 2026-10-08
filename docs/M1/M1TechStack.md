# MultiAgentOS M1 技术栈

> 架构衔接说明（2026-10-07）：本文已按三 Module、六组件宏内核更新。
> M1 验收平台为 Ubuntu LTS；开发平台不限，但代码必须能在 Ubuntu LTS 上运行。

## 1. 目的与权威

本文定义 M1 允许使用的运行环境、第三方技术、基础设施实现和工程工具。M1 只采用完成只读 Repository Analysis Agent 所需的最小技术集合；完整系统技术栈见 [Architecture TechStack](../Architecture/TechStack.md)。

版本事实源按以下顺序确定：

1. 根目录及 workspace 的 `package.json`；
2. `pnpm-lock.yaml`；
3. [Dependencies](../Requirements/Dependencies.md)；
4. 本文对技术用途、所有权和使用边界的规定。

本文不替代 package manifest。文档与 manifest 不一致时，应修正文档或通过依赖变更 PR 修改 manifest，不得在源码中依赖未声明包。

## 2. 运行与工程基线

| 项目 | M1 选择 | 约束 |
|---|---|---|
| Runtime | Node.js `24.19.0` | `>=24.19.0 <25`，ESM |
| Package manager | pnpm `11.25.0` | 单一 workspace 和 lockfile |
| Language | TypeScript `6.0.3` | NodeNext、strict、project references |
| Schema | TypeBox `1.3.34` | 公共 Schema 与静态类型来源 |
| Validation | Ajv `8.20.0`、ajv-formats `3.0.1` | 跨边界运行时校验 |
| Test | Vitest `5.0.1`、fast-check `4.10.2` | 单元、Contract、属性、集成测试 |
| Quality | ESLint `10.11.0`、Prettier `3.9.8` | `pnpm run check` |
| Development runner | tsx `4.23.15` | 开发期 TypeScript harness |

TypeScript 必须开启 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`useUnknownInCatchVariables` 和 `forceConsistentCasingInFileNames`。

## 3. 部署形态

M1 使用模块化单体：三个 Module、四类基础设施、三个静态库和只读 Executor 位于同一 Node.js 进程，通过公开 Port 和运行时 Schema 保持逻辑边界。Kernel 内 Core、Monitor、Scheduler、Execution 之间直接函数调用；Gateway、Supervisor 与其他主体之间、以及外部 Module 与 Kernel 之间使用进程内可序列化消息（见 [M1KernelRange](kernel/M1KernelRange.md) §3.1）。

```text
apps/cli                 CLI Adapter
apps/control-plane       唯一 composition root
apps/executor            只读 FILE_READ Adapter
packages/*               Module、Infrastructure、Contracts 和 Testing
```

M1 不因同进程而允许跨包读取 Repository、Reducer 或内部类。`apps/control-plane` 是唯一可以组合多个具体实现的位置。

## 4. 用户入口

CLI 使用 Commander `15.0.0` 解析参数，并只调用 UserInteraction 的公开入口。M1 不引入 HTTP Server、OpenAPI、SSE、Web UI 或浏览器运行时。

## 5. Shared Contracts

`packages/contracts` 使用 TypeBox 定义 Schema，使用 Ajv 编译并执行验证。Envelope、BoundaryContext、ID、Ref、Error、Unit、Context 和 Catalog 协议均从该包导出。其他 workspace 不得引入第二套公共 Schema 工具，也不得仅依赖 TypeScript interface 通过边界。

## 6. Workflow 与运行控制

Workflow 使用自有 TypeScript Reducer 和状态对象实现单 Task 的分析循环，Planner 与 CodeViewer 单向交接。M1 不引入 durable workflow engine、外部 scheduler 或数据库任务队列；运行中断可以结构化失败，不承诺从 AgentStep 自动续跑。

预算、状态机、DefinitionVersion 和 UnitIntent 必须保留稳定边界，使实现不依赖进程内隐式调用。

## 7. 模型

| 依赖 | 版本 | 所有者与用途 |
|---|---:|---|
| `ai` | `7.0.107` | Kernel 的模型调用和结构化输出抽象 |
| `@ai-sdk/openai` | `4.0.71` | OpenAI Provider Adapter |
| `@ai-sdk/anthropic` | `4.0.58` | Anthropic Provider Adapter |
| `dotenv` | `18.0.1` | 本地配置加载 |

一个运行只启用一个配置选定的 Provider。Provider SDK 只能在模型调用 Executor 中使用，并关闭 SDK 自带的自动重试；Workflow、UserInteraction、AgentToolPool 和其他 Executor 不得直接导入 Provider SDK。Secret 只能由配置边界读取，不得进入协议、日志或 Artifact。

## 8. 上下文与检索 Executor

M1 使用 Node.js `fs/path/crypto` 构建只读仓库快照、分块、hash、预算和 provenance。文本搜索通过可替换 SearchBackend：检测到受支持的系统 `rg` 时使用参数数组调用；不可用时使用确定性 Node.js 文件扫描。

仓库当前未声明 ripgrep npm 包，因此不得在源码中导入未安装的二进制包。引入固定 ripgrep 分发依赖时，必须先更新 workspace manifest、lockfile、依赖文档和 Ubuntu LTS 上的 Contract tests。

M1 不使用 tree-sitter、SCIP、向量数据库、embedding、reranker 或跨会话记忆。符号检索使用明确记录限制的正则策略。

## 9. Execution

`apps/executor` 使用 Node.js 文件系统 API 实现受限 FILE_READ。路径必须在 `realpath` 后位于 Supervisor 注入的仓库根目录内，并拒绝绝对路径、`..`、指向仓库外的 symlink、危险文件、超时和超限输出（见 [UnitCheck](UnitCheck.md) 第 9 节）。

FILE_WRITE、COMMAND、TEST、网络和其他副作用返回 `UNSUPPORTED_CAPABILITY`。M1 不引入 Git worktree、容器、远程 Executor 或 subprocess 执行框架。

## 10. Persistence、Communication 与 Artifact

| 能力 | M1 实现 | 边界 |
|---|---|---|
| Persistence | run-scoped 文件 Repository，`runs/<runId>/` 保存报告、运行记录与审计；临时文件后原子 rename | 启动时只清空临时数据；事务、Journal、Inbox/Outbox 明确 Unsupported |
| Communication | 同进程 MessageRouter，承载各通讯主体之间的消息 | 不提供跨进程 IPC、可靠异步投递或 broker |
| Artifact | Node.js `fs/crypto` 本地内容寻址存储 | 写入和读取复验 SHA-256、size、mediaType |
| Module Host | 进程内注册、依赖排序、start/stop/health | 不承担业务调度 |

M1 不安装 PostgreSQL、Kysely、DBOS、NATS、Redis、S3 SDK 或 Migration 工具。

## 11. 测试与质量门

测试分为 Schema/Contract、Module 单元、Adapter、架构依赖、组合和固定任务评测。`packages/testing` 只使用 workspace devDependency 和根测试工具。

提交前必须执行：

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run check
git diff --check
```

最终验收必须在 Ubuntu LTS 上执行上述命令。

涉及模型的端到端评测必须记录 Provider、模型、配置、DefinitionVersion、commit、token、成本和耗时；普通质量门不得依赖真实模型或外部网络。

## 12. 明确排除

以下技术不属于 M1 依赖，不得因 Architecture 中存在对应设计而提前安装：Fastify、React、DBOS、Restate、Temporal、PostgreSQL、Kysely、Redis、NATS、S3 SDK、MCP SDK、tree-sitter、SCIP、pgvector、Docker SDK、gVisor、OpenTelemetry SDK、Testcontainers 和 Playwright。

## 13. 依赖变更

新增或升级依赖必须说明 owner workspace、直接用途、替代方案、协议影响、供应链与许可风险、测试方式和移除路径。所有直接外部依赖使用精确版本；内部包使用 `workspace:*`；传递依赖不得被源码直接导入。
