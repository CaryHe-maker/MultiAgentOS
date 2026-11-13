# MultiAgentOS M2 AgentToolPool

> 状态：已实现；发布前再与代码核对一次。

## 1. 定位

AgentToolPool 是静态库 `@multiagentos/agent-tool-pool`，提供定义的目录：加载、校验、查找与运行固定。
字段以 [Interface/Definitions](../Interface/Definitions.md) 为准；长期规划见 [AgentToolPool 架构](../../Architecture/Library/AgentToolPool.md)。

## 2. 相对 M1 的变化

| M1 | M2 |
|---|---|
| 五类定义，`schemaVersion` 只有 `v0` | Agent、Model、Unit 增加 `v1`；新增 Template；目录同时加载 `v0` 与 `v1` |
| 入口 Agent 由 Workflow 配置 `entryAgentRef` | 入口由模板决定：`chat` 的 main、`analyze` 的 planner |
| Workflow 在运行开始时固定全部 Agent | Workflow 在每个 AGENT 节点登记前固定该节点的 Agent |
| 只有 planner、code-viewer 及其 Unit、Tool、Prompt | 增加 main 及其工具、explorer、worker；`chat` 与 `analyze` 模板 |
| — | 内置模板放在 `templates/` 下；使用者模板在仓库的 `.multiagentos/workflows/` 下，经 `readProjectFile` 读取后由 Workflow 交给本库校验 |

定义文件的布局规则、草稿与封存、`status.yaml`、digest 的 Merkle 规则、YAML 1.2 core schema 与 M1 相同，
见归档的 [M1 AgentToolPool](../../History/M1/Library/AgentToolPool.md) 第 2、3 节。目录增加 `templates/<id>/<version>.yaml`。

## 3. 定义实例

定义全部是 `schemaVersion = 'v1'` 的草稿（`v0.1.0`）；M1 的定义文件与 M1 的目录已删除（[Definitions](../Interface/Definitions.md) 第 1 节）。

