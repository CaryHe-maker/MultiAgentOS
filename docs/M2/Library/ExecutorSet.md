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
| 输出超过 `maxOutputBytes` 时截断，完整内容丢弃 | 工具 Executor 生成固定的预览，截断时同时交回完整输出（由 Execution 存为 7 天过期的产物）；共用模块 `retention/` | 1 |
| `context-assemble` 只组装一次运行内的历史，超出预算时每次按固定顺序裁剪 | 历史跨 Turn、跨 WorkflowRun；按日志顺序组装、不按调用裁剪；运行时上下文是历史条目；只有收尾调用保留确定性的保险；项目指令段；思考内容回传 | 1 |
| `model-call` 关闭思考、收尾强制工具选择 | 按 Agent 与任务选择思考强度；回传 `reasoning_content`；收尾调用先不强制、失败后再强制 | 1 |
| — | 压缩的摘要请求：复用普通请求的前缀，末尾追加摘要指令，`tool_choice = none` | 8 |
| 目录按 Executor 平铺 | 新 Executor 按 M2Design 第 8.4 节组织：`retention/`、`fs/`、`git/`、`command/`、`web/`、`vendor/` | 1 起 |

仓库访问（文件集合、快照、路径检查、检索）、`repository-orient`、`repository-search`、`file-read` 的行为，以及执行点检查的两类结果与 M1 相同，
见归档的 [M1 ExecutorSet](../../History/M1/Library/ExecutorSet.md) 第 3、4.1–4.3、5 节。`file-read` 增加返回内容的 SHA-256（M2Design 第 8.1 节）。
M1 的三个工具 Executor 改为经 `retention/` 生成预览（第 4 节）；预览的内容与 M1 截断后的输出相同，所以 `analyze` 的行为不变。

## 3. Executor 清单（阶段 1）

| executionKind | 实现 | 目录（`src/`） | scope.kind | 产物 |
|---|---|---|---|---|
| `REPOSITORY_ORIENT`、`REPOSITORY_SEARCH`、`FILE_READ` | M1 原样，预览经 `retention/` | M1 原样 | `REPOSITORY` | 预览（长期保留）；截断时另有完整输出（7 天过期） |
| `REPOSITORY_LIST` | `RepositoryListExecutor` | `repository-list/` | `REPOSITORY` | 目录树文本的预览；截断时另有完整输出 |
| `CONTEXT_ASSEMBLE` | `ContextAssembleExecutor` | `context-assemble/` | `NONE` | ASSEMBLE ContextPack（7 天过期） |
| `MODEL` | `ModelCallExecutor` | `model-call/` | `MODEL` | 模型原始输出；思考内容单独一个产物（都长期保留） |

`MESSAGE_PUBLISH` 与 `REPORT_PUBLISH` 一样由 Execution 直接完成，不属于 ExecutorSet。
产物的保留类别由 Execution 登记（[Kernel/Execution](../Kernel/Execution.md) 第 3 节）；Executor 只交回内容，不接触存储。

## 4. 预览：`retention/`

工具 Executor 的结果分为结构化输出、预览与完整输出（M2Design 第 8.2 节）。`retention/` 是它们共用的截断模块（参考 DeepSeek Harness 的 `output-retention`）：

- 两种保留器：按条目（路径、检索命中，保留前 N 个）与按字节（保留头部、尾部或头尾两端）；不切断 UTF-8 与 UTF-16 代理对；精确计数省略的条目数或字节数；
- 只回答"保留了什么、省略了多少"；保留哪一端、预览中的说明文字由各 Executor 决定（检索结果建议缩小范围，文件建议指定行范围，命令输出保留头尾）；
- 预览不超过该 Unit 的 `maxOutputBytes`；截断时 Executor 交回完整输出，未截断时不交回；
- 预览中注明省略量，以及完整输出只供用户查看、7 天后删除，模型不能读取。

