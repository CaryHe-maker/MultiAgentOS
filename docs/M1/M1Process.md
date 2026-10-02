# MultiAgentOS M1 进度

> 架构衔接说明（2026-09-30）：本文保留既有 M1 范围、接口或进度基线。
> 长期设计已调整为独立 Execution、Kernel 租约与五组件体系，目标平台为 Ubuntu LTS。
> 本轮不设计 M1 详细方案，不表示代码已迁移；具体差异见 [M1 指南](README.md)。

> 状态基线：2026-09-24。文档重组不改变实现完成度。

## 1. 并行更新规则

- 状态只允许 `TODO`、`DOING`、`BLOCKED`、`DONE`。
- A、B、C 只编辑各自命名的表格；不得重排 ID 或修改他人行。
- 每项任务只有一个 Owner。协作者在 PR 中评论，不共同编辑同一行。
- 标记 `DONE` 时必须同时填写 `Updated`、自动化证据和 PR；接口或 TODO 不算完成。
- `BLOCKED` 必须写明阻塞条件；范围变化先修改 [M1Plan.md](M1Plan.md)。
- 集成门由表中指定 Owner 在所有依赖完成后更新。不要维护手工百分比或重复摘要。

## 2. A：Workflow 与 UserInteraction

| ID | Task | Status | Updated | Evidence / remaining | PR |
|---|---|---|---|---|---|
| A-01 | WorkSession、PromptRevision、SessionTreeNode、UserIntent | DOING | 2026-09-24 | 身份与 intent 已有；领域记录和持久化待补 | - |
| A-02 | WorkflowRun、GraphRevision、MissionScope、Task/Attempt、AgentRun/Step | DOING | 2026-09-24 | Run、revision、预算骨架已有 | - |
| A-03 | 单 Task、零 Edge 的 TaskGraph validator | TODO | - | - | - |
| A-04 | AnalysisAction Schema 与 reducer | TODO | - | QUERY/SEARCH/READ/FINAL | - |
| A-05 | 多轮 Agent loop、预算、无进展与终止 | TODO | - | - | - |
| A-06 | 来源验收与 AnalysisReport | TODO | - | - | - |
| A-07 | CLI -> UserInteraction -> Kernel 入口 | DOING | 2026-09-24 | service 已有；CLI 入口为空 | - |
| A-08 | CANCEL 语义或按范围规则明确不支持 | TODO | - | - | - |

## 3. B：Kernel、Catalog 与 Executor

| ID | Task | Status | Updated | Evidence / remaining | PR |
|---|---|---|---|---|---|
| B-01 | KernelControlPort、路由与 RuntimeProjection | DOING | 2026-09-24 | 基础投影已完成；执行状态汇总待补 | - |
| B-02 | Unit 准入、UnitAttempt 审计和 UnitResult | DOING | 2026-09-24 | Schema/deadline/Context 路由已有 | - |
| B-03 | 安全 FILE_READ 与副作用拒绝 | DONE | 2026-09-24 | `apps/executor/src/executor.test.ts` | - |
| B-04 | Executor 接入唯一组合根 | DONE | 2026-09-24 | `apps/control-plane/src/runtime.test.ts` | - |
| B-05 | 内置 DefinitionVersion、digest 与 CatalogPort | DONE | 2026-09-23 | `packages/agent-tool-pool/src/catalog.test.ts` | - |
| B-06 | Model Provider、MODEL Unit、Schema 和 usage | TODO | - | - | - |
| B-07 | workspace revision 固定与运行前后不变检查 | TODO | - | - | - |
| B-08 | Module Host 生命周期与依赖排序 | DONE | 2026-09-23 | `packages/module-host/src/module-host.test.ts` | - |

## 4. C：ContextEngine 与平台适配器

| ID | Task | Status | Updated | Evidence / remaining | PR |
|---|---|---|---|---|---|
| C-01 | ORIENT、快照、ignore 和安全过滤 | DOING | 2026-09-24 | 文件遍历/ignore 已有；snapshot 与敏感过滤待补 | - |
| C-02 | SEARCH：PATH/TEXT/SYMBOL、分块、排序和建议 | DOING | 2026-09-24 | 内置文本扫描已有；其余待补 | - |
| C-03 | ASSEMBLE、稳定前缀、状态栏和历史压缩 | TODO | - | - | - |
| C-04 | RetrievalLedger、去重和诊断 | TODO | - | - | - |
| C-05 | ContextRequest/Pack 新契约与 PortResult | TODO | - | 以 ContextEngine 规范为准 | - |
| C-06 | 检索 fixtures、Recall@k、MRR 与端到端评测 | TODO | - | - | - |
| C-07 | Artifact Store 完整性 | DONE | 2026-09-23 | `packages/artifacts/src/artifacts.test.ts` | - |
| C-08 | File Repository 与进程内 Router | DONE | 2026-09-23 | persistence/communication tests | - |

## 5. 集成与发布门

| ID | Owner | Task | Depends on | Status | Updated | Evidence / remaining | PR |
|---|---|---|---|---|---|---|---|
| G-01 | A | Fake 纵向链：UserInteraction -> RuntimeProjection | A-01, A-02, B-01, B-05 | DONE | 2026-09-23 | `apps/control-plane/src/runtime.test.ts` | - |
| G-02 | B | 完整 Unit Fake 环与 shared contract harness | A-02, B-02, C-05 | TODO | - | - | - |
| G-03 | C | Context 契约、检索与安全回归 | C-01..C-06 | TODO | - | - | - |
| G-04 | A | 真实模型单轮分析 | A-04, B-06, C-05 | TODO | - | - | - |
| G-05 | B | F1–F5 E2E 与安全矩阵 | A-05, A-06, B-07, C-06 | TODO | - | - | - |
| G-06 | C | 协议兼容矩阵和架构绕行测试 | G-02, G-03 | DOING | 2026-09-24 | 部分依赖规则与未知 major 测试已有 | - |
| G-07 | A | M1 完成定义、文档和发布复核 | G-01..G-06 | TODO | - | - | - |

## 6. 验证记录

| Date | Branch | Command | Result | Scope |
|---|---|---|---|---|
| 2026-09-23 | `feat/M1` | `pnpm.cmd run check` | PASS：10 files / 20 tests | 基础协议、平台包、Context、Executor、装配和依赖边界 |
| 2026-09-24 | `feat/M1` | `pnpm.cmd run check` | PASS：10 files / 22 tests | 版本与边界统一；不代表 M1 验收完成 |