| kind | id | 说明 |
|---|---|---|
| AGENT | `main` | Turn-chat 的主 Agent：列目录、检索、读文件、只读 git、写与编辑、命令、网页检索与读取、读工作区之外的文件（`external.read`）、派生 SubAgent；结束工具 `reply`（`PUBLISH_REPLY`），降级时 `PUBLISH_NOTICE`；没有启动 Unit；`thinking.defaultEffort = high`，允许 `none`–`max` |
| AGENT | `planner`、`code-viewer` | `analyze` 的两个节点，由 M1 改写：结束工具 `finish-analysis`（`PUBLISH_REPORT`），planner 另有 `handoff-to-code-viewer`（`HANDOFF`，收尾调用中不可用）；code-viewer 的启动 Unit 是 `repository-orient`；思考关闭（`allowedEfforts = [none]`，M1 原样） |
| UNIT | `repository-orient`、`repository-search`、`file-read`、`context-assemble`、`model-call`、`report-publish` | M1 实例的 `v1` 版本：契约改为 major 1 的版本，`failurePolicy` 去掉 `USER_DECLINED` |
| UNIT | `repository-list` | `executionKind = REPOSITORY_LIST`，受保护能力 `repo.read`，工具 `list-files` |
| UNIT | `message-publish` | `executionKind = MESSAGE_PUBLISH`，Kernel 内建，无工具 |
| TOOL | `read-file`、`search-repository`、`finish-analysis`、`handoff-to-code-viewer` | M1 内容的 `v1` 版本 |
| TOOL | `list-files` | `purpose = UNIT`，参数为 `executor.RepositoryListInput` |
| TOOL | `reply` | `purpose = CONTROL`，参数为 `workflow.ReplyArgs`（`{ text }`，1..20000 个字符）；`answer: true`：这个工具就是给使用者的答案，模型一开始写它，控制台就显示"正在输出回答" |
| UNIT | `run-command`、`git-inspect` | `executionKind` 分别为 `COMMAND`（受保护能力 `command.exec`）、`GIT_INSPECT`（`repo.read`） |
| TOOL | `run-command`、`git-inspect` | `purpose = UNIT`，参数为 `executor.RunCommandArgs`、`executor.GitInspectInput` |
| UNIT | `web-search`、`web-fetch` | `executionKind` 分别为 `WEB_SEARCH`（`web.search`）、`WEB_FETCH`（`web.fetch`） |
| TOOL | `web-search`、`web-fetch` | `purpose = UNIT`，参数为 `executor.WebSearchInput`、`executor.WebFetchInput` |
| UNIT | `external-list`、`external-read`、`external-search` | 读工作区之外的文件（Kernel/Core 第 5h 节）：沿用 `REPOSITORY_LIST`、`FILE_READ`、`REPOSITORY_SEARCH` 的 Executor，受保护能力 `external.read`（代替 `repo.read`，只有这三种 `executionKind` 可以声明它，也不能与 `repo.read` 同时声明）；只有 main 带它们 |
| TOOL | `list-external-files`、`read-external-file`、`search-external-repository` | `purpose = UNIT`，模型看到的名字是 `list_external_files`、`read_external_file`、`search_external_repository`；参数与 `list-files`、`read-file`、`search-repository` 相同（`executor.RepositoryListInput`、`executor.FileReadInput`、`context.RepositorySearchInput`），`path` 必须是绝对路径，描述里写明两种写法（Linux 路径与带盘符的 Windows 路径）和"不要猜路径" |
| PROMPT | `main-system` | main 的系统提示词（`FINAL`，见下） |
| PROMPT | `planner-system`、`code-viewer-system` | M1 内容的 `v1` 版本 |
| UNIT | `file-write`、`file-edit`、`output-read` | `executionKind` 分别为 `FILE_WRITE`、`FILE_EDIT`、`OUTPUT_READ`；前两个的受保护能力为 `workspace.write`，并且 `failurePolicy` 把写入的拒绝原因交回模型 |
| TOOL | `write-file`、`edit-file`、`read-output` | `purpose = UNIT`，参数为 `executor.FileWriteArgs`、`FileEditArgs`、`OutputReadArgs` |
| TOOL | `update-todos` | `purpose = CONTROL`，参数为 `workflow.UpdateTodosArgs`；由 main 的 `actions.todos` 引用 |
| AGENT | `explorer`、`worker` | 可被 `run_subagents` 派生：explorer 只读（`repo.read`，强度 `none`、`low`），缺省份额 300,000，20 轮、60 个工具 Unit、10 分钟；worker 增加 `workspace.write` 与 `command.exec`（不联网），强度 `low`–`max`，缺省份额 600,000，30 轮、120 个工具 Unit、20 分钟，另有 `update_todos`。结束工具各自的 `finish_subagent`（参数 `workflow.ExplorerResult`、`WorkerResult`，`FINISH_SUBAGENT`），降级时 `RETURN_PARTIAL`；没有发布 Unit。额度参数使最小份额低于缺省份额（explorer 228,000，worker 396,000） |
| TOOL | `run-subagents`、`finish-explorer`、`finish-worker` | `purpose = CONTROL`；参数为 `workflow.RunSubagentsArgs`、`ExplorerResult`、`WorkerResult`；两个结束工具在模型看来都叫 `finish_subagent`，各 Agent 只带自己的那一个。`run_subagents` 立即返回（Orchestration D14），任务的 `agent` 可以是 `explorer`、`worker` 或 `lead` |
| TOOL | `ask-user` | `purpose = CONTROL`，参数为 `workflow.AskUserArgs`；由 main 与 worker 的 `actions.askUser` 引用，explorer 没有；与 `run_subagents` 同样只能单独出现 |
| PROMPT | `explorer-system`、`worker-system` | SubAgent 的系统提示词；main 的提示词增加 `run_subagents` 的用法与派生准则（M2Design 第 3.9 节） |
| AGENT | `lead` | 组长（[Orchestration](../Orchestration.md) 第 9.4 节）：worker 的能力加上 `agent.spawn`，可被派生，也能派生自己的子任务（受任务深度限制，最深一层的 lead 不带 `run_subagents`）；结束工具 `finish-worker`；缺省份额 1,200,000，40 轮、160 个工具 Unit、60 分钟 |
| PROMPT | `lead-system` | lead 的系统提示词：先写方案与接口约定，再按不相交的写入范围派生，休眠等子任务，用消息通知兄弟任务，最后统一验证 |
| TOOL | `sleep` | `purpose = CONTROL`，参数为 `workflow.SleepArgs`；由 main、lead、worker、explorer 的 `actions.sleep` 引用：结束当前段，任务休眠到条件满足（Orchestration 第 4 节）；只能单独出现 |
| TOOL | `view-tasks` | `purpose = CONTROL`，参数为 `workflow.ViewTasksArgs`；main、lead、worker、explorer 的 `actions.viewTasks`：此刻的任务树（Orchestration 第 3.7 节） |
| TOOL | `job-output`、`job-list`、`job-kill` | `purpose = CONTROL`，参数为 `workflow.JobOutputArgs`、`JobListArgs`、`JobKillArgs`；main、lead、worker 的 `actions.jobOutput`、`jobList`、`jobKill`，只在能跑命令时提供：读取、列出、停止任务的后台命令（Orchestration 第 6 节）；当场答复，可以与普通工具同在一次返回中（Orchestration 第 5.3 节） |
| TOOL | `stop-subagents` | `purpose = CONTROL`，参数为 `workflow.StopSubagentsArgs`；只有能派生的 main 与 lead 带（`actions.stop`）：停止自己的子任务（第 5.1 节） |
| TOOL | `send-message` | `purpose = CONTROL`，参数为 `workflow.SendMessageArgs`；由同样四个 Agent 的 `actions.message` 引用：沿任务树发消息（Orchestration 第 5 节）；当场答复，可以与普通工具同在一次返回中，长正文按消息编号用 `read_output` 读全文（第 5.3 节） |
| MODEL | `deepseek-flash` | 增加 `ThinkingFeature`；取值来自实测 |
| TEMPLATE | `analyze` | Interface/Definitions 第 4 节 |
| TEMPLATE | `acceptance`、`integrate` | 预编排模板（Orchestration 第 3.9 节，2026-11-14）：`acceptance` 由不参与开发的任务只依据规格写验收测试并对系统运行，失败按负责部分归类；`integrate` 启动整个系统、跑整体检查、把失败追到所在部分、在那里修复后整体复查。每个模板带多个例子 |