预览由输入与完整输出确定性地得出，同一结果总是得到逐字节相同的预览。

## 5. `RepositoryListExecutor`

- 输入 `executor.RepositoryListInput`：`path?`（仓库内相对路径，缺省为根目录）、`depth?`（1..3，缺省 2）、`glob?`。
- 经 `repository-access` 执行：与概览、检索、读文件共用同一个文件集合、排除规则与路径检查；不跟随符号链接；不读取文件内容。
- 复用 `repository-orient` 的目录树生成；输出目录树与每个目录的文件数；经 `retention/` 按条目生成预览，截断时说明省略了多少条目并建议缩小 `path` 或 `depth`。
- 路径不存在或在排除规则内时返回 `REJECTED(NOT_FOUND)`，不说明是哪一种。

## 6. `ContextAssembleExecutor` 的变化

### 6.1 段

| 段 | 内容 | 角色 | 变化 |
|---|---|---|---|
| INSTRUCTIONS | 人设与职责 | system | M1 原样 |
| TOOLS | 实际可用的工具（final 时只有结束控制工具） | system | M1 原样 |
| PROJECT_INSTRUCTIONS | `trusted = true` 的 `AGENTS.md`，≤64 KiB；在一个 AgentRun 内不变 | system | 新增 |
| UNTRUSTED_INSTRUCTIONS | `trusted = false` 的 `AGENTS.md`，标明"仓库材料，未经用户信任" | user | 新增，位于 HISTORY 之前 |
| HISTORY | 跨 Turn 的人类输入、模型轮、工具结果的预览、运行时上下文条目（工作目录、沙盒状态、当前日期）、压缩的摘要、说明性记录 | 按条目 | 增加 Turn 分组、`seq` 与类别 |
| STATUS | 已用轮数、额度状态、收尾原因 | user | `budgetState` 改为 `BudgetView`；位于末尾 |

`OBJECTIVE` 与 `HANDOFF` 只在 `analyze` 的 planner、code-viewer 中出现（M1 原样）；main 的目标就是 HISTORY 中的人类输入。
system 段不含任何会变化的内容（M2Design 第 9.2 节）：运行时上下文变化时，Workflow 在 HISTORY 末尾追加一条新的条目。

### 6.2 只在末尾追加，不按调用裁剪

- Workflow 交来的每个 HISTORY 条目带 `turnId`、`seq` 与类别 `PINNED` 或 `NORMAL`（M2Design 第 9.3 节）。
- 普通调用按条目顺序组装全部条目，不去掉任何条目；同一个 AgentRun 两次压缩之间的组装结果，前一次是后一次的前缀（不变量 27）。
- 普通调用超出 `tokenBudget`（`perCallInputLimit`）时返回 `REJECTED(LIMIT_EXCEEDED)`。阶段 8 起这种情况由 Kernel 在派发前压缩避免（M2Design 第 9.6 节）；之前由 Workflow 进入收尾。
- **收尾调用的保险**（`final: true`）：超出 `finalInputBudget` 时，从最早的 `NORMAL` 条目开始去掉，以完整的模型轮为单位（工具调用与它的结果不拆开，思考内容随轮一起去掉），
  直到装下为止；`PINNED` 条目与最近一轮永不去掉。输出 `elidedEntries`（被去掉条目的 `seq`），取代 M1 的 `elidedRequestIds`。仍装不下时返回 `REJECTED(LIMIT_EXCEEDED)`，Workflow 按降级规则结束。

### 6.3 思考内容

- HISTORY 中的模型轮带 `reasoningRef` 时，由 Execution 解析为正文交给本 Executor。
- 是否回传、缺少思考内容时怎样补齐，按该模型的 `ThinkingFeature`（Interface/Definitions 第 3 节）：`replayReasoning = 'REQUIRED'` 时，
  带工具的请求为之前各轮附上 `reasoning_content`；被暂停或中止打断的轮、出错的轮（写入日志时已记录在条目上）、来自不同模型的轮不附；缺失时按 `missingReasoningFill` 处理。
