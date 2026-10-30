# MultiAgentOS M2 ExecutorSet

> 状态：草稿（阶段 1）。

## 1. 定位

ExecutorSet 是静态库 `@multiagentos/executor-set`，提供 Unit 的原子执行行为，由 Supervisor 按 `executionKind` 装配运行。
Executor 只接收 Execution 解析后的输入与 Core 派生的范围约束，不持有 ArtifactStore、Lease、额度或运行状态（M1 原样）。
长期规划见 [ExecutorSet 架构](../../Architecture/Library/ExecutorSet.md)。

## 2. 相对 M1 的变化

| M1 | M2 | 阶段 |
|---|---|---|
| 五个 Executor | 增加 `repository-list`；阶段 2–6 增加文件写入、命令、git、网页 | 1 起 |
| `context-assemble` 只组装一次运行内的历史 | 历史跨 Turn、跨 WorkflowRun；按 Workflow 的标注分层裁剪；项目指令段；思考内容回传 | 1 |
| `model-call` 关闭思考、收尾强制工具选择 | 按 Agent 与任务选择思考强度；回传 `reasoning_content`；收尾调用先不强制、失败后再强制 | 1 |
| 目录按 Executor 平铺 | 新 Executor 按 M2Design 第 8.4 节组织：`fs/`、`git/`、`command/`、`web/`、`vendor/` | 2 起 |

仓库访问（文件集合、快照、路径检查、检索）、`repository-orient`、`repository-search`、`file-read` 的行为，以及执行点检查的两类结果与 M1 相同，
见归档的 [M1 ExecutorSet](../../History/M1/Library/ExecutorSet.md) 第 3、4.1–4.3、5 节。`file-read` 增加返回内容的 SHA-256（M2Design 第 8.1 节）。

## 3. Executor 清单（阶段 1）

| executionKind | 实现 | 目录（`src/`） | scope.kind | 产物 |
|---|---|---|---|---|
| `REPOSITORY_ORIENT`、`REPOSITORY_SEARCH`、`FILE_READ` | M1 原样 | M1 原样 | `REPOSITORY` | M1 原样 |
| `REPOSITORY_LIST` | `RepositoryListExecutor` | `repository-list/` | `REPOSITORY` | 目录树文本 |
| `CONTEXT_ASSEMBLE` | `ContextAssembleExecutor` | `context-assemble/` | `NONE` | ASSEMBLE ContextPack |
| `MODEL` | `ModelCallExecutor` | `model-call/` | `MODEL` | 模型原始输出；思考内容单独一个产物 |

`MESSAGE_PUBLISH` 与 `REPORT_PUBLISH` 一样由 Execution 直接完成，不属于 ExecutorSet。

## 4. `RepositoryListExecutor`

- 输入 `executor.RepositoryListInput`：`path?`（仓库内相对路径，缺省为根目录）、`depth?`（1..3，缺省 2）、`glob?`。
- 经 `repository-access` 执行：与概览、检索、读文件共用同一个文件集合、排除规则与路径检查；不跟随符号链接；不读取文件内容。
- 复用 `repository-orient` 的目录树生成；输出目录树与每个目录的文件数，超过 `maxOutputBytes` 时截断并注明。
- 路径不存在或在排除规则内时返回 `REJECTED(NOT_FOUND)`，不说明是哪一种。

## 5. `ContextAssembleExecutor` 的变化

### 5.1 段

| 段 | 内容 | 角色 | 变化 |
|---|---|---|---|
| INSTRUCTIONS | 人设与职责 | system | M1 原样 |
| TOOLS | 实际可用的工具（final 时只有结束控制工具） | system | M1 原样 |
| PROJECT_INSTRUCTIONS | `trusted = true` 的 `AGENTS.md`，≤64 KiB | system | 新增 |
| RUNTIME_CONTEXT | 工作目录、沙盒状态、当前日期、概览对应的快照 | system | 新增 |
| UNTRUSTED_INSTRUCTIONS | `trusted = false` 的 `AGENTS.md`，标明"仓库材料，未经用户信任" | user | 新增，位于 HISTORY 之前 |
| HISTORY | 跨 Turn 的人类输入、模型轮、工具结果、说明性记录 | 按条目 | 增加 Turn 分组与裁剪类别 |
| STATUS | 已用轮数、额度状态、收尾原因 | user | `budgetState` 改为 `BudgetView` |

