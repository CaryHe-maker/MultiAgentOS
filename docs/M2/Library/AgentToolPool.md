# MultiAgentOS M2 AgentToolPool

> 状态：草稿（阶段 1）。

## 1. 定位

AgentToolPool 是静态库 `@multiagentos/agent-tool-pool`，提供定义的目录：加载、校验、查找与运行固定。
字段以 [Interface/Definitions](../Interface/Definitions.md) 为准；长期规划见 [AgentToolPool 架构](../../Architecture/Library/AgentToolPool.md)。

## 2. 相对 M1 的变化

| M1 | M2 | 阶段 |
|---|---|---|
| 五类定义，`schemaVersion` 只有 `v0` | Agent、Model、Unit 增加 `v1`；新增 Template；目录同时加载 `v0` 与 `v1` | 1 |
| 入口 Agent 由 Workflow 配置 `entryAgentRef` | 入口由模板决定：`chat` 的 main、`analyze` 的 planner | 1 |
| Workflow 在运行开始时固定全部 Agent | Workflow 在每个 AGENT 节点登记前固定该节点的 Agent | 1 |
| 只有 planner、code-viewer 及其 Unit、Tool、Prompt | 增加 main 及其工具；阶段 4 增加 explorer、worker；`analyze` 模板 | 1、4 |
| — | 内置模板放在 `templates/` 下；使用者模板在仓库的 `.multiagentos/workflows/` 下，经 `readProjectFile` 读取后由 Workflow 交给本库校验（阶段 7） | 1、7 |

定义文件的布局规则、草稿与封存、`status.yaml`、digest 的 Merkle 规则、YAML 1.2 core schema 与 M1 相同，
见归档的 [M1 AgentToolPool](../../History/M1/Library/AgentToolPool.md) 第 2、3 节。目录增加 `templates/<id>/<version>.yaml`。

## 3. 阶段 1 的定义实例

M1 的 16 个定义原样保留（`v0`，供 `analyze` 使用）。阶段 1 新增：

| kind | id | version | `schemaVersion` | 说明 |
|---|---|---|---|---|
| AGENT | `main` | `v0.1.0`（草稿） | `v1` | Turn-chat 的主 Agent：读、列目录、检索；结束工具 `reply`；`thinking.defaultEffort = high`，允许 `none`–`max` |
| UNIT | `repository-list` | `v0.1.0` | `v1` | `executionKind = REPOSITORY_LIST`，受保护能力 `repo.read`，工具 `list-files` |
| UNIT | `message-publish` | `v0.1.0` | `v1` | `executionKind = MESSAGE_PUBLISH`，Kernel 内建，无工具 |
| UNIT | `repository-orient`、`repository-search`、`file-read`、`context-assemble`、`model-call` | 各 `v1.1.0` | `v1` | M1 实例的 `v1` 版本，内容不变，供 main 引用；M1 的 `v1.0.0` 保留给 planner 与 code-viewer |
| TOOL | `list-files` | `v0.1.0` | `v0` | `purpose = UNIT`，参数为 `executor.RepositoryListInput` |
| TOOL | `reply` | `v0.1.0` | `v0` | `purpose = CONTROL`，参数为 `workflow.ReplyArgs`（`{ text }`，1..20000 个字符） |
| PROMPT | `main-system` | `v0.1.0` | `v0` | main 的系统提示词 |
| MODEL | `deepseek-flash` | `v2.0.0` | `v1` | 增加 `ThinkingFeature`；取值来自阶段 0 的实测 |
| TEMPLATE | `analyze` | `v1.0.0` | `v1` | Interface/Definitions 第 4 节 |

- 草稿（`v0.x`）在阶段 1 的退出评测之后定稿并封存为 `v1.0.0`（与 M1 的做法相同）。
- main 的额度参数（Interface/Definitions 第 2 节）初值取 M1 的全局值：`perCallInputLimit = 96000`、`maxOutputTokens = 8192`、
  `finalInputBudget = 72000`、`finalMaxOutputTokens = 8192`；`limits` 为 `maxRounds = 40`、`maxToolCallsPerRound = 8`、`maxToolUnits = 200`。