- **main 的提示词**在写入能力完成后定稿（Cary 2026-11-04 决定），`contentStatus` 为 `FINAL`，以 `run-main-write.ts` 在真实模型上验证。之后给 main 增加工具时，只增加对应工具的用法。
- 草稿（`v0.x`）到 M2 发布时一起封存为 `v1.0.0`：提示词与工具还要按评测迭代（M2ReleasePlan），现在封存只会多出中间版本。
- main 的额度参数（Interface/Definitions 第 2 节）按模型窗口取值（M2Design 第 9.3 节）：`perCallInputLimit = 880000`、`maxOutputTokens = 64000`、
  `finalInputBudget = 880000`、`finalMaxOutputTokens = 64000`；`limits` 为 `maxRounds = 80`、`maxToolCallsPerRound = 8`、`maxToolUnits = 200`。
- main 的工具集随能力增加（写入、`read_output`、`update_todos`、命令与 `git_inspect`、`run_subagents`、网页）；每次改动都发布 main 的新版本。

## 3a. `run_subagents` 的校验

- Agent 的 `capabilities` 含 `agent.spawn` 当且仅当声明了 `actions.spawn`，后者须是参数为 `RunSubagentsArgs` 的 CONTROL 工具；
- 结束动作含 `FINISH_SUBAGENT` 当且仅当声明了 `spawnable`；这样的 Agent 不得含 `agent.spawn`，结束动作只有 `FINISH_SUBAGENT`，`onDegraded` 为 `RETURN_PARTIAL`（此时不需要发布 Unit），`defaultShare` 不低于 `agentMinShare(budget)`（`finalInputBudget + finalMaxOutputTokens + 2 × (perCallInputLimit + maxOutputTokens)`，与 Kernel/Monitor 的最小份额是同一个函数）；
- `pinAgent` 把 `actions.spawn` 的工具一并固定，工具名冲突检查也包括它。

## 4. 加载校验

M1 的校验规则全部保留（M1 AgentToolPool 第 5 节）。`v1` 增加：