`OBJECTIVE` 与 `HANDOFF` 只在 `analyze` 的 planner、code-viewer 中出现（M1 原样）；main 的目标就是 HISTORY 中的人类输入。

### 5.2 裁剪

Workflow 交来的每个 HISTORY 条目带 `turnId` 与类别 `PINNED`、`BODY_ELIDABLE`、`TURN_DROPPABLE`（M2Design 第 9.3 节）。
超出 `tokenBudget` 时按固定层级裁剪，直到装下为止：

1. 大的工具结果只保留预览；
2. 从最早的开始，去掉 `BODY_ELIDABLE` 条目的正文，保留结构化输出与引用；
3. 从最早的 Turn 开始，去掉 `TURN_DROPPABLE` 的整个 Turn（只对 main 的条目标注此类别）；
4. 仍然超出：返回 `REJECTED(LIMIT_EXCEEDED)`，由 Workflow 决定收尾调用继续按层级重试（最多 3 次）或提示用户 `/new`。

输出 `elidedEntries`（被去掉正文或整个去掉的条目及其层级），取代 M1 的 `elidedRequestIds`；`PINNED` 条目永不裁剪。
思考内容不单独裁剪，随所属的整轮一起去掉。

### 5.3 思考内容

- HISTORY 中的模型轮带 `reasoningRef` 时，由 Execution 解析为正文交给本 Executor。
- 是否回传、缺少思考内容时怎样补齐，按该模型的 `ThinkingFeature`（Interface/Definitions 第 3 节）：`replayReasoning = 'REQUIRED'` 时，
  带工具的请求为之前各轮附上 `reasoning_content`；被暂停或中止打断的轮、出错的轮、来自不同模型的轮不附；缺失时按 `missingReasoningFill` 处理。
- 回传与否计入 `projectionDigest`，使上下文可由日志重建。

## 6. `ModelCallExecutor` 的变化

- **思考强度**：由 `scope` 中的 `effort` 按模型的 `effortMapping` 转为请求参数（DeepSeek 为请求体中的 `thinking` 与 `reasoning_effort`，M1 的写法）。
- **思考内容**：响应中的 `reasoning_content` 不放入 `ModelCallOutput`，而是作为单独的产物交回，Execution 写入后在 `UnitReport` 中给出 `reasoningRef`。
- **收尾调用**（M2Design 第 9.4 节）：
  1. 第一次：只提供结束控制工具，`tool_choice = auto`，按 Agent 的设置开启思考；
  2. 回复不是恰好一个结束控制工具的调用、或参数不是合法 JSON 时，返回可重试的 `PROVIDER_TOOL_CHOICE_IGNORED`（带用量）；
  3. Execution 技术重试时传入 `finalMode = 'FORCED'`：关闭思考、按名称强制调用该工具（M1 的方式）；
  4. 仍不合法时以同一原因码失败，由 Workflow 按降级规则结束该 AgentRun。
- 用量：思考 token 是否计入输出、如何计价，按阶段 0 的实测结果（M2TechStack 第 3.2 节第 7 项）写入。
- 失败分类表与 M1 相同（M1 ExecutorSet 第 4.5 节）。

## 7. 测试

M1 的测试全部保留。增加：
- `repository-list`：排除规则与路径检查与 `file-read` 一致；深度与 glob；不读取内容；
- `context-assemble`：各裁剪层级的确定性（同一输入得到逐字节相同的 ContextPack 与 `elidedEntries`）；`PINNED` 不被裁剪；未信任的 `AGENTS.md` 不进入 system 段；
- `model-call`：思考强度映射；思考内容与输出分开；收尾调用的两步；用 fake provider 覆盖第 5.3 节的回传规则。

## 8. 阶段

| 阶段 | 本文增加的内容 |
|---|---|
| 1 | 第 3–7 节 |
| 2 | `fs/`：`file-write`、`file-edit`、`isWritable`（提前任务 E-EX-1、E-KX-1） |
| 3 | `command/`：`run-command`；`git/`：`git-inspect`（提前任务 E-EX-3） |
| 6 | `web/`：`web-search`（Tavily 适配器）、`web-fetch`（提前任务 E-EX-2） |