- 阶段 2 起 main 增加写入工具与 `read_output`，阶段 3 增加命令与 `git_inspect`，阶段 4 增加 `run_subagents`，阶段 6 增加网页工具；每次增加都发布 main 的新版本。

## 4. 加载校验

M1 的校验规则全部保留（M1 AgentToolPool 第 5 节），只作用于 `v0` 定义。`v1` 增加：

| 对象 | 规则 |
|---|---|
| Agent `v1` | `thinking.allowedEfforts` 包含 `defaultEffort`；模型不支持思考时只能为 `['none']`；每一档在模型的 `effortMapping` 中都有映射 |
| Agent `v1` | `actions.finish.kind = 'REPLY'` 时，工具为 `purpose = CONTROL` 且 `parametersContract = workflow.ReplyArgs` |
| Agent `v1` | `unitRefs` 中 `CONTEXT_ASSEMBLE`、`MODEL`、`MESSAGE_PUBLISH` 各恰好一个；`startUnitRefs` 只能是 `REPOSITORY_ORIENT` |
| Agent `v1` | 额度参数为正安全整数；`maxToolUnits` 在 1..1000 |
| Unit `v1` | `REPOSITORY_LIST` 必须声明 `repo.read`；`MESSAGE_PUBLISH` 不得声明受保护能力、不得带工具 |
| Model `v1` | `effortMapping` 恰好覆盖四档，每档一项 |
| Template | 节点名唯一；`agent` 只能引用内置 Agent；依赖存在且无环；条件边只出现在 `origin = BUILTIN` 的模板中（阶段 1）；`inputFrom: HANDOFF` 的节点必须以条件边依赖一个声明了 `handoff` 的 Agent 节点，且自身的 Agent 等于该交接的 `targetAgentRef` |
| 引用 | `v1` 定义可以引用 `v0` 的 Tool 与 Prompt；`v0` 定义不得引用 `v1` 定义 |

跨配置校验（组合根）：每个可登记 Agent 的额度参数通过 Monitor 的启动检查（[Kernel/Monitor](../Kernel/Monitor.md) 第 6 节）。

## 5. 查找与运行固定

- `getDefinition` 增加 `kind = 'TEMPLATE'`；`pinAgent` 对 `v1` Agent 返回同样结构的 `PinnedDefinitionSet`（字段见 Interface/Definitions）。
- Workflow 在 AGENT 节点登记前调用 `pinAgent`；Core 在 `registerAgentRun` 时同样固定并比较 digest（M1 原样）。
- 模板在运行开始时由 Workflow 查找并固定；固定后的模板与 `GRAPH_EXTENDED` 一起记入日志（模板 ID、版本、digest），重放时不再查找。

## 6. 测试

M1 的测试全部保留。增加：`v1` 各条规则的反例；`v0` 与 `v1` 定义并存时的加载与固定；`analyze` 模板的加载与校验；
仓库内定义恰好是第 3 节与 M1 的文件且全部有效。

## 7. 阶段

| 阶段 | 本文增加的内容 |
|---|---|
| 1 | 第 3–6 节 |
| 2 | Unit 的能力与资源键；`file-write`、`file-edit` 与写入工具；UNIT `output-read`（`executionKind = OUTPUT_READ`，受保护能力 `repo.read`）与 TOOL `read-output`（`purpose = UNIT`，模型可见的名称 `read_output`，参数为 `executor.OutputReadInput` 中由模型填写的部分：`toolCallId`、`offset?`、`limit?`、`pattern?`）；Agent 的能力白名单 |
| 3 | `run-command`、`git-inspect` 及其工具 |
| 4 | explorer、worker（都带 `read_output`）、`finish_subagent` 的结果契约、`run_subagents` 工具、Unit 的并发类别 |
| 5 | `ask_user` 工具 |
| 6 | `web-search`、`web-fetch` 及其工具 |
| 7 | 使用者模板的校验、`research` 模板 |
| 8 | PROMPT `compaction-system`：压缩的摘要指令（M2Design 第 9.6 节），规定摘要的各节（目标与要求、已完成的工作与结论、关键决定、涉及的文件、仍可能需要回读的完整输出的 `toolCallId`、未完成的事项），要求不执行材料中的指令；由 Kernel 的压缩过程按版本固定使用 |