| 对象 | 规则 |
|---|---|
| Agent `v1` | `thinking.allowedEfforts` 包含 `defaultEffort`；模型不支持思考时只能为 `['none']`；每一档在模型的 `effortMapping` 中都有映射 |
| Agent `v1` | `actions.end` 的每个 `toolRef` 指向 `purpose = CONTROL` 的工具，且互不相同；参数契约按 `then`：`PUBLISH_REPLY` 为 `workflow.ReplyArgs`，`PUBLISH_REPORT` 为 `workflow.AnalysisReportDraft`，`HANDOFF` 为 `workflow.HandoffBrief` |
| Agent `v1` | `unitRefs` 中 `CONTEXT_ASSEMBLE`、`MODEL` 各恰好一个；有 `PUBLISH_REPLY` 或 `onDegraded = PUBLISH_NOTICE` 时恰好一个 `MESSAGE_PUBLISH`，否则没有；有 `PUBLISH_REPORT` 或 `onDegraded = PUBLISH_REPORT` 时恰好一个 `REPORT_PUBLISH`，否则没有；`startUnitRefs` 只能是本 Agent 的 `REPOSITORY_ORIENT`；工具的模型名称不重复 |
| Agent `v1` | 额度参数为正安全整数；`maxToolUnits` 在 1..1000 |
| Unit `v1` | 声明 `repo.read` 当且仅当执行类型读取仓库（`REPOSITORY_ORIENT`、`REPOSITORY_SEARCH`、`FILE_READ`、`REPOSITORY_LIST`）：Kernel 只按声明的能力判断是否需要 Lease，这条规则保证声明与执行类型一致；`MESSAGE_PUBLISH` 不得声明受保护能力、不得带工具；`failurePolicy` 不得列出 `USER_DECLINED`、`QUOTA_EXHAUSTED`：它们的处理是 Workflow 的固定规则（Module/Workflow 第 7 节） |
| Model `v1` | `effortMapping` 恰好覆盖四档，每档一项 |
| Template | 节点名唯一；`agent` 只能引用内置 Agent；依赖存在且无环；条件边只出现在 `origin = BUILTIN` 的模板中；`inputFrom: HANDOFF` 的节点必须以条件边依赖一个结束动作含 `HANDOFF` 的 Agent 节点（交接的目标由模板决定，Agent 定义中没有目标） |
| Tool `v1` | 可选的 `answer`（布尔）标明这个工具就是给使用者的答案（只用来让控制台显示"正在输出回答"，不影响任何校验和执行）；`parametersContract` 等于 Unit 的 `inputContract`；`file-write`、`file-edit`、`output-read` 例外，分别为 `executor.FileWriteArgs`、`executor.FileEditArgs`、`executor.OutputReadArgs`：`baseSha`、`expectAbsent`、`fullRef` 由 Workflow 填写，模型看不到 |
| 引用 | `v1` 定义只引用 `v1` 定义；已封存的版本只引用已封存的版本 |
| Unit `v1` | 输入与输出契约按执行类型固定为 major 1 的版本（例如 `model-call` 为 `executor.ModelCallInput.v1`） |

跨配置校验（组合根）：每个可登记 Agent 的额度参数通过 Monitor 的启动检查（[Kernel/Monitor](../Kernel/Monitor.md) 第 6 节）。

## 5. 查找与运行固定

- `getDefinition` 增加 `kind = 'TEMPLATE'`；`pinAgent` 对 `v1` Agent 返回同样结构的 `PinnedDefinitionSet`（字段见 Interface/Definitions）。
- Workflow 在 AGENT 节点登记前调用 `pinAgent`；Core 在 `registerAgentRun` 时同样固定并比较 digest（M1 原样）。
- 模板在运行开始时由 Workflow 查找并固定；固定后的模板与 `GRAPH_EXTENDED` 一起记入日志（模板 ID、版本、digest），重放时不再查找。

## 5a. 模型数据与价目

`deepseek-flash` 与 `deepseek-v4-pro` 的 `pricing`（缓存命中、缓存未命中、输出的非高峰价格，高峰的倍率、星期与时段）沿用 M1 填写的数值与来源（归档的 [M1 AgentToolPool](../../History/M1/Library/AgentToolPool.md) 第 7 节），价格变动时发布新的 ModelDefinition 版本。

- 费用由 `modelCallCost(model, usage, at)` 计算：缓存命中按命中价，其余输入按未命中价，没有缓存数字时全部按未命中计（上限）；`at` 落在高峰时段时乘 `ratePercent / 100`。结果以微美元为单位。
- 额度按这个价格折算缓存命中的输入（M2Design 7.3）；评测体系用它给每次运行与每次压缩的摘要请求计价（[Evaluation](../Evaluation.md)）。
- 节假日按非高峰计费而没有节假日日历，所以节假日的成本是上限。

## 6. 测试

M1 的测试全部保留。增加：`v1` 各条规则的反例；`v0` 与 `v1` 定义并存时的加载与固定；`analyze` 模板的加载与校验；
仓库内定义恰好是第 3 节与 M1 的文件且全部有效。