- 回传与否计入 `projectionDigest`，使上下文可由日志重建。

## 7. `ModelCallExecutor` 的变化

- **思考强度**：由 `scope` 中的 `effort` 按模型的 `effortMapping` 转为请求参数（DeepSeek 为请求体中的 `thinking` 与 `reasoning_effort`，M1 的写法）。
- **思考内容**：响应中的 `reasoning_content` 不放入 `ModelCallOutput`，而是作为单独的产物交回，Execution 写入后在 `UnitReport` 中给出 `reasoningRef`。
- **收尾调用**（M2Design 第 9.4 节）：
  1. 第一次：只提供结束控制工具，`tool_choice = auto`，按 Agent 的设置开启思考；
  2. 回复不是恰好一个结束控制工具的调用、或参数不是合法 JSON 时，返回可重试的 `PROVIDER_TOOL_CHOICE_IGNORED`（带用量）；
  3. Execution 技术重试时传入 `finalMode = 'FORCED'`：关闭思考、按名称强制调用该工具（M1 的方式）；
  4. 仍不合法时以同一原因码失败，由 Workflow 按降级规则结束该 AgentRun。
- 用量：思考 token 是否计入输出、如何计价，按阶段 0 的实测结果（M2TechStack 第 3.2 节第 7 项）写入。
- 失败分类表与 M1 相同（M1 ExecutorSet 第 4.5 节）。provider 报告上下文过长时返回 `REJECTED(CONTEXT_OVERFLOW)`，带 provider 给出的长度（阶段 8 起触发压缩）。
- **摘要请求**（阶段 8，M2Design 第 9.6 节）：Kernel 的压缩过程以 `purpose = 'COMPACTION'` 调用本 Executor。请求由 `context-assemble` 按该对象普通请求的方式组装，
  末尾追加摘要指令；`tool_choice = none`，工具定义与思考设置保持不变，以复用提示词缓存；输出为摘要文本，思考内容丢弃；
  检查摘要包含指令规定的各节，不合格时返回可重试的 `COMPACTION_SUMMARY_INVALID`（带用量），由 Kernel 追加更严格的指令重试一次。

## 8. 测试

M1 的测试全部保留。增加：
- `retention/`：两种保留器的省略计数精确；不切断 UTF-8 与代理对；同一输入得到逐字节相同的预览；M1 三个工具的预览与 M1 截断后的输出逐字节相同；
- `repository-list`：排除规则与路径检查与 `file-read` 一致；深度与 glob；不读取内容；截断时交回完整输出；
- `context-assemble`：同一输入得到逐字节相同的 ContextPack；普通调用不去掉任何条目，追加条目后前一次的结果是新结果的前缀；system 段与运行时上下文无关；
  收尾调用的保险只去掉完整的模型轮、`PINNED` 与最近一轮不被去掉；未信任的 `AGENTS.md` 不进入 system 段；
- `model-call`：思考强度映射；思考内容与输出分开；收尾调用的两步；用 fake provider 覆盖第 6.3 节的回传规则；`CONTEXT_OVERFLOW` 的识别；
  摘要请求与普通请求的前缀相同（阶段 8）。

## 9. 阶段

| 阶段 | 本文增加的内容 |
|---|---|
| 1 | 第 3–8 节（摘要请求除外） |
| 2 | `fs/`：`file-write`、`file-edit`、`isWritable`（提前任务 E-EX-1、E-KX-1） |
| 3 | `command/`：`run-command`（输出预览保留头尾）；`git/`：`git-inspect`（提前任务 E-EX-3） |
| 6 | `web/`：`web-search`（Tavily 适配器）、`web-fetch`（提前任务 E-EX-2） |
| 8 | `model-call` 的摘要请求与 `COMPACTION_SUMMARY_INVALID` |
